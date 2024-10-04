import {
  createLocalAudioTrack,
  LocalAudioTrack,
  RemoteAudioTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';

/* The current status of an UltravoxSession. */
export enum UltravoxSessionStatus {
  /* The session is not connected and not attempting to connect. This is the initial state. */
  DISCONNECTED = 'disconnected',
  /* The client is disconnecting from the session. */
  DISCONNECTING = 'disconnecting',
  /* The client is attempting to connect to the session. */
  CONNECTING = 'connecting',
  /* The client is connected to the session and the server is warming up. */
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

/* Event emitted by an UltravoxSession when an experimental message is received. */
export class UltravoxExperimentalMessageEvent extends Event {
  constructor(readonly message: any) {
    super('experimental_message');
  }
}

type ClientToolReturnType = string | { result: string; responseType: string };
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

  private readonly _transcripts: Transcript[] = [];
  private _status: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;
  private readonly registeredTools: Map<string, ClientToolImplementation> = new Map();
  private socket?: WebSocket;
  private room?: Room;
  private audioElement = new Audio();
  private localAudioTrack?: LocalAudioTrack;
  private micSourceNode?: MediaStreamAudioSourceNode;
  private agentSourceNode?: MediaStreamAudioSourceNode;
  private delayedSpeakingState = false;
  private readonly textDecoder = new TextDecoder();
  private readonly textEncoder = new TextEncoder();

  private readonly audioContext: AudioContext;
  private readonly experimentalMessages: Set<string>;

  private _isMicMuted: boolean = false;
  private _isSpeakerMuted: boolean = false;

  /**
   * Constructor for UltravoxSession.
   * @param audioContext An AudioContext to use for audio processing. If not provided, a new AudioContext will be created.
   * @param experimentalMessages A set of experimental message types to enable. Empty by default.
   */
  constructor({
    audioContext,
    experimentalMessages,
  }: {
    audioContext?: AudioContext;
    experimentalMessages?: Set<string>;
  } = {}) {
    super();
    this.audioContext = audioContext || new AudioContext();
    this.experimentalMessages = experimentalMessages || new Set();
  }

  /** Returns all transcripts for the current session. */
  get transcripts(): Transcript[] {
    return [...this._transcripts];
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
  joinCall(joinUrl: string): void {
    if (this._status !== UltravoxSessionStatus.DISCONNECTED) {
      throw new Error('Cannot join a new call while already in a call');
    }
    if (this.experimentalMessages) {
      const url = new URL(joinUrl);
      url.searchParams.set('experimentalMessages', Array.from(this.experimentalMessages.values()).join(','));
      joinUrl = url.toString();
    }
    this.setStatus(UltravoxSessionStatus.CONNECTING);
    this.socket = new WebSocket(joinUrl);
    this.socket.onmessage = (event) => this.handleSocketMessage(event);
    this.socket.onclose = (event) => this.handleSocketClose(event);
  }

  /** Leaves the current call (if any). */
  async leaveCall(): Promise<void> {
    await this.disconnect();
  }

  /** Sends a message via text. */
  sendText(text: string) {
    if (!UltravoxSession.CONNECTED_STATUSES.has(this._status)) {
      throw new Error(`Cannot send text while not connected. Current status is ${this._status}.`);
    }
    this.sendData({ type: 'input_text_message', text });
  }

  /** Mutes audio input from the user. */
  muteMic(): void {
    if (!this.room?.localParticipant) {
      throw new Error('Cannot muteMic.');
    }
    this._isMicMuted = true;
    this.room.localParticipant.setMicrophoneEnabled(false);
  }

  /** Unmutes audio input from the user. */
  unmuteMic(): void {
    if (!this.room?.localParticipant) {
      throw new Error('Cannot unmuteMic.');
    }
    this._isMicMuted = false;
    this.room.localParticipant.setMicrophoneEnabled(true);
  }

  /** Toggles the mute state of the user's audio input. */
  toggleMicMute(): void {
    if (!this.room?.localParticipant) {
      throw new Error('Cannot toggle mic mute.');
    }

    if (this.isMicMuted) {
      this.unmuteMic();
    } else {
      this.muteMic();
    }
  }

  /** Mutes audio output from the agent. */
  muteSpeaker(): void {
    if (!this.room?.remoteParticipants) {
      throw new Error('Cannot muteSpeaker.');
    }
    this._isSpeakerMuted = true;
    this.room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => {
        publication.track?.setMuted(true);
      });
    });
  }

  /** Unmutes audio output from the agent. */
  unmuteSpeaker(): void {
    if (!this.room?.remoteParticipants) {
      throw new Error('Cannot unmuteSpeaker.');
    }
    this._isSpeakerMuted = false;
    this.room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => {
        publication.track?.setMuted(false);
      });
    });
  }

  /** Toggles the mute state of the agent's output audio. */
  toggleSpeakerMute(): void {
    if (!this.room?.remoteParticipants) {
      throw new Error('Cannot toggle speaker mute.');
    }

    if (this.isSpeakerMuted) {
      this.unmuteSpeaker();
    } else {
      this.muteSpeaker();
    }
  }

  private async handleSocketMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data);
    // We attach the Livekit audio to an audio element so that we can mute the audio
    // when the agent is not speaking. For now, disable Livekit's WebAudio mixing
    // to avoid the audio playing twice:
    //
    // References:
    //  - https://docs.livekit.io/guides/migrate-from-v1/#Javascript-Typescript
    //  - https://github.com/livekit/components-js/pull/855
    //
    this.room = new Room({ webAudioMix: false });
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => this.handleTrackSubscribed(track));
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant: any) =>
      this.handleDataReceived(payload, participant),
    );
    const [track, _] = await Promise.all([createLocalAudioTrack(), this.room.connect(msg.roomUrl, msg.token)]);
    this.localAudioTrack = track;
    this.localAudioTrack.setAudioContext(this.audioContext);

    if ([UltravoxSessionStatus.DISCONNECTED, UltravoxSessionStatus.DISCONNECTING].includes(this.status)) {
      // We've been stopped while waiting for the mic permission (during createLocalTracks).
      await this.disconnect();
      return;
    }

    this.audioContext.resume();
    this.audioElement.play();
    if (this.localAudioTrack.mediaStream) {
      this.micSourceNode = this.audioContext.createMediaStreamSource(this.localAudioTrack.mediaStream);
    }

    const opts = { name: 'audio', simulcast: false, source: Track.Source.Microphone };
    this.room.localParticipant.publishTrack(this.localAudioTrack, opts);
    this.setStatus(UltravoxSessionStatus.IDLE);
  }

  private async handleSocketClose(event: CloseEvent) {
    await this.disconnect();
  }

  private async disconnect() {
    this.setStatus(UltravoxSessionStatus.DISCONNECTING);
    this.localAudioTrack?.stop();
    this.localAudioTrack = undefined;
    await this.room?.disconnect();
    this.room = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.micSourceNode?.disconnect();
    this.micSourceNode = undefined;
    this.agentSourceNode?.disconnect();
    this.agentSourceNode = undefined;
    this.audioElement.pause();
    this.audioElement.srcObject = null;
    this.setStatus(UltravoxSessionStatus.DISCONNECTED);
  }

  private handleTrackSubscribed(track: RemoteTrack) {
    const audioTrack = track as RemoteAudioTrack;
    audioTrack.attach(this.audioElement);
    if (track.mediaStream) {
      this.agentSourceNode = this.audioContext.createMediaStreamSource(track.mediaStream);
    }
    if (this.delayedSpeakingState) {
      this.delayedSpeakingState = false;
      this.setStatus(UltravoxSessionStatus.SPEAKING);
    }
  }

  private setStatus(status: UltravoxSessionStatus) {
    if (this._status === status) {
      return;
    }
    this._status = status;
    this.dispatchEvent(new UltravoxSessionStatusChangedEvent());
  }

  private sendData(obj: any) {
    this.room?.localParticipant.publishData(this.textEncoder.encode(JSON.stringify(obj)), { reliable: true });
  }

  private handleDataReceived(payload: Uint8Array, _participant: any) {
    const msg = JSON.parse(this.textDecoder.decode(payload));
    if (msg.type === 'state') {
      const newState = msg.state;
      if (newState === UltravoxSessionStatus.SPEAKING && this.agentSourceNode === undefined) {
        // Skip the first speaking state, before we've attached the audio element.
        // handleTrackSubscribed will be called soon and will change the state.
        this.delayedSpeakingState = true;
      } else {
        this.setStatus(newState);
      }
    } else if (msg.type === 'transcript') {
      const medium = msg.transcript.medium == 'voice' ? Medium.VOICE : Medium.TEXT;
      const transcript = new Transcript(msg.transcript.text, msg.transcript.final, Role.USER, medium);
      this.addOrUpdateTranscript(transcript);
    } else if (msg.type === 'voice_synced_transcript' || msg.type == 'agent_text_transcript') {
      const medium = msg.type == 'agent_text_transcript' ? Medium.TEXT : Medium.VOICE;
      if (msg.text != null) {
        const newTranscript = new Transcript(msg.text, msg.final, Role.AGENT, medium);
        this.addOrUpdateTranscript(newTranscript);
      } else if (msg.delta != null) {
        const lastTranscript = this._transcripts.length ? this._transcripts[this._transcripts.length - 1] : undefined;
        if (lastTranscript && lastTranscript.speaker == Role.AGENT) {
          const newTranscript = new Transcript(lastTranscript.text + msg.delta, msg.final, Role.AGENT, medium);
          this.addOrUpdateTranscript(newTranscript);
        }
      }
    } else if (msg.type == 'client_tool_invocation') {
      this.invokeClientTool(msg.toolName, msg.invocationId, msg.parameters);
    } else if (this.experimentalMessages) {
      this.dispatchEvent(new UltravoxExperimentalMessageEvent(msg));
    }
  }

  private addOrUpdateTranscript(transcript: Transcript) {
    if (this._transcripts.length) {
      const lastTranscript = this._transcripts[this._transcripts.length - 1];
      if (lastTranscript && !lastTranscript.isFinal && transcript.speaker === lastTranscript.speaker) {
        this._transcripts[this._transcripts.length - 1] = transcript;
      } else {
        this._transcripts.push(transcript);
      }
    } else {
      this._transcripts.push(transcript);
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
    } else {
      const resultString = result.result;
      const responseType = result.responseType;
      if (typeof resultString !== 'string' || typeof responseType !== 'string') {
        this.sendData({
          type: 'client_tool_result',
          invocationId,
          errorType: 'implementation-error',
          errorMessage:
            'Client tool result must be a string or an object with string "result" and "responseType" properties.',
        });
      } else {
        this.sendData({ type: 'client_tool_result', invocationId, result: resultString, responseType });
      }
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
