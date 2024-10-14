# openai-s2s

This is an example jambonz application that connect to the OpenAI Realtime API and illustrates how to build a Voice-AI application using jambonz and OpenAI.  

## Authentication
You must have an OpenAI API key that has access to the Realtime API.  Specify it as an environment variable when starting the application.

```bash
OPENAI_API_KEY=sk-proj-XXXXXXX node app.js
```

## Prerequisites
This application requires a jambonz server running release 0.9.2-rc3 or above.

## Configuring the assistant
All of the configuration (in fact, all of the code for this application) can be found [in this source file](./lib/routes/openai-s2s.js). This is the file you will want to edit as you play with this example.

You can see that application first answers the call, pauses one second, and the connects to the OpenAI Realtime API using the jambonz `llm` verb.  We specify the vendor and model, and provide options specific to that LLM (in this case gpt-4o-realtime-preview-2024-10-01) in the `llmOptions` property.

In the case of the OpenAI Realtime API, configuration is provided in the form of the [response_create](https://platform.openai.com/docs/api-reference/realtime-client-events/response-create) and [session_update](https://platform.openai.com/docs/api-reference/realtime-client-events/response-create) client events that are sent to OpenAI.  These specify the instructions to the assistant as well as things like vad and function calling options.

## Function calling
The example illustrates how to implement client-side functions and provide them to the assistant.  In this example, we implement a simple "get weather" function using the freely-available APIs from [open-meteo.com](https://open-meteo.com/). The function is described in the session_update client message, and a `toolHook` property for the llm verb defines the hook that will be called in the application when the LLM wants the application to call a function.  Finally, the `session.sendToolOutput()` method is called to send the results of the function call back to the LLM.

## Interrupting the assistant
When the user begins speaking over the assistant (i.e. "barge in") jambonz sends a [response.cancel](https://platform.openai.com/docs/api-reference/realtime-client-events/response-cancel) client event to interrupt the assistant.  Any queued audio that has been received from the assistant is flushed.

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