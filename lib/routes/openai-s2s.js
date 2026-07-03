const service = ({logger, makeService}) => {
  const svc = makeService({path: '/socket'});

  svc.on('session:new', (session) => {
    const log = logger.child({call_sid: session.callSid});
    log.info({from: session.data.from, to: session.data.to},
      `new incoming call: ${session.callSid}`);

    /* the OpenAI key comes from the jambonz application env vars (declared in
     * app.js); fall back to the process env for local development. */
    const apiKey = session.data.env_vars?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

    session
      .on('/event', (evt) => onEvent(session, log, evt))
      .on('/toolCall', (evt) => onToolCall(session, log, evt))
      .on('/final', (evt) => onFinal(session, log, evt))
      .on('close', (code, reason) => log.info({code, reason}, `session ${session.callSid} closed`))
      .on('error', (err) => log.info({err}, `session ${session.callSid} received error`));

    if (!apiKey) {
      log.info('missing OPENAI_API_KEY (set it as a jambonz application env var or in the process env), hanging up');
      session
        .hangup()
        .send();
      return;
    }

    session
      .answer()
      .pause({length: 1})
      .llm({
        vendor: 'openai',
        model: 'gpt-realtime',
        auth: {apiKey},
        actionHook: '/final',
        eventHook: '/event',
        toolHook: '/toolCall',

        /* --- per-response watchdog (jambonz-feature-server #120) --- */
        /* If a response we solicit is not acknowledged by OpenAI within this
         * many ms, jambonz emits a {type:'response.timeout'} event on the
         * eventHook so the app can detect a stalled turn (dead air). */
        responseTimeoutMs: 10000,
        /* On a stall, also have jambonz send response.cancel server-side so
         * the next turn does not collide with "active response in progress". */
        cancelOnResponseTimeout: true,
        /* On caller barge-in, have jambonz send response.cancel. This is what
         * stops OpenAI from continuing to generate (and bill for) audio the
         * caller will never hear. See note on turn_detection below: we set
         * interrupt_response:false so OpenAI does NOT self-cancel, making this
         * the mechanism that interrupts the assistant. */
        cancelOnBargeIn: true,

        events: [
          'conversation.item.*',
          'response.output_audio_transcript.done',
          'input_audio_buffer.committed',
          /* observe barge-in so we can log it alongside the cancel */
          'input_audio_buffer.speech_started',
          /* the new stall event (always delivered, listed here for clarity) */
          'response.timeout'
        ],
        llmOptions: {
          response_create: {
            output_modalities: ['audio'],
            instructions: 'Greet the caller warmly in English and ask how you can help today.',
            audio: {
              output: {
                voice: 'alloy',
                format: {type: 'audio/pcm', rate: 24000}
              }
            },
            max_output_tokens: 4096,
          },
          session_update: {
            type: 'realtime',
            instructions:
              'You are a friendly, helpful voice assistant on a phone call. ' +
              'Always respond in English unless the caller explicitly speaks another language. ' +
              'Keep responses concise and natural for spoken conversation. ' +
              'If asked about weather, call the get_weather function.',
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
            audio: {
              input: {
                format: {type: 'audio/pcm', rate: 24000},
                transcription: {model: 'whisper-1'},
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.8,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  /* Let OpenAI auto-create the next response on each user turn
                   * (create_response defaults to true) but do NOT let it
                   * cancel the in-progress response on barge-in. That hands
                   * barge-in cancellation to jambonz via cancelOnBargeIn
                   * above, demonstrating the #120 server-side cancel. */
                  interrupt_response: false,
                }
              },
              output: {
                format: {type: 'audio/pcm', rate: 24000},
                voice: 'alloy'
              }
            }
          }
        }
      })
      .hangup()
      .send();
  });
};

const onFinal = (session, logger, evt) => {
  logger.info(`got actionHook: ${JSON.stringify(evt)}`);

  if (['server failure', 'server error'].includes(evt.completion_reason)) {
    if (evt.error?.code === 'rate_limit_exceeded') {
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

const onEvent = (session, logger, evt) => {
  logger.info(`got eventHook: ${JSON.stringify(evt)}`);

  switch (evt.type) {
    /* #120: a response we solicited was not acknowledged within
     * responseTimeoutMs — the caller is hearing dead air. Because we set
     * cancelOnResponseTimeout:true, jambonz has already sent response.cancel to
     * free the turn, so the "active response in progress" slot is clear. Here
     * we recover by soliciting a fresh response via the llm:update command
     * (session.updateLlm), which is sent to OpenAI as a response.create. The
     * response uses the instructions/voice already set in session_update. */
    case 'response.timeout':
      logger.warn('response stalled; re-soliciting a response to recover from dead air');
      session.updateLlm({
        type: 'response.create',
        response: {
          instructions: 'Apologize briefly for the delay, then continue helping the caller.'
        }
      });
      break;

    /* caller barge-in. With interrupt_response:false set above, OpenAI will not
     * cancel the response itself; cancelOnBargeIn:true makes jambonz send
     * response.cancel so OpenAI stops generating audio nobody will hear. */
    case 'input_audio_buffer.speech_started':
      logger.info('caller barge-in detected; jambonz will cancel the in-progress response');
      break;

    default:
      break;
  }
};

const onToolCall = async(session, logger, evt) => {
  const {name, args, tool_call_id} = evt;
  const {location, scale} = args;

  logger.info({evt}, `got toolHook for ${name} with tool_call_id ${tool_call_id}`);

  try {
    /* first we need lat and long, then we can get the weather for that location */
    // eslint-disable-next-line max-len
    let url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    let res = await fetch(url);
    const geo = await res.json();

    if (!Array.isArray(geo.results) || 0 === geo.results.length) {
      throw new Error('location_not_found');
    }
    const {latitude: lat, longitude: lng, name: locName, timezone, population, country} = geo.results[0];

    logger.info({name: locName, country, lat, lng, timezone, population}, 'got response from geocoding API');

    // eslint-disable-next-line max-len
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m&temperature_unit=${scale}`;

    logger.info(`calling weather API with url: ${url}`);
    res = await fetch(url);
    const weather = await res.json();
    logger.info({weather}, 'got response from weather API');

    session.sendToolOutput(tool_call_id, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: tool_call_id,
        output: JSON.stringify(weather),
      }
    });

  } catch (err) {
    logger.info({err}, 'error calling geocoding or weather API');
    session.sendToolOutput(tool_call_id, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: tool_call_id,
        output: JSON.stringify({error: String(err)}),
      }
    });
  }
};

module.exports = service;
