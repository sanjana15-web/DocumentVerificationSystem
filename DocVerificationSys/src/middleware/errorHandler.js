'use strict';

const logger = require('../utils/logger');

/**
 * Centralized error handler for Express.
 * Must be the last middleware registered.
 */
function errorHandler(err, req, res, next) {
  // Multer errors
  const multer = require('multer');
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File is too large. Maximum allowed size is ${require('../config/env').storage.maxFileSizeMb} MB.`
      : `Upload error: ${err.message}`;
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(400).json({ error: msg });
    }
    return res.status(400).render('errors/400', { user: req.user, title: 'Upload Error', message: msg });
  }

  // CSRF token errors
  if (err.code === 'EBADCSRFTOKEN' || err.message === 'invalid csrf token') {
    logger.warn('CSRF validation failed', { path: req.path, ip: req.ip });
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Invalid or expired form token. Please reload and try again.' });
    }
    return res.status(403).render('errors/403', {
      user: req.user,
      title: 'Session Expired',
      message: 'Your form session expired. Please go back and try again.',
    });
  }

  // Log the actual error (never expose internals to client)
  logger.error('Unhandled error', {
    err: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
  });

  const statusCode = err.statusCode || err.status || 500;
  const message    = err.isOperational
    ? err.message
    : 'An unexpected error occurred. Please try again later.';

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(statusCode).json({ error: message });
  }

  return res.status(statusCode).render('errors/500', {
    user: req.user,
    title: 'Server Error',
    message,
  });
}

/**
 * Operational error class — safe to expose the message to the user.
 */
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode   = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 404 handler — must be registered after all routes.
 */
function notFoundHandler(req, res) {
  res.status(404).render('errors/404', {
    user: req.user,
    title: 'Page Not Found',
    message: `The page "${req.path}" could not be found.`,
  });
}

module.exports = { errorHandler, notFoundHandler, AppError };
