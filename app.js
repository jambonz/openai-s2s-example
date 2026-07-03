const {createServer} = require('http');
const {createEndpoint} = require('@jambonz/sdk/websocket');
const server = createServer();
const logger = require('pino')({level: process.env.LOGLEVEL || 'info'});
const port = process.env.WS_PORT || 3000;

const makeService = createEndpoint({
  server,
  port,
  /* Declaring env vars surfaces them in the jambonz portal for this
   * application; at runtime they arrive on session.data.env_vars. The route
   * falls back to process.env.OPENAI_API_KEY for local development. */
  envVars: {
    OPENAI_API_KEY: {
      type: 'string',
      description: 'OpenAI API key with access to the Realtime API',
      required: false,
      obscure: true,
    },
  },
});

require('./lib/routes')({logger, makeService});

server.listen(port, () => {
  logger.info(`jambonz websocket server listening at http://localhost:${port}`);
});
