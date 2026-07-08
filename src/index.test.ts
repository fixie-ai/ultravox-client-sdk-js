import { DisconnectReason, RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  Medium,
  Role,
  TextMessagePlacement,
  TextMessageUrgency,
  Transcript,
  UltravoxDataMessageEvent,
  UltravoxErrorEvent,
  UltravoxSession,
  UltravoxSessionStatus,
} from './index.js';

const { FakeRoom, micTracks, micGate } = vi.hoisted(() => {
  const micTracks: Array<{ stopped: boolean; muted: boolean; stop: () => void; mediaStreamTrack: object }> = [];
  /** When set, createLocalAudioTrack blocks on this, like a pending mic permission prompt. */
  const micGate: { current?: Promise<void> } = {};
  /** In-memory stand-in for a livekit-client Room. State strings match livekit's ConnectionState. */
  class FakeRoom {
    static instances: FakeRoom[] = [];

    state = 'disconnected';
    connectOptions: any;
    publishedData: Array<{ payload: Uint8Array; opts: any }> = [];
    localParticipant = {
      publishTrack: async () => {},
      publishData: (payload: Uint8Array, opts: any) => this.publishedData.push({ payload, opts }),
    };
    remoteParticipants = new Map();
    private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();

    constructor() {
      FakeRoom.instances.push(this);
    }

    on(event: string, callback: (...args: any[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) || []), callback]);
      return this;
    }

    emit(event: string, ...args: any[]) {
      (this.handlers.get(event) || []).forEach((callback) => callback(...args));
    }

    async connect(_url: string, _token: string, options?: any) {
      this.connectOptions = options;
      this.state = 'connected';
    }

    async disconnect() {
      if (this.state === 'disconnected') {
        return;
      }
      this.state = 'disconnected';
      this.emit('disconnected', 1); // DisconnectReason.CLIENT_INITIATED, mirroring the real Room.
    }
  }
  return { FakeRoom, micTracks, micGate };
});

vi.mock('livekit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('livekit-client')>()),
  Room: FakeRoom,
  createLocalAudioTrack: async () => {
    await micGate.current;
    const track = {
      stopped: false,
      muted: false,
      setAudioContext: () => {},
      mute: () => {
        track.muted = true;
      },
      unmute: () => {
        track.muted = false;
      },
      stop: () => {
        track.stopped = true;
      },
      mediaStreamTrack: {},
    };
    micTracks.push(track);
    return track;
  },
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { wasClean: boolean; code: number; reason: string }) => void) | null = null;
  closed = false;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeRoom.instances = [];
  FakeWebSocket.instances = [];
  micTracks.length = 0;
  micGate.current = undefined;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'Audio',
    class {
      srcObject: unknown = null;
      play() {}
      pause() {}
    },
  );
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Creates a session and drives it through the join handshake, capturing emitted events. */
async function joinCall(sessionOptions: ConstructorParameters<typeof UltravoxSession>[0] = {}) {
  const sourceNodes: Array<{ stream: { tracks: unknown[] }; disconnected: boolean }> = [];
  const audioContext = {
    resume: () => {},
    createMediaStreamSource: (stream: { tracks: unknown[] }) => {
      const node = {
        stream,
        disconnected: false,
        disconnect: () => {
          node.disconnected = true;
        },
      };
      sourceNodes.push(node);
      return node;
    },
  } as unknown as AudioContext;
  const session = new UltravoxSession({ audioContext, ...sessionOptions });
  const errors: Error[] = [];
  const statuses: UltravoxSessionStatus[] = [];
  session.addEventListener('error', (event) => errors.push((event as UltravoxErrorEvent).error));
  session.addEventListener('status', () => statuses.push(session.status));
  session.joinCall('wss://example.test/join');
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  socket.onmessage!({ data: JSON.stringify({ roomUrl: 'wss://room.example.test', token: 'token' }) });
  await vi.waitFor(() => expect(FakeRoom.instances[FakeRoom.instances.length - 1]?.state).toBe('connected'));
  const room = FakeRoom.instances[FakeRoom.instances.length - 1]!;
  return { session, socket, room, errors, statuses, sourceNodes };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Delivers a data message to the session as if the server had sent it over the room's data channel. */
function receiveDataMessage(room: InstanceType<typeof FakeRoom>, message: object) {
  room.emit(RoomEvent.DataReceived, textEncoder.encode(JSON.stringify(message)));
}

/** Returns all data messages the session has published to the room, decoded. */
function publishedMessages(room: InstanceType<typeof FakeRoom>): any[] {
  return room.publishedData.map((entry) => JSON.parse(textDecoder.decode(entry.payload)));
}

/** Like joinCall, but also brings the session to the LISTENING status. */
async function joinConnectedCall() {
  const call = await joinCall();
  receiveDataMessage(call.room, { type: 'state', state: 'listening' });
  return call;
}

test('passes rtcConfig through to the room connection', async () => {
  const rtcConfig: RTCConfiguration = { iceTransportPolicy: 'relay' };
  const { room } = await joinCall({ rtcConfig });
  expect(room.connectOptions).toEqual({ rtcConfig });
});

test('disconnects without an error when the server hangs up (normal socket close)', async () => {
  const { session, socket, errors, statuses } = await joinCall();
  socket.onclose!({ wasClean: true, code: 1000, reason: '' });
  await vi.waitFor(() => expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED));
  expect(errors).toEqual([]);
  expect(statuses).toEqual([
    UltravoxSessionStatus.CONNECTING,
    UltravoxSessionStatus.DISCONNECTING,
    UltravoxSessionStatus.DISCONNECTED,
  ]);
});

