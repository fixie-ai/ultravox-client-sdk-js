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
