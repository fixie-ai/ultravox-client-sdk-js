export declare enum UltravoxSessionStatus {
    DISCONNECTED = "disconnected",
    DISCONNECTING = "disconnecting",
    CONNECTING = "connecting",
    IDLE = "idle",
    LISTENING = "listening",
    THINKING = "thinking",
    SPEAKING = "speaking"
}
export declare enum Role {
    USER = "user",
    AGENT = "agent"
}
export declare class Transcript {
    readonly text: string;
    readonly isFinal: boolean;
    readonly speaker: Role;
    readonly delta?: string | undefined;
    constructor(text: string, isFinal: boolean, speaker: Role, delta?: string | undefined);
}
export declare class UltravoxSessionStateChangeEvent extends Event {
    readonly state: UltravoxSessionStatus;
    readonly transcripts: Transcript[];
    constructor(eventName: string, state: UltravoxSessionStatus, transcripts: Transcript[]);
}
export declare class UltravoxSessionStatusChangedEvent extends UltravoxSessionStateChangeEvent {
    readonly state: UltravoxSessionStatus;
    readonly transcripts: Transcript[];
    constructor(state: UltravoxSessionStatus, transcripts: Transcript[]);
}
export declare class UltravoxTranscriptsChangedEvent extends UltravoxSessionStateChangeEvent {
    readonly state: UltravoxSessionStatus;
    readonly transcripts: Transcript[];
    constructor(state: UltravoxSessionStatus, transcripts: Transcript[]);
}
export declare class UltravoxSessionState extends EventTarget {
    private transcripts;
    private status;
    constructor();
    getTranscripts(): Transcript[];
    getStatus(): UltravoxSessionStatus;
    setStatus(status: UltravoxSessionStatus): void;
    addOrUpdateTranscript(transcript: Transcript): void;
}
export declare class UltravoxSession {
    readonly audioContext: AudioContext;
    private readonly state;
    private socket?;
    private room?;
    private audioElement;
    private localAudioTrack?;
    private micSourceNode?;
    private agentSourceNode?;
    private delayedSpeakingState;
    private readonly textDecoder;
    constructor(audioContext?: AudioContext);
    joinCall(joinUrl: string): UltravoxSessionState;
    leaveCall(): Promise<void>;
    private handleSocketMessage;
    private handleSocketClose;
    private disconnect;
    private handleTrackSubscribed;
    private handleDataReceived;
}
