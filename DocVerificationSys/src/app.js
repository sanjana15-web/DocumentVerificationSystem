'use strict';

require('dotenv').config();

const express       = require('express');
const path          = require('path');
const helmet        = require('helmet');
const morgan        = require('morgan');
const cookieParser  = require('cookie-parser');
const session       = require('express-session');
const MySQLStore    = require('express-mysql-session')(session);
const { doubleCsrf } = require('csrf-csrf');
const rateLimit = require('express-rate-limit');

const config   = require('./config/env');
const db       = require('./config/database');
const logger   = require('./utils/logger');
const { loadUser } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const authService = require('./services/authService');
const JobProcessor = require('./services/jobProcessor');

// Routes
const authRoutes       = require('./routes/auth');
const submissionRoutes = require('./routes/submissions');
const adminRoutes      = require('./routes/admin');
const miscRoutes       = require('./routes/misc');

const app = express();

// ─── Trust Proxy ──────────────────────────────────────────────────────────────
if (config.security.trustProxy) app.set('trust proxy', 1);

// ─── View Engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
Object.assign(app.locals, require('./utils/viewHelpers'));

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  referrerPolicy:  { policy: 'same-origin' },
  frameguard:      { action: 'deny' },
  hsts:            config.isProd ? { maxAge: 31536000 } : false,
}));

// ─── Request Logging ──────────────────────────────────────────────────────────
app.use(morgan(config.isDev ? 'dev' : 'combined', {
  stream: { write: msg => logger.http(msg.trim()) },
}));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ─── Session Store ────────────────────────────────────────────────────────────
const sessionStore = config.isTest ? new session.MemoryStore() : new MySQLStore({
    host:     config.db.host,
    port:     config.db.port,
    user:     config.db.user,
    password: config.db.password,
    database: config.db.name,
    createDatabaseTable: true,
    schema: {
      tableName:       'sessions',
      columnNames: {
        session_id: 'session_id',
        expires:    'expires',
        data:       'data',
      },
    },
    clearExpired:    true,
    checkExpirationInterval: 900000,
  }, db.getPool());

app.use(session({
  store:  sessionStore,
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  name:   'dvs.sid',
  cookie: {
    httpOnly: true,
    secure:   config.security.cookieSecure,
    sameSite: 'lax',
    maxAge:   config.session.maxAgeMs,
  },
}));

app.use((req, res, next) => {
  if (!req.session.csrfInitialized) req.session.csrfInitialized = true;
  next();
});

// ─── CSRF Protection ─────────────────────────────────────────────────────────
const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret:    () => config.session.secret,
  getSessionIdentifier: req => req.session.id,
  cookieName:   config.isProd ? '__Host-dvs.csrf' : 'dvs.csrf',
  cookieOptions: { sameSite: 'lax', secure: config.security.cookieSecure, path: '/' },
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getCsrfTokenFromRequest: req => {
    const headerToken = req.headers['x-csrf-token'];
    if (typeof headerToken === 'string') return headerToken;
    return typeof req.body?._csrf === 'string' ? req.body._csrf : undefined;
  },
});

app.use(doubleCsrfProtection);

// Make CSRF token available to all templates
app.use((req, res, next) => {
  try {
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  } catch (err) { next(err); }
});

// ─── Load Authenticated User ──────────────────────────────────────────────────
app.use(loadUser);

// ─── Template Locals ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.appName = config.appName;
  res.locals.isDev   = config.isDev;
  res.locals.aiEnabled = config.ai.enabled;
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.redirect('/auth/login');
});

app.use('/auth',        authRoutes);
app.use('/submissions', submissionRoutes);
app.get('/dashboard',   require('./middleware/auth').requireAuth, require('./controllers/submissionController').showDashboard);
app.use('/admin',       adminRoutes);
app.use('/',            miscRoutes);

// ─── Error Handlers ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
async function startServer() {
  // Test DB connection
  await db.testConnection();

  // Provision initial admin on first run
  await authService.provisionInitialAdmin();

  // Start job processor
  const jobProcessor = new JobProcessor();
  jobProcessor.start();

  const server = app.listen(config.port, () => {
    logger.info(`🚀 ${config.appName} running at http://localhost:${config.port} [${config.env}]`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    jobProcessor.stop();
    server.close(async () => {
      await db.closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

if (require.main === module) {
  startServer().catch(err => {
    logger.error('Failed to start server', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { app, startServer };