test('disconnects without an error when the user leaves the call', async () => {
  const { session, socket, errors, statuses } = await joinCall();
  await session.leaveCall();
  socket.onclose!({ wasClean: true, code: 1000, reason: '' }); // The closed socket's event still fires.
  expect(errors).toEqual([]);
  expect(statuses).toEqual([
    UltravoxSessionStatus.CONNECTING,
    UltravoxSessionStatus.DISCONNECTING,
    UltravoxSessionStatus.DISCONNECTED,
  ]);
});

test('emits an error when the socket closes abnormally', async () => {
  const { session, socket, errors } = await joinCall();
  socket.onclose!({ wasClean: false, code: 1006, reason: '' });
  await vi.waitFor(() => expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED));
  expect(errors.map((error) => error.message)).toEqual([expect.stringContaining('code=1006')]);
});

test('emits an error when the socket closes normally during a media reconnect', async () => {
  const { session, socket, room, errors } = await joinCall();
  room.state = 'reconnecting';
  socket.onclose!({ wasClean: true, code: 1000, reason: '' });
  await vi.waitFor(() => expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED));
  expect(errors.map((error) => error.message)).toEqual(['Call ended due to unstable media connection']);
});

test('stops the mic track when the call ends while awaiting mic permission', async () => {
  let grantMicPermission!: () => void;
  micGate.current = new Promise<void>((resolve) => (grantMicPermission = resolve));
  const { session, socket } = await joinCall();
  socket.onclose!({ wasClean: true, code: 1000, reason: '' });
  await vi.waitFor(() => expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED));
  grantMicPermission();
  await vi.waitFor(() => expect(micTracks.map((track) => track.stopped)).toEqual([true]));
});

test('leaveCall resolves only after an in-flight disconnect completes', async () => {
  const { session, socket, room } = await joinCall();
  let releaseRoomDisconnect!: () => void;
  room.disconnect = () => new Promise<void>((resolve) => (releaseRoomDisconnect = resolve));
  socket.onclose!({ wasClean: true, code: 1000, reason: '' }); // Starts a teardown that blocks on the room.
  expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTING);
  let left = false;
  const leavePromise = session.leaveCall().then(() => (left = true));
  await new Promise((resolve) => setTimeout(resolve));
  expect(left).toBe(false);
  releaseRoomDisconnect();
  await leavePromise;
  expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED);
});

test.each([
  { reason: undefined, expected: 'reconnect attempts exhausted' },
  { reason: DisconnectReason.SIGNAL_CLOSE, expected: 'SIGNAL_CLOSE' },
  { reason: 999 as DisconnectReason, expected: '999' }, // An enum value this client doesn't know.
])('emits a single error when the media connection is lost ($expected)', async ({ reason, expected }) => {
  const { session, socket, room, errors } = await joinCall();
  room.emit(RoomEvent.Disconnected, reason);
  await vi.waitFor(() => expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED));
  socket.onclose!({ wasClean: false, code: 1006, reason: '' }); // The socket death that follows is not a second error.
  expect(errors.map((error) => error.message)).toEqual([expect.stringContaining(expected)]);
});

test('reaches DISCONNECTED even when media teardown fails', async () => {
  const { session, room } = await joinCall();
  await vi.waitFor(() => expect(micTracks).toHaveLength(1));
  micTracks[0]!.stop = () => {
    throw new Error('stop failed');
  };
  room.disconnect = async () => {
    throw new Error('disconnect failed');
  };
  await session.leaveCall();
  expect(session.status).toBe(UltravoxSessionStatus.DISCONNECTED);
});

