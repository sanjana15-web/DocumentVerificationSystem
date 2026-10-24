'use strict';

const { createLogger, format, transports } = require('winston');
const config = require('../config/env');

const logger = createLogger({
  level: config.isDev ? 'debug' : 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'docverify' },
  transports: [
    new transports.Console({
      format: config.isDev
        ? format.combine(
            format.colorize(),
            format.printf(({ timestamp, level, message, ...meta }) => {
              const extra = Object.keys(meta).length > 1
                ? ' ' + JSON.stringify(meta)
                : '';
              return `${timestamp} ${level}: ${message}${extra}`;
            })
          )
        : format.json(),
    }),
  ],
});

// In production also write to file
if (config.isProd) {
  logger.add(new transports.File({ filename: 'logs/error.log', level: 'error' }));
  logger.add(new transports.File({ filename: 'logs/combined.log' }));
}

module.exports = logger;
