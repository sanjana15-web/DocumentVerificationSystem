'use strict';

require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name, defaultValue = '') {
  return process.env[name] || defaultValue;
}

function optionalInt(name, defaultValue) {
  const val = process.env[name];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer, got: ${val}`);
  return parsed;
}

function optionalBool(name, defaultValue = false) {
  const val = process.env[name];
  if (!val) return defaultValue;
  return val.toLowerCase() === 'true' || val === '1';
}

const config = {
  env: optional('NODE_ENV', 'development'),
  isDev: optional('NODE_ENV', 'development') === 'development',
  isTest: optional('NODE_ENV', 'development') === 'test',
  isProd: optional('NODE_ENV', 'development') === 'production',

  port: optionalInt('PORT', 3000),
  appUrl: optional('APP_URL', 'http://localhost:3000'),
  appName: optional('APP_NAME', 'DocVerify'),

  session: {
    secret: optional('SESSION_SECRET', 'dev-only-not-for-production-change-me'),
    maxAgeMs: optionalInt('SESSION_MAX_AGE_MS', 8 * 60 * 60 * 1000), // 8 hours
  },

  db: {
    host: optional('DB_HOST', 'localhost'),
    port: optionalInt('DB_PORT', 3306),
    name: optional('DB_NAME', 'docverify'),
    user: optional('DB_USER', 'root'),
    password: optional('DB_PASSWORD', ''),
    poolMin: optionalInt('DB_POOL_MIN', 2),
    poolMax: optionalInt('DB_POOL_MAX', 10),
  },

  storage: {
    path: optional('STORAGE_PATH', './storage/uploads'),
    maxFileSizeMb: optionalInt('MAX_FILE_SIZE_MB', 10),
    maxPages: optionalInt('MAX_PAGES', 50),
  },

  ocr: {
    url: optional('OCR_SERVICE_URL', 'http://localhost:8000'),
    apiKey: optional('OCR_SERVICE_API_KEY', ''),
    timeoutMs: optionalInt('OCR_TIMEOUT_MS', 60000),
  },

  ai: {
    provider: optional('AI_PROVIDER', 'gemini').toLowerCase(),
    geminiApiKey: optional('GEMINI_API_KEY', ''),
    geminiModel: optional('GEMINI_MODEL', 'gemini-2.5-flash'),
    geminiFallbackModel: optional('GEMINI_FALLBACK_MODEL', 'gemini-3.5-flash'),
    ollamaFallbackEnabled: optionalBool('OLLAMA_FALLBACK_ENABLED', true),
    ollamaModel: optional('OLLAMA_MODEL', 'qwen2.5:3b'),
    timeoutMs: optionalInt('AI_TIMEOUT_MS', 30000),
    get enabled() {
      return config.ai.provider === 'ollama' ||
        Boolean(config.ai.geminiApiKey) ||
        config.ai.ollamaFallbackEnabled;
    },
  },

  security: {
    bcryptRounds: optionalInt('BCRYPT_ROUNDS', 12),
    rateLimitWindowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    rateLimitMaxLogin: optionalInt('RATE_LIMIT_MAX_LOGIN', 10),
    cookieSecure: optionalBool('COOKIE_SECURE', false),
    trustProxy: optionalBool('TRUST_PROXY', false),
  },

  email: {
    host: optional('SMTP_HOST', ''),
    port: optionalInt('SMTP_PORT', 587),
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', ''),
    get enabled() { return Boolean(config.email.host && config.email.user); },
  },
};

if (!['gemini', 'ollama'].includes(config.ai.provider)) {
  throw new Error('AI_PROVIDER must be either "gemini" or "ollama".');
}

if (config.isProd) {
  if (config.session.secret.length < 32 || config.session.secret === 'dev-only-not-for-production-change-me') {
    throw new Error('Production requires a SESSION_SECRET of at least 32 characters.');
  }
  if (!config.security.cookieSecure) {
    throw new Error('Production requires COOKIE_SECURE=true and HTTPS.');
  }
}

module.exports = config;
