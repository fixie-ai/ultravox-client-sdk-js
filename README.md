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

_Note: Join URL's are created using the Ultravox API. See the [docs](https://docs.ultravox.ai) for more info._

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

There is also an `error` event emitted when a session ends unexpectedly, for example because the
network dropped the call's media connection. It is emitted immediately before the session's final
`status` events. (No `error` event is emitted when a call ends normally.)

```javascript
session.addEventListener('error', (event) => {
  console.log('Session ended unexpectedly: ', event.error);
});
```

## Unreliable Networks

Some networks (especially certain residential routers) disrupt long-lived UDP flows, which can
cause calls to drop after a minute or so even though other traffic appears healthy. If your users
are affected, you can force call media through a TURN relay, which typically uses TCP or TLS on
port 443 at the cost of slightly higher latency:

```javascript
const session = new UltravoxSession({ rtcConfig: { iceTransportPolicy: 'relay' } });
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
| ordinal  | number  | The position of the message within the call, for sorting.                                                                 |

## Sending Text

Text can be sent to the agent during a call:

```javascript
import { TextMessageUrgency } from 'ultravox-client';

session.sendText('Show me my order history');

// Urgency controls how soon the agent responds: IMMEDIATE (interrupt the agent if it is
// speaking), SOON (respond at the next opportunity, the default), or LATER (don't force a
// response; the message is simply included the next time the agent responds).
session.sendText('The user tapped the checkout button', { urgency: TextMessageUrgency.LATER });
```

Arbitrary [data messages](https://docs.ultravox.ai/datamessages) can also be sent with
`session.sendData(message)`, and every data message received after the call connects is emitted
as a `data_message` event on the session (calling `preventDefault()` on that event suppresses
the SDK's default handling of the message).

## Speech Indicators and Audio Analysis

The session exposes Web Audio source nodes for both sides of the conversation, for example for
attaching an `AnalyserNode` to drive speech indicators. Both are undefined until the relevant
audio exists — typically shortly after the call connects (and, for the mic, after the user grants
permission). The nodes belong to the session's `AudioContext`, and Web Audio nodes from different
contexts cannot be connected, so provide the context yourself when you want to attach your own
nodes:

```javascript
const audioContext = new AudioContext();
const session = new UltravoxSession({ audioContext });

// Then, once the call's audio is flowing:
const analyser = audioContext.createAnalyser();
session.agentSourceNode?.connect(analyser); // Or micSourceNode for the user's audio.
```

Note that the nodes produce data only while the `AudioContext` is running; if the browser blocked
audio pending a user gesture, resume the context after the next gesture.

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
