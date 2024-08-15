"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UltravoxSession = exports.UltravoxSessionState = exports.UltravoxTranscriptsChangedEvent = exports.UltravoxSessionStatusChangedEvent = exports.UltravoxSessionStateChangeEvent = exports.Transcript = exports.Role = exports.UltravoxSessionStatus = void 0;
const livekit_client_1 = require("livekit-client");
var UltravoxSessionStatus;
(function (UltravoxSessionStatus) {
    UltravoxSessionStatus["DISCONNECTED"] = "disconnected";
    UltravoxSessionStatus["DISCONNECTING"] = "disconnecting";
    UltravoxSessionStatus["CONNECTING"] = "connecting";
    UltravoxSessionStatus["IDLE"] = "idle";
    UltravoxSessionStatus["LISTENING"] = "listening";
    UltravoxSessionStatus["THINKING"] = "thinking";
    UltravoxSessionStatus["SPEAKING"] = "speaking";
})(UltravoxSessionStatus || (exports.UltravoxSessionStatus = UltravoxSessionStatus = {}));
var Role;
(function (Role) {
    Role["USER"] = "user";
    Role["AGENT"] = "agent";
})(Role || (exports.Role = Role = {}));
class Transcript {
    constructor(text, isFinal, speaker, delta) {
        this.text = text;
        this.isFinal = isFinal;
        this.speaker = speaker;
        this.delta = delta;
    }
}
exports.Transcript = Transcript;
class UltravoxSessionStateChangeEvent extends Event {
    constructor(eventName, state, transcripts) {
        super(eventName);
        this.state = state;
        this.transcripts = transcripts;
    }
}
exports.UltravoxSessionStateChangeEvent = UltravoxSessionStateChangeEvent;
class UltravoxSessionStatusChangedEvent extends UltravoxSessionStateChangeEvent {
    constructor(state, transcripts) {
        super('ultravoxSessionStatusChanged', state, transcripts);
        this.state = state;
        this.transcripts = transcripts;
    }
}
exports.UltravoxSessionStatusChangedEvent = UltravoxSessionStatusChangedEvent;
class UltravoxTranscriptsChangedEvent extends UltravoxSessionStateChangeEvent {
    constructor(state, transcripts) {
        super('ultravoxTranscriptsChanged', state, transcripts);
        this.state = state;
        this.transcripts = transcripts;
    }
}
exports.UltravoxTranscriptsChangedEvent = UltravoxTranscriptsChangedEvent;
class UltravoxSessionState extends EventTarget {
    constructor() {
        super();
        this.transcripts = [];
        this.status = UltravoxSessionStatus.DISCONNECTED;
    }
    getTranscripts() {
        return this.transcripts;
    }
    getStatus() {
        return this.status;
    }
    setStatus(status) {
        this.status = status;
        this.dispatchEvent(new UltravoxSessionStatusChangedEvent(status, this.transcripts));
    }
    addOrUpdateTranscript(transcript) {
        if (this.transcripts && this.transcripts.length > 0) {
            const lastTranscript = this.transcripts[this.transcripts.length - 1];
            if (!lastTranscript.isFinal && transcript.speaker === lastTranscript.speaker) {
                this.transcripts[this.transcripts.length - 1] = transcript;
            }
            else {
                this.transcripts.push(transcript);
            }
        }
        else {
            this.transcripts = [transcript];
        }
        this.dispatchEvent(new UltravoxTranscriptsChangedEvent(this.status, this.transcripts));
    }
}
exports.UltravoxSessionState = UltravoxSessionState;
class UltravoxSession {
    constructor(audioContext = new AudioContext()) {
        this.audioContext = audioContext;
        this.state = new UltravoxSessionState();
        this.audioElement = new Audio();
        this.delayedSpeakingState = false;
        this.textDecoder = new TextDecoder();
    }
    joinCall(joinUrl) {
        if (this.state.getStatus() !== UltravoxSessionStatus.DISCONNECTED) {
            throw new Error('Cannot join a new call while already in a call');
        }
        this.state.setStatus(UltravoxSessionStatus.CONNECTING);
        this.socket = new WebSocket(joinUrl);
        this.socket.onmessage = (event) => this.handleSocketMessage(event);
        this.socket.onclose = (event) => this.handleSocketClose(event);
        return this.state;
    }
    async leaveCall() {
        await this.disconnect();
    }
    async handleSocketMessage(event) {
        const msg = JSON.parse(event.data);
        // We attach the Livekit audio to an audio element so that we can mute the audio
        // when the agent is not speaking. For now, disable Livekit's WebAudio mixing
        // to avoid the audio playing twice:
        //
        // References:
        //  - https://docs.livekit.io/guides/migrate-from-v1/#Javascript-Typescript
        //  - https://github.com/livekit/components-js/pull/855
        //
        this.room = new livekit_client_1.Room({ webAudioMix: false });
        this.room.on(livekit_client_1.RoomEvent.TrackSubscribed, (track) => this.handleTrackSubscribed(track));
        this.room.on(livekit_client_1.RoomEvent.DataReceived, (payload, participant) => this.handleDataReceived(payload, participant));
        const [track, _] = await Promise.all([(0, livekit_client_1.createLocalAudioTrack)(), this.room.connect(msg.roomUrl, msg.token)]);
        this.localAudioTrack = track;
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
        const opts = { name: 'audio', simulcast: false, source: livekit_client_1.Track.Source.Microphone };
        this.room.localParticipant.publishTrack(this.localAudioTrack, opts);
        this.state.setStatus(UltravoxSessionStatus.IDLE);
    }
    async handleSocketClose(event) {
        await this.disconnect();
    }
    async disconnect() {
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
    handleTrackSubscribed(track) {
        const audioTrack = track;
        audioTrack.attach(this.audioElement);
        if (track.mediaStream) {
            this.agentSourceNode = this.audioContext.createMediaStreamSource(track.mediaStream);
        }
        if (this.delayedSpeakingState) {
            this.delayedSpeakingState = false;
            this.state.setStatus(UltravoxSessionStatus.SPEAKING);
        }
    }
    handleDataReceived(payload, _participant) {
        const msg = JSON.parse(this.textDecoder.decode(payload));
        if (msg.type === 'state') {
            const newState = msg.state;
            if (newState === UltravoxSessionStatus.SPEAKING && this.agentSourceNode === undefined) {
                // Skip the first speaking state, before we've attached the audio element.
                // handleTrackSubscribed will be called soon and will change the state.
                this.delayedSpeakingState = true;
            }
            else {
                this.state.setStatus(newState);
            }
        }
        else if (msg.type === 'transcript') {
            const transcript = new Transcript(msg.transcript.text, msg.transcript.final, Role.USER);
            this.state.addOrUpdateTranscript(transcript);
        }
        // Agent messages are sent as deltas to enable displaying them with audio.
        else if (msg.type === 'voice_synced_transcript') {
            let newTranscript;
            if (msg.text != null) {
                newTranscript = new Transcript(msg.text, msg.final, Role.AGENT);
                this.state.addOrUpdateTranscript(newTranscript);
            }
            else if (msg.delta != null) {
                const currentTranscripts = this.state.getTranscripts();
                const lastMessage = currentTranscripts[currentTranscripts.length - 1];
                if (lastMessage.speaker != Role.AGENT) {
                    console.log('Unexpected delta message!');
                }
                else {
                    newTranscript = new Transcript(lastMessage.text + msg.delta, msg.final, Role.AGENT);
                    this.state.addOrUpdateTranscript(newTranscript);
                }
            }
        }
    }
}
exports.UltravoxSession = UltravoxSession;
