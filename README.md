# Ultravox Client SDK (JavaScript)

This is the web client library for [Ultravox](https://ultravox.ai).

[![npm package](https://img.shields.io/npm/v/ultravox-client?label=ultravox-client&color=orange)](https://www.npmjs.com/package/ultravox-client)

Written in TypeScript, this library allows you to easily integrate Ultravox's real-time, speech-to-speech AI into web applications.

## Quick Start

```javascript
import { UltravoxSession } from 'ultravox-client';

const session = new UltravoxSession();
session.joinCall('wss://your-call-join-url');

session.leaveCall();
```

_Note: Join URL's are created using the Ultravox API. See the [docs](https://fixie-ai.github.io/ultradox/) for more info._

## Events

If we continue with the quick start code above, we can add event listeners for two events:

```javascript
session.addEventListener('status', (event) => {
  console.log('Session status changed: ', session.status);
});

session.addEventListener('transcripts', (event) => {
  console.log('Transcripts updated: ', session.transcripts);
});
```

## Session Status

The session status is based on the `UltravoxSessionStatus` enum and can be one of the following:

| state         | description                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------- |
| disconnected  | The session is not connected and not attempting to connect. This is the initial state.              |
| disconnecting | The client is disconnecting from the session.                                                       |
| connecting    | The client is attempting to connect to the session.                                                 |
| idle          | The client is connected to the session and the server is warming up.                                |
| listening     | The client is connected and the server is listening for voice input.                                |
| thinking      | The client is connected and the server is considering its response. The user can still interrupt.   |
| speaking      | The client is connected and the server is playing response audio. The user can interrupt as needed. |

## Transcripts

Transcripts are an array of transcript objects. Each transcript has the following properties:

| property | type    | definition                                                                                                                |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| text     | string  | Text transcript of the speech from the end user or the agent.                                                             |
| isFinal  | boolean | True if the transcript represents a complete utterance. False if it is a fragment of an utterance that is still underway. |
| speaker  | Role    | Either "user" or "agent". Denotes who was speaking.                                                                       |
| medium   | Medium  | Either "voice" or "text". Denotes how the message was sent.                                                               |

## Testing SDK Versions

This repo includes a basic example application that can be used with the SDK. The example application requires running a local web server:

```bash
pnpm serve-example
```

Then navigate your browser to `http://localhost:8080/example/` and use the example.

### Missing version.js file

If build fails because it cannot find './version.js', run the following:

```bash
pnpm publish --dry-run --git-checks=false
```
