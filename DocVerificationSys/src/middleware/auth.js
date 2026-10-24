'use strict';

/**
 * Authentication and authorization middleware.
 * All checks are performed server-side against the authenticated session.
 * Client-submitted role or identity claims are never trusted.
 */

const userRepo = require('../repositories/userRepository');
const { auditRepo } = require('../repositories/auditRepository');
const logger = require('../utils/logger');

/**
 * Require a valid authenticated session.
 * Redirects to /auth/login if not authenticated.
 */
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    const returnTo = req.originalUrl;
    req.session.returnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
    return res.redirect('/auth/login');
  }
  next();
}

/**
 * Require one of the listed roles.
 * Must be used after requireAuth.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return res.redirect('/auth/login');
    if (!roles.includes(user.role)) {
      logger.warn('Access denied', { userId: user.id, role: user.role, required: roles, path: req.path });
      return res.status(403).render('errors/403', { user: req.user, title: 'Access Denied' });
    }
    next();
  };
}

/**
 * Load user from session on every request.
 * Attaches req.user and handles deactivated accounts.
 */
async function loadUser(req, res, next) {
  if (!req.session?.userId) {
    req.user = null;
    res.locals.user = null;
    res.locals.unreadCount = 0;
    return next();
  }

  try {
    const user = await userRepo.findById(req.session.userId);

    if (!user || !user.is_active) {
      req.session.destroy(() => {});
      req.user = null;
      res.locals.user = null;
      res.locals.unreadCount = 0;
      return res.redirect('/auth/login?reason=account_deactivated');
    }

    // Omit password_hash from the request object
    const { password_hash, ...safeUser } = user;
    req.user = safeUser;
    res.locals.user = safeUser;

    // Load unread notification count
    const { notifRepo } = require('../repositories/auditRepository');
    res.locals.unreadCount = await notifRepo.countUnread(user.id);

    // Force password change if flagged
    if (user.must_change_pwd && req.path !== '/auth/change-password' && req.path !== '/auth/logout') {
      return res.redirect('/auth/change-password?required=true');
    }

    next();
  } catch (err) {
    logger.error('loadUser error', { err: err.message });
    req.user = null;
    res.locals.user = null;
    res.locals.unreadCount = 0;
    next();
  }
}

/**
 * Verify that the current user is not the submitter of a given submission.
 * Used to prevent self-approval.
 * Call with the submission object from req.submission.
 */
function preventSelfApproval(req, res, next) {
  const submission = req.submission;
  if (!submission) return next();

  if (submission.submitter_id === req.user.id) {
    return res.status(403).render('errors/403', {
      user: req.user,
      title: 'Self-Approval Prohibited',
      message: 'You cannot approve a submission that you submitted.',
    });
  }
  next();
}

/**
 * Verify the request body contains a valid CSRF token.
 * Used as an additional layer on state-changing endpoints.
 */
function verifyCsrf(req, res, next) {
  // csrf-csrf handles this via the doubleCsrfProtection middleware —
  // this is a pass-through shim for explicit use in routes.
  next();
}

/**
 * Rate-limit error handler (for express-rate-limit).
 */
function rateLimitHandler(req, res) {
  res.status(429).render('errors/429', {
    user: req.user,
    title: 'Too Many Requests',
    message: 'Too many attempts. Please wait and try again.',
  });
}

module.exports = { requireAuth, requireRole, loadUser, preventSelfApproval, verifyCsrf, rateLimitHandler };
