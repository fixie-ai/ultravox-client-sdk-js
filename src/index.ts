import {
  ConnectionState,
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  RemoteAudioTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import { ULTRAVOX_SDK_VERSION } from './version.js';

/* The current status of an UltravoxSession. */
export enum UltravoxSessionStatus {
  /* The session is not connected and not attempting to connect. This is the initial state. */
  DISCONNECTED = 'disconnected',
  /* The client is disconnecting from the session. */
  DISCONNECTING = 'disconnecting',
  /* The client is attempting to connect to the session. */
  CONNECTING = 'connecting',
  /* The server has disconnected from the call. */
  IDLE = 'idle',
  /* The client is connected and the server is listening for voice input. */
  LISTENING = 'listening',
  /* The client is connected and the server is considering its response. The user can still interrupt. */
  THINKING = 'thinking',
  /* The client is connected and the server is playing response audio. The user can interrupt as needed. */
  SPEAKING = 'speaking',
}

/* The participant responsible for an utterance. */
export enum Role {
  USER = 'user',
  AGENT = 'agent',
}

/* How a message was communicated. */
export enum Medium {
  VOICE = 'voice',
  TEXT = 'text',
}

/* How the agent should proceed after a tool invocation. */
export enum AgentReaction {
  /* The agent should speak after the tool invocation. This is the default and is recommended for tools that retrieve information for the agent to act on. */
  SPEAKS = 'speaks',
  /* The agent should listen after the tool invocation. This is recommended for tools the user is expected to act on, such as certain clear UI changes. */
  LISTENS = 'listens',
  /* The agent should speak after the tool invocation if and only if it did not speak immediately before the tool invocation. This is recommended for tools whose primary purpose is a side effect like recording information collected from the user. */
  SPEAKS_ONCE = 'speaks-once',
}

/** A transcription of a single utterance. */
export class Transcript {
  constructor(
    /* The possibly-incomplete text of an utterance. */
    readonly text: string,
    /* Whether the text is complete or the utterance is ongoing. */
    readonly isFinal: boolean,
    /* Who emitted the utterance. */
    readonly speaker: Role,
    /* The medium through which the utterance was emitted. */
    readonly medium: Medium,
    /* The ordinal for sorting the transcript */
    readonly ordinal: number,
  ) {}
}

/* Event emitted by an UltravoxSession when its status changes. */
export class UltravoxSessionStatusChangedEvent extends Event {
  constructor() {
    super('status');
  }
}

/* Event emitted by an UltravoxSession when its transcripts change. */
export class UltravoxTranscriptsChangedEvent extends Event {
  constructor() {
    super('transcripts');
  }
}

/**
 * Event emitted by an UltravoxSession when any data message is received, including those typically
 * handled by this SDK.
 *
 * See https://docs.ultravox.ai/datamessages for message types.
 */
export class UltravoxDataMessageEvent extends Event {
  constructor(readonly message: any) {
    super('data_message', { cancelable: true });
  }
}

export class UltravoxVideoTrackSubscribedEvent extends Event {
  constructor(readonly videoElement: HTMLVideoElement) {
    super('video_track_subscribed');
  }
}

/**
 * Event emitted by an UltravoxSession when the session ends unexpectedly, for example because
 * the network dropped the call's media connection. It is emitted immediately before the
 * session's final "status" events. No error event is emitted when a call ends normally.
 */
export class UltravoxErrorEvent extends Event {
  constructor(readonly error: Error) {
    super('error');
  }
}

type ClientToolReturnType =
  | string
  | {
      result: string;
      responseType: string;
      agentReaction?: AgentReaction | null;
      updateCallState?: Record<string, unknown> | null;
    };

export type ClientToolImplementation = (parameters: {
  [key: string]: any;
}) => ClientToolReturnType | Promise<ClientToolReturnType>;

/**
 * Manages a single session with Ultravox and emits events to notify consumers of
 * state changes. The following events are emitted:
 *
 * - status: The status of the session has changed.
 * - transcripts: A transcript was added or updated.
 * - experimental_message: An experimental message was received. The message is included in the event.
 *
 */
export class UltravoxSession extends EventTarget {
  private static CONNECTED_STATUSES = new Set([
    UltravoxSessionStatus.LISTENING,
    UltravoxSessionStatus.THINKING,
    UltravoxSessionStatus.SPEAKING,
  ]);

  private readonly _transcripts: Array<Transcript | null> = [];
  private _status: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;
  private readonly registeredTools: Map<string, ClientToolImplementation> = new Map();
  private socket?: WebSocket;
  private room?: Room;
  private videoElement?: HTMLVideoElement;
  private audioElement = new Audio();
  private localAudioTrack?: LocalAudioTrack;
  private micSourceNode?: MediaStreamAudioSourceNode;
  private readonly textDecoder = new TextDecoder();
  private readonly textEncoder = new TextEncoder();

  private readonly audioContext: AudioContext;
  private readonly additionalMessages: Set<string>;
  private readonly rtcConfig?: RTCConfiguration;

  private _isMicMuted: boolean = false;
  private _isSpeakerMuted: boolean = false;

  /**
   * Constructor for UltravoxSession.
   * @param audioContext An AudioContext to use for audio processing. If not provided, a new AudioContext will be created.
   * @param additionalMessages A set of additional message types to enable. Empty by default.
   * @param rtcConfig An RTCConfiguration applied to the call's WebRTC connections. For example,
   *     setting {iceTransportPolicy: 'relay'} forces media through a TURN relay (typically over
   *     TCP/TLS on port 443), which can help on networks that disrupt long-lived UDP flows.
   */
  constructor({
    audioContext,
    additionalMessages,
    videoElement,
    rtcConfig,
  }: {
    audioContext?: AudioContext;
    additionalMessages?: Set<string>;
    videoElement?: HTMLVideoElement;
    rtcConfig?: RTCConfiguration;
  } = {}) {
    super();
    this.audioContext = audioContext || new AudioContext();
    this.additionalMessages = additionalMessages || new Set();
    this.videoElement = videoElement;
    this.rtcConfig = rtcConfig;
  }

  /** Returns all transcripts for the current session. */
  get transcripts(): Transcript[] {
    return [...this._transcripts.filter((t) => t != null)] as Transcript[];
  }

  /** Returns the session's current status. */
  get status(): UltravoxSessionStatus {
    return this._status;
  }

  /**
   * Indicates whether the user's mic is currently muted for the session. (Does not inspect
   * hardware state.)
   */
  get isMicMuted(): boolean {
    return this._isMicMuted;
  }

  /**
   * Indicates whether the user's speaker (e.g. agent output audio) is currently muted for the
   * session. (Does not inspect system volume or hardware state.)
   */
  get isSpeakerMuted(): boolean {
    return this._isSpeakerMuted;
  }

  /**
   * Registers a client tool implementation with the given name. If the call is
   * started with a client-implemented tool, this implementation will be invoked
   * when the model calls the tool.
   *
   * See https://docs.ultravox.ai/tools for more information.
   */
  registerToolImplementation(name: string, implementation: ClientToolImplementation): void {
    this.registeredTools.set(name, implementation);
  }

  /** Convenience batch wrapper for registerToolImplementation. */
  registerToolImplementations(implementationMap: { [name: string]: ClientToolImplementation }): void {
    for (const [name, implementation] of Object.entries(implementationMap)) {
      this.registerToolImplementation(name, implementation);
    }
  }

  /** Connects to a call using the given joinUrl. */
  joinCall(joinUrl: string, clientVersion?: string): void {
    if (this._status !== UltravoxSessionStatus.DISCONNECTED) {
      throw new Error('Cannot join a new call while already in a call');
    }
    const url = new URL(joinUrl);
    let uvClientVersion = `web_${ULTRAVOX_SDK_VERSION}`;
    if (clientVersion) {
      uvClientVersion += `:${clientVersion}`;
    }
    url.searchParams.set('clientVersion', uvClientVersion);
    url.searchParams.set('apiVersion', '1');
    if (this.additionalMessages) {
      url.searchParams.set('additionalMessages', Array.from(this.additionalMessages.values()).join(','));
    }
    joinUrl = url.toString();
    this.setStatus(UltravoxSessionStatus.CONNECTING);
    this.socket = new WebSocket(joinUrl);
    this.socket.onmessage = (event) => this.handleSocketMessage(event);
    this.socket.onclose = (event) => this.handleSocketClose(event);
  }

  /** Leaves the current call (if any). */
  async leaveCall(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Sets the agent's output medium. If the agent is currently speaking, this will take effect at
   * the end of the agent's utterance. Also see muteSpeaker and unmuteSpeaker below.
   */
  setOutputMedium(medium: Medium) {
    if (!UltravoxSession.CONNECTED_STATUSES.has(this._status)) {
      throw new Error(`Cannot set output medium while not connected. Current status is ${this._status}.`);
    }
    this.sendData({ type: 'set_output_medium', medium });
  }

  /** Sends a message via text. */
  sendText(text: string, deferResponse?: boolean) {
    if (!UltravoxSession.CONNECTED_STATUSES.has(this._status)) {
      throw new Error(`Cannot send text while not connected. Current status is ${this._status}.`);
    }
    this.sendData({ type: 'input_text_message', text, deferResponse });
  }

  /* Sends an arbitrary data message to the server. See https://docs.ultravox.ai/datamessages for message types. */
  sendData(obj: any) {
    if (obj.type == undefined) {
      throw new Error('Data must have a type field');
    }
    const msgStr = JSON.stringify(obj);
    const msgBytes = this.textEncoder.encode(msgStr);
    if (msgBytes.length > 1024) {
      this.socket?.send(msgStr);
    } else {
      this.room?.localParticipant.publishData(msgBytes, { reliable: true });
    }
  }

  /** Mutes audio input from the user. */
  muteMic(): void {
    this._isMicMuted = true;
    this.localAudioTrack?.mute();
  }

  /** Unmutes audio input from the user. */
  unmuteMic(): void {
    this._isMicMuted = false;
    this.localAudioTrack?.unmute();
  }

  /** Toggles the mute state of the user's audio input. */
  toggleMicMute(): void {
    if (this.isMicMuted) {
      this.unmuteMic();
    } else {
      this.muteMic();
    }
  }

  /** Mutes audio output from the agent. */
  muteSpeaker(): void {
    this._isSpeakerMuted = true;
    this.room?.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => {
        publication.setEnabled(!this._isSpeakerMuted);
      });
    });
  }

  /** Unmutes audio output from the agent. */
  unmuteSpeaker(): void {
    this._isSpeakerMuted = false;
    this.room?.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => {
        publication.setEnabled(!this._isSpeakerMuted);
      });
    });
  }

  /** Toggles the mute state of the agent's output audio. */
  toggleSpeakerMute(): void {
    if (this.isSpeakerMuted) {
      this.unmuteSpeaker();
    } else {
      this.muteSpeaker();
    }
  }

  private async handleSocketMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data);
    this.room = new Room({ webAudioMix: false });
    this.room.on(RoomEvent.TrackSubscribed, (_track, publication) => {
      if (publication.kind == Track.Kind.Audio) {
        publication.setEnabled(!this.isSpeakerMuted);
      }
    });
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => this.handleTrackSubscribed(track));
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant: any) =>
      this.handleDataReceived(payload, participant),
    );
    this.room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.handleRoomDisconnected(reason));

    this.audioContext.resume();
    this.audioElement.play();

    const [track, _] = await Promise.all([
      createLocalAudioTrack(),
      this.room.connect(msg.roomUrl, msg.token, { rtcConfig: this.rtcConfig }),
    ]);
    this.localAudioTrack = track;
    this.localAudioTrack.setAudioContext(this.audioContext);
    if (this.isMicMuted) {
      this.localAudioTrack.mute();
    }

    if (this.isStopped()) {
      // We've been stopped while waiting for the mic permission (during createLocalTracks).
      return;
    }
    if (this.localAudioTrack.mediaStream) {
      this.micSourceNode = this.audioContext.createMediaStreamSource(this.localAudioTrack.mediaStream);
    }

    const opts = { name: 'audio', simulcast: false, source: Track.Source.Microphone };
    this.room.localParticipant.publishTrack(this.localAudioTrack, opts);
  }

  private async handleSocketClose(event: CloseEvent) {
    if (this.isStopped()) {
      return;
    }
    const socketClosedNormally = event.wasClean && (event.code === 1000 || event.code === 1005);
    const roomState = this.room?.state;
    if (!socketClosedNormally) {
      this.dispatchEvent(
        new UltravoxErrorEvent(
          new Error(`Session socket closed abnormally. code=${event.code} reason=${event.reason}`),
        ),
      );
    } else if (roomState === ConnectionState.Reconnecting || roomState === ConnectionState.SignalReconnecting) {
      // The server ended the call while we were trying to recover the call's media connection,
      // meaning the call was cut short by a network failure rather than ending normally.
      this.dispatchEvent(
        new UltravoxErrorEvent(new Error('Call ended while the media connection was attempting to reconnect')),
      );
    }
    await this.disconnect();
  }

  private async handleRoomDisconnected(reason?: DisconnectReason) {
    if (this.isStopped()) {
      return;
    }
    if (reason !== DisconnectReason.CLIENT_INITIATED) {
      // The server ends calls by closing our socket, not by closing the room, so a room disconnect
      // we didn't initiate means the media connection was lost. (An undefined reason means LiveKit
      // exhausted its internal reconnect attempts.) The call cannot continue without media, so we
      // surface the failure and hang up rather than leaving the session in a stale "live" state.
      const reasonName = reason === undefined ? 'reconnect attempts exhausted' : DisconnectReason[reason];
      this.dispatchEvent(new UltravoxErrorEvent(new Error(`Call media connection lost unexpectedly (${reasonName})`)));
    }
    await this.disconnect();
  }

  private isStopped(): boolean {
    return [UltravoxSessionStatus.DISCONNECTING, UltravoxSessionStatus.DISCONNECTED].includes(this._status);
  }

  private async disconnect() {
    if (this.isStopped()) {
      return;
    }
    this.setStatus(UltravoxSessionStatus.DISCONNECTING);
    this.localAudioTrack?.stop();
    this.localAudioTrack = undefined;
    await this.room?.disconnect();
    this.room = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.micSourceNode?.disconnect();
    this.micSourceNode = undefined;
    this.videoElement?.pause();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
    this.setStatus(UltravoxSessionStatus.DISCONNECTED);
  }

  private handleTrackSubscribed(track: RemoteTrack) {
    if (track.kind === 'video') {
      if (!this.videoElement) {
        this.videoElement = document.createElement('video');
      }
      track.attach(this.videoElement);
      this.dispatchEvent(new UltravoxVideoTrackSubscribedEvent(this.videoElement));
    } else if (track.kind === 'audio') {
      const audioTrack = track as RemoteAudioTrack;
      audioTrack.attach(this.audioElement);
    }
  }

  private setStatus(status: UltravoxSessionStatus) {
    if (this._status === status) {
      return;
    }
    this._status = status;
    this.dispatchEvent(new UltravoxSessionStatusChangedEvent());
  }

  private handleDataReceived(payload: Uint8Array, _participant: any) {
    const msg = JSON.parse(this.textDecoder.decode(payload));
    const runDefault = this.dispatchEvent(new UltravoxDataMessageEvent(msg));
    if (runDefault) {
      if (msg.type === 'state') {
        this.setStatus(msg.state);
      } else if (msg.type === 'transcript') {
        const medium = msg.medium == 'voice' ? Medium.VOICE : Medium.TEXT;
        const role = msg.role == 'agent' ? Role.AGENT : Role.USER;
        const ordinal = msg.ordinal;
        const isFinal = msg.final;
        if (msg.text) {
          this.addOrUpdateTranscript(ordinal, medium, role, isFinal, msg.text);
        } else if (msg.delta) {
          this.addOrUpdateTranscript(ordinal, medium, role, isFinal, undefined, msg.delta);
        }
      } else if (msg.type == 'client_tool_invocation') {
        this.invokeClientTool(msg.toolName, msg.invocationId, msg.parameters);
      }
    }
  }

  private addOrUpdateTranscript(
    ordinal: number,
    medium: Medium,
    speaker: Role,
    isFinal: boolean,
    text?: string,
    delta?: string,
  ) {
    while (this._transcripts.length < ordinal) {
      this._transcripts.push(null);
    }
    if (this._transcripts.length == ordinal) {
      this._transcripts.push(new Transcript(text || delta || '', isFinal, speaker, medium, ordinal));
    } else {
      const priorText = this._transcripts[ordinal]?.text || '';
      this._transcripts[ordinal] = new Transcript(text || priorText + (delta || ''), isFinal, speaker, medium, ordinal);
    }
    this.dispatchEvent(new UltravoxTranscriptsChangedEvent());
  }

  private invokeClientTool(toolName: string, invocationId: string, parameters: { [key: string]: any }) {
    const tool = this.registeredTools.get(toolName);
    if (!tool) {
      this.sendData({
        type: 'client_tool_result',
        invocationId,
        errorType: 'undefined',
        errorMessage: `Client tool ${toolName} is not registered (TypeScript client)`,
      });
      return;
    }

    try {
      const result = tool(parameters);
      if (result instanceof Promise) {
        result
          .then((result) => this.handleClientToolResult(invocationId, result))
          .catch((error) => this.handleClientToolFailure(invocationId, error));
      } else {
        this.handleClientToolResult(invocationId, result);
      }
    } catch (e) {
      this.handleClientToolFailure(invocationId, e);
    }
  }

  private handleClientToolResult(invocationId: string, result: any) {
    if (typeof result === 'string') {
      this.sendData({ type: 'client_tool_result', invocationId, result });
    } else if (typeof result.result !== 'string' || typeof result.responseType !== 'string') {
      this.sendData({
        type: 'client_tool_result',
        invocationId,
        errorType: 'implementation-error',
        errorMessage:
          'Client tool result must be a string or an object with string "result" and "responseType" properties.',
      });
    } else {
      this.sendData({
        type: 'client_tool_result',
        invocationId,
        ...result,
      });
    }
  }

  private handleClientToolFailure(invocationId: string, error: any) {
    this.sendData({
      type: 'client_tool_result',
      invocationId,
      errorType: 'implementation-error',
      errorMessage: error instanceof Error ? error.message : undefined,
    });
  }
}
