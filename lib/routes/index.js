module.exports = ({logger, makeService}) => {
  require('./openai-s2s')({logger, makeService});
};

