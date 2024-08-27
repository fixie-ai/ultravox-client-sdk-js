# Ultravox Client SDK (JavaScript)

This is the web client library for [Ultravox](https://ultravox.ai).

Written in TypeScript, this library allows you to easily integrate Ultravox's real-time, speech-to-speech AI into web applications.

## Quick Start

```javascript
import { UltravoxSession } from 'ultravox-client';

const session = new UltravoxSession();
const state = await session.joinCall('wss://your-call-join-url');

session.leaveCall();
```

_Note: Join URL's are created using the Ultravox API. See the [docs](https://fixie-ai.github.io/ultradox/) for more info._

## Events

When a call is started with `joinCall()`, an `UltravoxSessionState` object is returned. If we continue with the quick start code above, we can add event listeners for two events:

```javascript
state.addEventListener('ultravoxSessionStatusChanged', (event) => {
  console.log('Session status changed: ', event.state);
});

state.addEventListener('ultravoxTranscriptsChanged', (event) => {
  console.log('Transcripts updated: ', event.transcripts);
  console.log('Current session status: ', event.state); // Session status is also available on the event
});
```

## Session Status

The session status is based on the `UltravoxSessionStatus` enum and can be one of the following:

```
disconnecting
connecting
idle
listening
thinking
speaking
```

## Transcripts

Transcripts are an array of transcript objects. Each transcript has the following properties:

| property | type    | definition                                                                                                                |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| text     | string  | Text transcript of the speech from the end user or the agent.                                                             |
| isFinal  | boolean | True if the transcript represents a complete utterance. False if it is a fragment of an utterance that is still underway. |
| speaker  | Role    | Either "user" or "agent". Denotes who was speaking.                                                                       |