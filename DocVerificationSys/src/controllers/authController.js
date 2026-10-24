'use strict';

const { body, validationResult } = require('express-validator');
const authService = require('../services/authService');
const { auditRepo } = require('../repositories/auditRepository');
const logger = require('../utils/logger');

// ─── Validation rules ──────────────────────────────────────────────────────────
const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
];

const changePasswordValidation = [
  body('current_password').notEmpty().withMessage('Current password required'),
  body('new_password').isLength({ min: 10 }).withMessage('New password must be at least 10 characters'),
  body('confirm_password').custom((val, { req }) => {
    if (val !== req.body.new_password) throw new Error('Passwords do not match');
    return true;
  }),
];

// ─── Controller ───────────────────────────────────────────────────────────────
const authController = {
  showLogin(req, res) {
    if (req.session?.userId) return res.redirect('/dashboard');
    res.render('auth/login', {
      title: 'Sign In',
      user: null,
      errors: [],
      reason: req.query.reason || null,
    });
  },

  async postLogin(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).render('auth/login', {
          title: 'Sign In',
          user: null,
          errors: errors.array(),
          reason: null,
        });
      }

      const { email, password } = req.body;
      const user = await authService.login(email, password);
      const requestedReturnTo = req.session.returnTo;
      const returnTo = typeof requestedReturnTo === 'string' &&
        requestedReturnTo.startsWith('/') && !requestedReturnTo.startsWith('//')
        ? requestedReturnTo : '/dashboard';

      // Session fixation prevention — regenerate session id after login
      await new Promise((resolve, reject) =>
        req.session.regenerate(err => err ? reject(err) : resolve())
      );

      req.session.userId = user.id;
      req.session.role   = user.role;

      await auditRepo.log({
        actorId:    user.id,
        actorEmail: user.email,
        action:     'auth.login',
        entityType: 'user',
        entityId:   user.id,
        ipAddress:  req.ip,
        userAgent:  req.headers['user-agent'],
      });

      res.redirect(returnTo);
    } catch (err) {
      if (err.isOperational) {
        return res.status(err.statusCode || 400).render('auth/login', {
          title: 'Sign In',
          user: null,
          errors: [{ msg: err.message }],
          reason: null,
        });
      }
      next(err);
    }
  },

  async postLogout(req, res, next) {
    try {
      const userId = req.session?.userId;
      const email  = req.user?.email;

      await new Promise((resolve, reject) =>
        req.session.destroy(err => err ? reject(err) : resolve())
      );

      if (userId) {
        await auditRepo.log({
          actorId:    userId,
          actorEmail: email,
          action:     'auth.logout',
          entityType: 'user',
          entityId:   userId,
          ipAddress:  req.ip,
        });
      }

      res.clearCookie('dvs.sid');
      res.redirect('/auth/login');
    } catch (err) { next(err); }
  },

  showChangePassword(req, res) {
    res.render('auth/change-password', {
      title: 'Change Password',
      user: req.user,
      errors: [],
      required: req.query.required === 'true',
    });
  },

  async postChangePassword(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).render('auth/change-password', {
          title: 'Change Password',
          user: req.user,
          errors: errors.array(),
          required: req.query.required === 'true',
        });
      }

      const { current_password, new_password } = req.body;
      await authService.changePassword(req.user.id, current_password, new_password);

      await auditRepo.log({
        actorId:    req.user.id,
        actorEmail: req.user.email,
        action:     'auth.password_changed',
        entityType: 'user',
        entityId:   req.user.id,
        ipAddress:  req.ip,
      });

      req.session.flash = { type: 'success', message: 'Password changed successfully.' };
      res.redirect('/dashboard');
    } catch (err) {
      if (err.isOperational) {
        return res.status(400).render('auth/change-password', {
          title: 'Change Password',
          user: req.user,
          errors: [{ msg: err.message }],
          required: false,
        });
      }
      next(err);
    }
  },
};

module.exports = { authController, loginValidation, changePasswordValidation };
