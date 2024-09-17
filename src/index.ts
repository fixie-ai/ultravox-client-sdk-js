import {
  createLocalAudioTrack,
  LocalAudioTrack,
  RemoteAudioTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';

export enum UltravoxSessionStatus {
  DISCONNECTED = 'disconnected',
  DISCONNECTING = 'disconnecting',
  CONNECTING = 'connecting',
  IDLE = 'idle',
  LISTENING = 'listening',
  THINKING = 'thinking',
  SPEAKING = 'speaking',
}

export enum Role {
  USER = 'user',
  AGENT = 'agent',
}

export type RoleString = 'user' | 'agent';

export enum Medium {
  VOICE = 'voice',
  TEXT = 'text',
}

export class Transcript {
  constructor(
    readonly text: string,
    readonly isFinal: boolean,
    readonly speaker: Role,
    readonly medium: Medium,
  ) {}
}

export class UltravoxSessionStateChangeEvent extends Event {
  constructor(
    eventName: string,
    readonly state: UltravoxSessionStatus,
    readonly transcripts: Transcript[],
  ) {
    super(eventName);
  }
}

export class UltravoxSessionStatusChangedEvent extends UltravoxSessionStateChangeEvent {
  constructor(
    readonly state: UltravoxSessionStatus,
    readonly transcripts: Transcript[],
  ) {
    super('ultravoxSessionStatusChanged', state, transcripts);
  }
}

export class UltravoxTranscriptsChangedEvent extends UltravoxSessionStateChangeEvent {
  constructor(
    readonly state: UltravoxSessionStatus,
    readonly transcripts: Transcript[],
  ) {
    super('ultravoxTranscriptsChanged', state, transcripts);
  }
}

export class UltravoxExperimentalMessageEvent extends Event {
  constructor(readonly message: any) {
    super('ultravoxExperimentalMessage');
  }
}

export class UltravoxSessionState extends EventTarget {
  private readonly transcripts: Transcript[] = [];
  private status: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;

  constructor() {
    super();
  }

  getTranscripts(): Transcript[] {
    return this.transcripts;
  }

  getStatus(): UltravoxSessionStatus {
    return this.status;
  }

  setStatus(status: UltravoxSessionStatus) {
    this.status = status;
    this.dispatchEvent(new UltravoxSessionStatusChangedEvent(status, this.transcripts));
  }

  addOrUpdateTranscript(transcript: Transcript) {
    if (this.transcripts.length) {
      const lastTranscript = this.transcripts[this.transcripts.length - 1];
      if (lastTranscript && !lastTranscript.isFinal && transcript.speaker === lastTranscript.speaker) {
        this.transcripts[this.transcripts.length - 1] = transcript;
      } else {
        this.transcripts.push(transcript);
      }
    } else {
      this.transcripts.push(transcript);
    }
    this.dispatchEvent(new UltravoxTranscriptsChangedEvent(this.status, this.transcripts));
  }
}

export class UltravoxSession {
  private static CONNECTED_STATUSES = new Set([
    UltravoxSessionStatus.LISTENING,
    UltravoxSessionStatus.THINKING,
    UltravoxSessionStatus.SPEAKING,
  ]);

  private readonly state = new UltravoxSessionState();
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

  private isUserMuted: boolean = false;
  private isAgentMuted: boolean = false;

  constructor({
    audioContext,
    experimentalMessages,
  }: {
    audioContext?: AudioContext;
    experimentalMessages?: Set<string>;
  } = {}) {
    this.audioContext = audioContext || new AudioContext();
    this.experimentalMessages = experimentalMessages || new Set();
  }

  joinCall(joinUrl: string): UltravoxSessionState {
    if (this.state.getStatus() !== UltravoxSessionStatus.DISCONNECTED) {
      throw new Error('Cannot join a new call while already in a call');
    }
    if (this.experimentalMessages) {
      const url = new URL(joinUrl);
      url.searchParams.set('experimentalMessages', Array.from(this.experimentalMessages.values()).join(','));
      joinUrl = url.toString();
    }
    this.state.setStatus(UltravoxSessionStatus.CONNECTING);
    this.socket = new WebSocket(joinUrl);
    this.socket.onmessage = (event) => this.handleSocketMessage(event);
    this.socket.onclose = (event) => this.handleSocketClose(event);
    return this.state;
  }

  async leaveCall(): Promise<void> {
    await this.disconnect();
  }

  sendText(text: string) {
    const status = this.state.getStatus();
    if (!UltravoxSession.CONNECTED_STATUSES.has(status)) {
      throw new Error(`Cannot send text while not connected. Current status is ${status}.`);
    }
    this.sendData({ type: 'input_text_message', text });
  }

  mute(roles: RoleString | RoleString[] | Set<RoleString> | Role | Role[] | Set<Role>): void {
    const roleSet = this.getRoleSet(roles);

    for (const role of roleSet) {
      switch (role) {
        case Role.AGENT:
          if (!this.room?.remoteParticipants) {
            throw new Error('Cannot set isAgentMuted.');
          }
          this.isAgentMuted = true;
          this.room.remoteParticipants.forEach((rp) => {
            rp.audioTrackPublications.forEach((atp) => {
              atp.track?.setMuted(this.isAgentMuted);
            });
          });
          break;

        case Role.USER:
          if (!this.room?.localParticipant) {
            throw new Error('Cannot set isCallerMuted.');
          }
          this.isUserMuted = true;
          this.room.localParticipant.setMicrophoneEnabled(!this.isUserMuted);
          break;

        default:
          break;
      }
    }
  }

  unmute(roles: RoleString | RoleString[] | Set<RoleString> | Role | Role[] | Set<Role>): void {
    const roleSet = this.getRoleSet(roles);

    for (const role of roleSet) {
      switch (role) {
        case Role.AGENT:
          if (!this.room?.remoteParticipants) {
            throw new Error('Cannot set isAgentMuted.');
          }
          this.isAgentMuted = false;
          this.room.remoteParticipants.forEach((rp) => {
            rp.audioTrackPublications.forEach((atp) => {
              atp.track?.setMuted(this.isAgentMuted);
            });
          });
          break;

        case Role.USER:
          if (!this.room?.localParticipant) {
            throw new Error('Cannot set isCallerMuted.');
          }
          this.isUserMuted = false;
          this.room.localParticipant.setMicrophoneEnabled(!this.isUserMuted);
          break;

        default:
          break;
      }
    }
  }

  isMuted(role: RoleString | Role): boolean {
    const roleString = role.toString() as RoleString;

    switch (roleString) {
      case Role.AGENT:
        return this.isAgentMuted;
      case Role.USER:
        return this.isUserMuted;
      default:
        throw new Error(`Invalid role: ${roleString}`);
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

    if ([UltravoxSessionStatus.DISCONNECTED, UltravoxSessionStatus.DISCONNECTING].includes(this.state.getStatus())) {
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
    this.state.setStatus(UltravoxSessionStatus.IDLE);
  }

  private async handleSocketClose(event: CloseEvent) {
    await this.disconnect();
  }

  private async disconnect() {
    if (this.state.getStatus() !== UltravoxSessionStatus.DISCONNECTING) {
      this.state.setStatus(UltravoxSessionStatus.DISCONNECTING);
    }
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
    this.state.setStatus(UltravoxSessionStatus.DISCONNECTED);
  }

  private handleTrackSubscribed(track: RemoteTrack) {
    const audioTrack = track as RemoteAudioTrack;
    audioTrack.attach(this.audioElement);
    if (track.mediaStream) {
      this.agentSourceNode = this.audioContext.createMediaStreamSource(track.mediaStream);
    }
    if (this.delayedSpeakingState) {
      this.delayedSpeakingState = false;
      this.state.setStatus(UltravoxSessionStatus.SPEAKING);
    }
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
        this.state.setStatus(newState);
      }
    } else if (msg.type === 'transcript') {
      const medium = msg.transcript.medium == 'voice' ? Medium.VOICE : Medium.TEXT;
      const transcript = new Transcript(msg.transcript.text, msg.transcript.final, Role.USER, medium);
      this.state.addOrUpdateTranscript(transcript);
    } else if (msg.type === 'voice_synced_transcript' || msg.type == 'agent_text_transcript') {
      const medium = msg.type == 'agent_text_transcript' ? Medium.TEXT : Medium.VOICE;
      if (msg.text != null) {
        const newTranscript = new Transcript(msg.text, msg.final, Role.AGENT, medium);
        this.state.addOrUpdateTranscript(newTranscript);
      } else if (msg.delta != null) {
        const transcripts = this.state.getTranscripts();
        const lastTranscript = transcripts.length ? transcripts[transcripts.length - 1] : undefined;
        if (lastTranscript && lastTranscript.speaker == Role.AGENT) {
          const newTranscript = new Transcript(lastTranscript.text + msg.delta, msg.final, Role.AGENT, medium);
          this.state.addOrUpdateTranscript(newTranscript);
        }
      }
    } else if (this.experimentalMessages) {
      this.state.dispatchEvent(new UltravoxExperimentalMessageEvent(msg));
    }
  }

  private getRoleSet(roles: RoleString | RoleString[] | Set<RoleString> | Role | Role[] | Set<Role>): Set<RoleString> {
    const roleSet = new Set<RoleString>();

    if (roles instanceof Set) {
      roles.forEach((role) => roleSet.add(role.toString() as RoleString));
    } else if (Array.isArray(roles)) {
      roles.forEach((role) => roleSet.add(role.toString() as RoleString));
    } else {
      roleSet.add(roles.toString() as RoleString);
    }

    for (const role of roleSet) {
      if (!Object.values(Role).includes(role as Role)) {
        throw new Error(`Invalid role: ${role}`);
      }
    }

    return roleSet;
  }
}
