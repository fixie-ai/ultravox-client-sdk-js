import { DisconnectReason, RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { UltravoxErrorEvent, UltravoxSession, UltravoxSessionStatus } from './index.js';

const { FakeRoom, micTracks, micGate } = vi.hoisted(() => {
  const micTracks: Array<{ stopped: boolean }> = [];
  /** When set, createLocalAudioTrack blocks on this, like a pending mic permission prompt. */
  const micGate: { current?: Promise<void> } = {};
  /** In-memory stand-in for a livekit-client Room. State strings match livekit's ConnectionState. */
  class FakeRoom {
    static instances: FakeRoom[] = [];

    state = 'disconnected';
    connectOptions: any;
    localParticipant = { publishTrack: async () => {}, publishData: () => {} };
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
      setAudioContext: () => {},
      mute: () => {},
      unmute: () => {},
      stop: () => {
        track.stopped = true;
      },
      mediaStream: undefined,
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

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(_message: string) {}

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Creates a session and drives it through the join handshake, capturing emitted events. */
async function joinCall(sessionOptions: ConstructorParameters<typeof UltravoxSession>[0] = {}) {
  const audioContext = {
    resume: () => {},
    createMediaStreamSource: () => ({ disconnect: () => {} }),
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
  return { session, socket, room, errors, statuses };
}

test('passes rtcConfig through to the room connection', async () => {
  const rtcConfig: RTCConfiguration = { iceTransportPolicy: 'relay' };
  const { room } = await joinCall({ rtcConfig });
  expect(room.connectOptions).toEqual({ rtcConfig });
});

test('disconnects without an error when the socket closes normally', async () => {
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
