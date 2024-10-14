# openai-s2s-example

This application was created with the [create-jambonz-ws-api](https://www.npmjs.com/package/create-jambonz-ws-app) command.  This documentation was generated at the time when the project was generated and describes the functionality that was initially scaffolded.  Of course, you should feel free to modify or replace this documentation as you build out your own logic.

## Services

Based on the options that you have chosen, this application exposes the following services over a websocket interface:



### /chat-gpt3/:apiKey
A basic voicebot for Openai's [GPT-3](https://beta.openai.com/docs/api-reference/completions) large language model (LLM).  This service requires an API Key from openai which in this case should be presented in the path of the http request.
> Note: this is done only to show how to retrieve information from the incoming http request if necessary, in a production app secret information like this should be presented via environment variables.

