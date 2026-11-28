/**
 * RecVerse Server Logger
 * Centralized logging with categories, levels, and file/console output
 */

import fs from 'fs';
import path from 'path';
import config from './verse-config.js';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CURRENT_LEVEL = LOG_LEVELS[config.logging.level.toLowerCase()] ?? LOG_LEVELS.info;

// Ensure log directory exists
const logDir = path.dirname(config.logging.file);
if (logDir && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

let logStream = null;
if (config.logging.file) {
  logStream = fs.createWriteStream(config.logging.file, { flags: 'a' });
}

function formatMessage(level, category, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const levelStr = level.toUpperCase().padEnd(5);
  const catStr = category ? `[${category}]` : '';
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${levelStr} [PID:${pid}] ${catStr} ${message}${metaStr}`;
}

function writeLog(level, category, message, meta = {}) {
  const formatted = formatMessage(level, category, message, meta);

  // Console output
  if (config.logging.console) {
    const colors = {
      debug: '\x1b[36m', // cyan
      info: '\x1b[32m',  // green
      warn: '\x1b[33m',  // yellow
      error: '\x1b[31m', // red
      reset: '\x1b[0m',
    };
    console.log(`${colors[level] || ''}${formatted}${colors.reset}`);
  }

  // File output
  if (logStream && !logStream.destroyed) {
    logStream.write(formatted + '\n');
  }
}

function maskSensitive(data) {
  if (typeof data !== 'object' || data === null) return data;
  const masked = { ...data };
  const sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'cookie', 'accesstoken', 'refreshtoken', 'jwt', 'apikey', 'apisecret'];
  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(k => lowerKey.includes(k))) {
      masked[key] = '***MASKED***';
    } else if (typeof masked[key] === 'object' && masked[key] !== null) {
      masked[key] = maskSensitive(masked[key]);
    }
  }
  return masked;
}

const logger = {
  debug: (category, message, meta = {}) => {
    if (CURRENT_LEVEL <= LOG_LEVELS.debug) {
      writeLog('debug', category, message, maskSensitive(meta));
    }
  },

  info: (category, message, meta = {}) => {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) {
      writeLog('info', category, message, maskSensitive(meta));
    }
  },

  warn: (category, message, meta = {}) => {
    if (CURRENT_LEVEL <= LOG_LEVELS.warn) {
      writeLog('warn', category, message, maskSensitive(meta));
    }
  },

  error: (category, message, meta = {}) => {
    if (CURRENT_LEVEL <= LOG_LEVELS.error) {
      writeLog('error', category, message, maskSensitive(meta));
    }
  },

  // Convenience methods for common categories
  http: (message, meta = {}) => logger.info('HTTP', message, meta),
  db: (message, meta = {}) => logger.info('DB', message, meta),
  auth: (message, meta = {}) => logger.info('AUTH', message, meta),
  patch: (message, meta = {}) => logger.info('PATCH', message, meta),
  network: (message, meta = {}) => logger.info('NETWORK', message, meta),
  photon: (message, meta = {}) => logger.info('PHOTON', message, meta),
  econ: (message, meta = {}) => logger.info('ECON', message, meta),
  chat: (message, meta = {}) => logger.info('CHAT', message, meta),
  match: (message, meta = {}) => logger.info('MATCH', message, meta),
  rooms: (message, meta = {}) => logger.info('ROOMS', message, meta),
  accounts: (message, meta = {}) => logger.info('ACCOUNTS', message, meta),
  api: (message, meta = {}) => logger.info('API', message, meta),
  ns: (message, meta = {}) => logger.info('NS', message, meta),
  build: (message, meta = {}) => logger.info('BUILD', message, meta),
  startup: (message, meta = {}) => logger.info('STARTUP', message, meta),
  shutdown: (message, meta = {}) => logger.info('SHUTDOWN', message, meta),
};

process.on('exit', () => {
  if (logStream && !logStream.destroyed) {
    logStream.end();
  }
});

export default logger;