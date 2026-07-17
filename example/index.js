// example/index.js
import { UltravoxSession } from '../dist/esm/index.js';

class UltravoxExample {
  constructor() {
    this.uvSession = new UltravoxSession();
    this.setUpEventListeners();
  }

  updateStatus(message) {
    document.getElementById('callStatus').textContent = `Call Status: ${message}`;
  }

  renderTranscripts() {
    // The session's transcripts array is the source of truth: it already merges partial
    // utterances and is emptied when the session is reused for a new call, so rendering it
    // wholesale keeps this display correct without tracking any state here.
    const container = document.getElementById('callTranscript');
    container.replaceChildren(
      ...this.uvSession.transcripts.map((transcript) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = `${transcript.speaker}: ${transcript.text}`;
        return paragraph;
      }),
    );
    container.scrollTop = container.scrollHeight;
  }

  setUpEventListeners() {
    // Set up session event listeners
    this.uvSession.addEventListener('status', () => {
      this.updateStatus(`Session status changed: ${this.uvSession.status}`);
    });

    this.uvSession.addEventListener('transcripts', () => {
      this.renderTranscripts();
    });

    this.uvSession.addEventListener('error', (event) => {
      this.updateStatus(`Session ended unexpectedly: ${event.error.message}`);
    });

    this.uvSession.addEventListener('video_track_subscribed', (event) => {
      const videoElement = event.videoElement;
      videoElement.autoplay = true;
      videoElement.style.position = 'fixed';
      videoElement.style.bottom = '0';
      videoElement.style.right = '0';
      videoElement.style.width = '600px';
      document.body.appendChild(videoElement);
      this.updateStatus('Video track subscribed');
    });

    // Set up button click handlers
    document.getElementById('startCall').onclick = this.startCall.bind(this);
    document.getElementById('endCall').onclick = this.endCall.bind(this);
  }

  startCall = async () => {
    const joinUrl = document.getElementById('joinUrl').value;
    if (!joinUrl) {
      this.updateStatus('Please enter a valid join URL');
      return;
    }

    this.updateStatus('Starting call');
    this.uvSession.registerToolImplementation('getSecretMenu', this.getSecretMenu);
    this.uvSession.joinCall(joinUrl);
    this.updateStatus(`Joining call: ${this.uvSession.status}`);
  };

  endCall = async () => {
    this.updateStatus('Ending call');
    this.uvSession.leaveCall();
  };

  getSecretMenu(params) {
    const result = {
      date: new Date().toISOString(),
      specialItems: [
        {
          name: 'Banana smoothie',
          price: 3.99,
        },
        {
          name: 'Butter pecan ice cream (one scoop)',
          price: 1.99,
        },
      ],
    };
    return JSON.stringify(result);
  }
}

// Initialize the example when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new UltravoxExample();
});