test('joinCall throws while already in a call', async () => {
  const { session } = await joinCall();
  expect(() => session.joinCall('wss://example.test/join2')).toThrow('Cannot join a new call');
});

test.each([
  {
    urgency: TextMessageUrgency.IMMEDIATE,
    placement: TextMessagePlacement.PREVIOUS_PAUSE,
    expected: { urgency: 'immediate', placement: 'previous_pause' },
  },
  {
    urgency: TextMessageUrgency.SOON,
    placement: TextMessagePlacement.BEFORE,
    expected: { urgency: 'soon', placement: 'before' },
  },
])('sendText sends a user_text_message with urgency $expected.urgency', async ({ urgency, placement, expected }) => {
  const { session, room } = await joinConnectedCall();
  session.sendText('Hello', { urgency, placement });
  expect(publishedMessages(room)).toEqual([{ type: 'user_text_message', text: 'Hello', ...expected }]);
  expect(room.publishedData.map((entry) => entry.opts)).toEqual([{ reliable: true }]);
});

test('sendText defers urgency and placement to server defaults when omitted', async () => {
  const { session, room } = await joinConnectedCall();
  session.sendText('Hello');
  expect(publishedMessages(room)).toEqual([{ type: 'user_text_message', text: 'Hello' }]);
});

test.each([
  { deferResponse: true, urgency: 'later' },
  { deferResponse: false, urgency: 'immediate' },
])('sendText maps deprecated deferResponse=$deferResponse to urgency $urgency', async ({ deferResponse, urgency }) => {
  const { session, room } = await joinConnectedCall();
  session.sendText('Hello', deferResponse);
  expect(publishedMessages(room)).toEqual([{ type: 'user_text_message', text: 'Hello', urgency }]);
});

test('sendText throws while not connected', async () => {
  const { session } = await joinCall(); // No state message has arrived, so the session is still CONNECTING.
  expect(() => session.sendText('Hello')).toThrow('Cannot send text');
});

test('setOutputMedium sends a set_output_medium message', async () => {
  const { session, room } = await joinConnectedCall();
  session.setOutputMedium(Medium.TEXT);
  expect(publishedMessages(room)).toEqual([{ type: 'set_output_medium', medium: 'text' }]);
});

test('sendData routes messages over 1KB via the socket', async () => {
  const { session, room, socket } = await joinConnectedCall();
  const message = { type: 'user_text_message', text: 'a'.repeat(2000) };
  session.sendData(message);
  expect(publishedMessages(room)).toEqual([]);
  expect(socket.sent.map((sent) => JSON.parse(sent))).toEqual([message]);
});

test('sendData requires a type field', async () => {
  const { session } = await joinConnectedCall();
  expect(() => session.sendData({ text: 'Hello' })).toThrow('type');
});

test.each([
  { name: 'small (room-bound)', message: { type: 'ping', timestamp: 1 } },
  { name: 'large (socket-bound)', message: { type: 'user_text_message', text: 'a'.repeat(2000) } },
])('sendData warns and drops $name messages after the call ends', async ({ message }) => {
  const { session, socket, room } = await joinConnectedCall();
  await session.leaveCall();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  session.sendData(message);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(publishedMessages(room)).toEqual([]);
  expect(socket.sent).toEqual([]);
});

test('sendData warns and drops messages before the room exists, regardless of message size', async () => {
  const session = new UltravoxSession({ audioContext: {} as AudioContext });
  session.joinCall('wss://example.test/join'); // The socket exists now, but room_info hasn't arrived.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  session.sendData({ type: 'user_text_message', text: 'a'.repeat(2000) });
  session.sendData({ type: 'ping', timestamp: 1 });
  expect(warn).toHaveBeenCalledTimes(2);
  expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.sent).toEqual([]);
});

test('handles data messages arriving over the socket', async () => {
  const { session, socket } = await joinCall();
  socket.onmessage!({ data: JSON.stringify({ type: 'state', state: 'listening' }) });
  expect(session.status).toBe(UltravoxSessionStatus.LISTENING);
  expect(FakeRoom.instances).toHaveLength(1); // The message must not be treated as a second room_info.
});

test('state messages update the session status', async () => {
  const { session, room, statuses } = await joinCall();
  receiveDataMessage(room, { type: 'state', state: 'thinking' });
  expect(session.status).toBe(UltravoxSessionStatus.THINKING);
  expect(statuses).toEqual([UltravoxSessionStatus.CONNECTING, UltravoxSessionStatus.THINKING]);
});

