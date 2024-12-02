// example/index.js
import { UltravoxSession } from '../dist/esm/index.js';

class UltravoxExample {
  constructor() {
    this.uvSession = new UltravoxSession();
    this.setupEventListeners();
  }

  appendUpdate(target, message) {
    const updateTarget = document.getElementById(target);

    if (target === 'callTranscript') {
      let transcriptText = '';
      message.forEach((transcript, index) => {
        if (transcript.speaker === 'agent') {
          transcriptText += '<p>' + transcript.speaker + ': ' + transcript.text + '</p>';
        }
      });
      updateTarget.innerHTML = transcriptText;
      updateTarget.scrollTop = updateTarget.scrollHeight;
    } else {
      updateTarget.innerHTML = `<p>Call Status: ${message}</p>`;
    }
  }

  setupEventListeners() {
    // Set up session event listeners
    this.uvSession.addEventListener('status', (event) => {
      this.appendUpdate('callStatus', `Session status changed: ${this.uvSession.status}`);
    });

    this.uvSession.addEventListener('transcripts', (event) => {
      this.appendUpdate('callTranscript', this.uvSession.transcripts);
    });

    // Set up button click handlers
    document.getElementById('startCall').onclick = this.startCall.bind(this);
    document.getElementById('endCall').onclick = this.endCall.bind(this);
  }

  startCall = async () => {
    const joinUrl = document.getElementById('joinUrl').value;
    if (!joinUrl) {
      this.appendUpdate('callStatus', 'Please enter a valid join URL');
      return;
    }

    this.appendUpdate('callStatus', 'Starting call');
    this.uvSession.joinCall(joinUrl);
    this.appendUpdate('callStatus', `Joining call: ${this.uvSession.status}`);
  };

  endCall = async () => {
    this.appendUpdate('callStatus', 'Ending call');
    this.uvSession.leaveCall();
  };
}

// Initialize the example when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new UltravoxExample();
});
