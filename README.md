# openai-s2s

This is an example jambonz application that connects to the OpenAI Realtime API and illustrates how to build a Voice-AI application using jambonz and OpenAI. It is a websocket application built with the [`@jambonz/sdk`](https://jambonz.github.io/node-sdk/) (`@jambonz/sdk/websocket`).

## Authentication
You need an OpenAI API key that has access to the Realtime API. There are two ways to provide it:

- **jambonz application env var (recommended):** the key is declared in [app.js](./app.js) via the `envVars` option and configured on the application in the jambonz portal. At runtime it arrives on `session.data.env_vars.OPENAI_API_KEY`.
- **process environment (local dev):** the route falls back to `process.env.OPENAI_API_KEY`, so you can also just start the app with it set:

```bash
OPENAI_API_KEY=sk-proj-XXXXXXX node app.js
```

## Prerequisites
- Node.js 18 or later (the app uses the built-in `fetch`).
- A jambonz server new enough to support the `llm` verb and the per-response watchdog options described below.

## Configuring the assistant
All of the configuration (in fact, all of the relevant code) can be found [in this source file](./lib/routes/openai-s2s.js). This is the file you will want to edit as you play with this example.

You can see that the application first answers the call, pauses one second, and then connects to the OpenAI Realtime API using the jambonz `llm` verb.  We specify the vendor and model, and provide options specific to that LLM (in this case `gpt-realtime`) in the `llmOptions` property.

In the case of the OpenAI Realtime API, configuration is provided in the form of the [response_create](https://platform.openai.com/docs/api-reference/realtime-client-events/response-create) and [session_update](https://platform.openai.com/docs/api-reference/realtime-client-events/response-create) client events that are sent to OpenAI.  These specify the instructions to the assistant as well as things like vad and function calling options.

## Function calling
The example illustrates how to implement client-side functions and provide them to the assistant.  In this example, we implement a simple "get weather" function using the freely-available APIs from [open-meteo.com](https://open-meteo.com/). The function is described in the session_update client message, and a `toolHook` property for the llm verb defines the hook that will be called in the application when the LLM wants the application to call a function.  Finally, the `session.sendToolOutput()` method is called to send the results of the function call back to the LLM.

## Interrupting the assistant
When the user begins speaking over the assistant (i.e. "barge in") jambonz immediately flushes any queued assistant audio so the caller stops hearing it.

By default, with `server_vad` turn detection OpenAI also cancels the in-progress response on its own. This example instead sets `turn_detection.interrupt_response: false` and lets jambonz cancel the response by enabling `cancelOnBargeIn: true` on the `llm` verb. On barge-in jambonz then sends a [response.cancel](https://platform.openai.com/docs/api-reference/realtime-client-events/response-cancel) so OpenAI stops generating (and billing for) audio the caller will never hear. This is most useful for *app-driven* turn-taking configurations, where OpenAI would not otherwise cancel the response.

## Detecting a stalled response (response watchdog)
If jambonz solicits a response (the initial greeting, the response after a tool call, or an app-driven `response.create`) and OpenAI never acknowledges it, the caller is left with dead air and no event ever fires. To guard against this, the `llm` verb supports an opt-in per-response watchdog:

- `responseTimeoutMs` — milliseconds to wait for a solicited response to be acknowledged before declaring a stall. On expiry jambonz emits a `{type: "response.timeout"}` event on your `eventHook`.
- `cancelOnResponseTimeout` — when `true`, jambonz also sends `response.cancel` on a stall so the next turn does not collide with an "active response in progress" error.

This example sets `responseTimeoutMs: 10000` and `cancelOnResponseTimeout: true`. In the `/event` handler, when a `response.timeout` event arrives the app recovers from the dead air by soliciting a fresh response with `session.updateLlm({type: 'response.create', ...})` — `updateLlm` sends an `llm:update` command that jambonz forwards to OpenAI.

## Events
There are [28 server events](https://platform.openai.com/docs/api-reference/realtime-server-events) that OpenAI sends, and your application can specify which it wants to receive.  (The only exception is the [esponse.audio.delta](https://platform.openai.com/docs/api-reference/realtime-server-events/response-audio-delta) server event, because this contains actual audio content that jambonz itself processes).  You specify which events you want to receive in the `events` property of the `llm` verb, and as you can see in the example you can use wildcards to include a whole class of server events (e.g. "conversation.item.*").

## ActionHook
Like many jambonz verbs, the `llm` verb sends an actionHook with a final status when the verb completes.  The payload will include a `completion_reason` property indicating why the llm session completed.  This property will be one of:
- normal conversation end
- connection failure
- disconnect from remote end
- server failure
- server error

In the case of an error an `error_code` object is returned.  We use this, for example, in this sample application to detect if the user's OpenAI's rate limits have been exceeded so as to notify them why the session is ending.