test('transcript messages build the session transcripts', async () => {
  const { session, room } = await joinConnectedCall();
  let transcriptsEvents = 0;
  session.addEventListener('transcripts', () => transcriptsEvents++);
  const agentMessage = { type: 'transcript', role: 'agent', medium: 'voice', ordinal: 0, final: false };
  receiveDataMessage(room, { ...agentMessage, delta: 'Hel' });
  receiveDataMessage(room, { ...agentMessage, delta: 'lo' });
  expect(session.transcripts).toEqual([new Transcript('Hello', false, Role.AGENT, Medium.VOICE, 0)]);
  receiveDataMessage(room, { ...agentMessage, final: true, text: 'Hello!' });
  receiveDataMessage(room, { type: 'transcript', role: 'user', medium: 'text', ordinal: 1, final: true, text: 'Hi' });
  expect(session.transcripts).toEqual([
    new Transcript('Hello!', true, Role.AGENT, Medium.VOICE, 0),
    new Transcript('Hi', true, Role.USER, Medium.TEXT, 1),
  ]);
  expect(transcriptsEvents).toBe(4);
});

test('data_message events allow suppressing default handling', async () => {
  const { session, room } = await joinConnectedCall();
  const messages: any[] = [];
  session.addEventListener('data_message', (event) => {
    const dataMessageEvent = event as UltravoxDataMessageEvent;
    messages.push(dataMessageEvent.message);
    dataMessageEvent.preventDefault();
  });
  receiveDataMessage(room, { type: 'state', state: 'speaking' });
  expect(messages).toEqual([{ type: 'state', state: 'speaking' }]);
  expect(session.status).toBe(UltravoxSessionStatus.LISTENING); // Unchanged because default handling was suppressed.
});

test.each([
  { name: 'a string result', result: 'ok', expected: { result: 'ok' } },
  {
    name: 'an object result',
    result: { result: 'ok', responseType: 'hang-up', agentReaction: 'listens' },
    expected: { result: 'ok', responseType: 'hang-up', agentReaction: 'listens' },
  },
  {
    name: 'an invalid result',
    result: 42,
    expected: { errorType: 'implementation-error', errorMessage: expect.stringContaining('must be a string') },
  },
])('client tool invocations send a client_tool_result for $name', async ({ result, expected }) => {
  const { room, session } = await joinConnectedCall();
  const invocations: any[] = [];
  session.registerToolImplementation('myTool', (async (parameters: any) => {
    invocations.push(parameters);
    return result;
  }) as any);
  receiveDataMessage(room, {
    type: 'client_tool_invocation',
    toolName: 'myTool',
    invocationId: 'call_1',
    parameters: { a: 1 },
  });
  await vi.waitFor(() =>
    expect(publishedMessages(room)).toEqual([{ type: 'client_tool_result', invocationId: 'call_1', ...expected }]),
  );
  expect(invocations).toEqual([{ a: 1 }]);
});

test('client tool errors send an implementation-error result', async () => {
  const { room, session } = await joinConnectedCall();
  session.registerToolImplementation('myTool', () => {
    throw new Error('boom');
  });
  receiveDataMessage(room, {
    type: 'client_tool_invocation',
    toolName: 'myTool',
    invocationId: 'call_1',
    parameters: {},
  });
  await vi.waitFor(() =>
    expect(publishedMessages(room)).toEqual([
      { type: 'client_tool_result', invocationId: 'call_1', errorType: 'implementation-error', errorMessage: 'boom' },
    ]),
  );
});

test('unregistered client tools send an undefined-error result', async () => {
  const { room } = await joinConnectedCall();
  receiveDataMessage(room, {
    type: 'client_tool_invocation',
    toolName: 'nope',
    invocationId: 'call_1',
    parameters: {},
  });
  expect(publishedMessages(room)).toEqual([
    {
      type: 'client_tool_result',
      invocationId: 'call_1',
      errorType: 'undefined',
      errorMessage: expect.stringContaining('not registered'),
    },
  ]);
});

test('client tool results after the call ends are dropped without throwing', async () => {
  const { room, session } = await joinConnectedCall();
  let finishTool!: (result: string) => void;
  session.registerToolImplementation('myTool', () => new Promise<string>((resolve) => (finishTool = resolve)));
  receiveDataMessage(room, {
    type: 'client_tool_invocation',
    toolName: 'myTool',
    invocationId: 'call_1',
    parameters: {},
  });
  await session.leaveCall();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  finishTool('ok');
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
});

test('mic mute is applied to the mic track', async () => {
  const { session } = await joinCall();
  await vi.waitFor(() => expect(micTracks).toHaveLength(1));
  session.muteMic();
  expect([session.isMicMuted, micTracks[0]!.muted]).toEqual([true, true]);
  session.toggleMicMute();
  expect([session.isMicMuted, micTracks[0]!.muted]).toEqual([false, false]);
});

