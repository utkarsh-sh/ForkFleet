const { createLogger, format, transports } = require('winston');
const { combine, timestamp, errors, json, colorize, simple } = format;

const isProd = process.env.NODE_ENV === 'production';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp(),
    errors({ stack: true }),
    json()
  ),
  defaultMeta: { service: 'forkfleet-api' },
  transports: [
    new transports.Console({
      format: isProd
        ? combine(timestamp(), json())
        : combine(colorize(), simple()),
    }),
    // In production, add file or cloud transport here
    // new transports.File({ filename: 'logs/error.log', level: 'error' }),
  ],
});

module.exports = logger;
