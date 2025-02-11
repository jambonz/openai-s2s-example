const axios = require('axios');
const service = ({logger, makeService}) => {
  const svc = makeService({path: '/openai-s2s'});

  svc.on('session:new', (session, path) => {
    session.locals = { ...session.locals,
      transcripts: [],
      logger: logger.child({call_sid: session.call_sid})
    };
    session.locals.logger.info({session, path}, `new incoming call: ${session.call_sid}`);

    const apiKey = process.env.OPENAI_API_KEY;
    session
      .on('/event', onEvent.bind(null, session))
      .on('/toolCall', onToolCall.bind(null, session))
      .on('/final', onFinal.bind(null, session))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session));

    if (!apiKey) {
      session.locals.logger.info('missing env OPENAI_API_KEY, hanging up');
      session
        .hangup()
        .send();
    }
    else {
      session
        .answer()
        .pause({length: 1})
        .llm({
          vendor: 'openai',
          model: 'gpt-4o-realtime-preview-2024-12-17',
          auth: {
            apiKey
          },
          actionHook: '/final',
          eventHook: '/event',
          toolHook: '/toolCall',
          events: [
            'conversation.item.*',
            'response.audio_transcript.done',
            'input_audio_buffer.committed'
          ],
          llmOptions: {
            response_create: {
              modalities: ['text', 'audio'],
              instructions: 'Please assist the user with their request.',
              voice: 'alloy',
              output_audio_format: 'pcm16',
              temperature: 0.8,
              max_output_tokens: 4096,
            },
            session_update: {
              tools: [
                {
                  name: 'get_weather',
                  type: 'function',
                  description: 'Get the weather at a given location',
                  parameters: {
                    type: 'object',
                    properties: {
                      location: {
                        type: 'string',
                        description: 'Location to get the weather from',
                      },
                      scale: {
                        type: 'string',
                        enum: ['fahrenheit', 'celsius'],
                      },
                    },
                    required: ['location', 'scale'],
                  },
                },
              ],
              tool_choice: 'auto',
              input_audio_transcription: {
                model: 'whisper-1',
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.8,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              }
            }
          }
        })
        .hangup()
        .send();
    }
  });
};

const onFinal = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got actionHook: ${JSON.stringify(evt)}`);

  if (['server failure', 'server error'].includes(evt.completion_reason)) {
    if (evt.error.code === 'rate_limit_exceeded') {
      let text = 'Sorry, you have exceeded your open AI rate limits. ';
      const arr = /try again in (\d+)/.exec(evt.error.message);
      if (arr) {
        text += `Please try again in ${arr[1]} seconds.`;
      }
      session
        .say({text});
    }
    else {
      session
        .say({text: 'Sorry, there was an error processing your request.'});
    }
    session.hangup();
  }
  session.reply();
};

const onEvent = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got eventHook: ${JSON.stringify(evt)}`);
};

const onToolCall = async(session, evt) => {
  const {logger} = session.locals;
  const {name, args, tool_call_id} = evt;
  const {location, scale} = args;

  logger.info({evt}, `got toolHook for ${name} with tool_call_id ${tool_call_id}`);

  try {
    /* first we need lat and long, then we can get the weather for that location */
    let url = `https://geocoding-api.open-meteo.com/v1/search?name=${location}&count=1&language=en&format=json`;
    let response = await axios.get(url);

    if (!Array.isArray(response.data.results) || 0 == response.data.results.length) {
      throw new Error('location_not_found');
    }
    const {latitude:lat, longitude:lng, name, timezone, population, country} = response.data.results[0];

    logger.info({name, country, lat, lng, timezone, population}, 'got response from geocoding API');

    // eslint-disable-next-line max-len
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m&temperature_unit=${scale}`;

    logger.info(`calling weather API with url: ${url}`);
    response = await axios.get(url);
    const weather = response.data;
    logger.info({weather}, 'got response from weather API');

    const data = {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: tool_call_id,
        output: weather,
      }
    };

    session.sendToolOutput(tool_call_id, data);

  } catch (err) {
    logger.info({err}, 'error calling geocoding or weather API');
    session.sendToolOutput(tool_call_id, {error: err});
  }
};

const onClose = (session, code, reason) => {
  const {logger} = session.locals;
  logger.info({code, reason}, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err}, `session ${session.call_sid} received error`);
};

module.exports = service;