test('muting before the mic track exists applies once it is created', async () => {
  let grantMicPermission!: () => void;
  micGate.current = new Promise<void>((resolve) => (grantMicPermission = resolve));
  const { session } = await joinCall();
  session.muteMic();
  grantMicPermission();
  await vi.waitFor(() => expect(micTracks.map((track) => track.muted)).toEqual([true]));
});

test('speaker mute disables remote audio publications', async () => {
  const { session, room } = await joinConnectedCall();
  const enabledChanges: boolean[] = [];
  const publication = { setEnabled: (value: boolean) => enabledChanges.push(value) };
  room.remoteParticipants.set('agent', { audioTrackPublications: new Map([['pub', publication]]) });
  session.muteSpeaker();
  expect(session.isSpeakerMuted).toBe(true);
  session.unmuteSpeaker();
  expect(session.isSpeakerMuted).toBe(false);
  expect(enabledChanges).toEqual([false, true]);
});

test('exposes mic and agent audio source nodes while audio is flowing', async () => {
  const { session, room, sourceNodes } = await joinCall();
  expect(session.agentSourceNode).toBeUndefined();
  await vi.waitFor(() => expect(session.micSourceNode).toBeDefined());
  expect(session.micSourceNode).toBe(session.micSourceNode); // The node is stable across accesses.
  const agentTrack = { kind: 'audio', attach: () => {}, mediaStreamTrack: {} };
  room.emit(RoomEvent.TrackSubscribed, agentTrack, { kind: 'audio', setEnabled: () => {} });
  expect(session.agentSourceNode).toBeDefined();
  // Each node must be built from the corresponding track's stream.
  expect(sourceNodes.map((node) => node.stream.tracks)).toEqual([
    [micTracks[0]!.mediaStreamTrack],
    [agentTrack.mediaStreamTrack],
  ]);
  await session.leaveCall();
  expect([session.micSourceNode, session.agentSourceNode]).toEqual([undefined, undefined]);
  expect(sourceNodes.map((node) => node.disconnected)).toEqual([true, true]);
});

test('recreates the agent source node when a new agent track arrives (e.g. after a media reconnect)', async () => {
  const { session, room } = await joinCall();
  const subscribeAgentTrack = (track: object) =>
    room.emit(RoomEvent.TrackSubscribed, track, { kind: 'audio', setEnabled: () => {} });
  const firstTrack = { kind: 'audio', attach: () => {}, mediaStreamTrack: {} };
  subscribeAgentTrack(firstTrack);
  const firstNode = session.agentSourceNode;
  subscribeAgentTrack(firstTrack); // Resubscribing the same track must not invalidate the node.
  expect(session.agentSourceNode).toBe(firstNode);
  subscribeAgentTrack({ kind: 'audio', attach: () => {}, mediaStreamTrack: {} });
  expect(session.agentSourceNode).not.toBe(firstNode);
  expect((firstNode as any).disconnected).toBe(true);
});

test('tolerates blocked audio autoplay during join', async () => {
  vi.stubGlobal(
    'Audio',
    class {
      srcObject: unknown = null;
      play() {
        return Promise.reject(new Error('autoplay blocked'));
      }
      pause() {}
    },
  );
  const audioContext = { resume: () => Promise.reject(new Error('autoplay blocked')) } as unknown as AudioContext;
  const { session, room } = await joinCall({ audioContext });
  receiveDataMessage(room, { type: 'state', state: 'listening' });
  expect(session.status).toBe(UltravoxSessionStatus.LISTENING);
});

test('a session can be reused for a new call with fresh transcripts', async () => {
  const { session, room } = await joinConnectedCall();
  receiveDataMessage(room, { type: 'transcript', role: 'user', medium: 'text', ordinal: 0, final: true, text: 'Hi' });
  await session.leaveCall();
  session.joinCall('wss://example.test/join');
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  socket.onmessage!({ data: JSON.stringify({ roomUrl: 'wss://room.example.test', token: 'token' }) });
  await vi.waitFor(() => expect(FakeRoom.instances[FakeRoom.instances.length - 1]?.state).toBe('connected'));
  const secondRoom = FakeRoom.instances[FakeRoom.instances.length - 1]!;
  expect(session.transcripts).toEqual([]);
  receiveDataMessage(secondRoom, {
    type: 'transcript',
    role: 'agent',
    medium: 'voice',
    ordinal: 0,
    final: true,
    text: 'Hey',
  });
  expect(session.transcripts).toEqual([new Transcript('Hey', true, Role.AGENT, Medium.VOICE, 0)]);
});
