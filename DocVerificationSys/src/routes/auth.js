'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const { authController, loginValidation, changePasswordValidation } = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { rateLimitHandler } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max:      config.security.rateLimitMaxLogin,
  handler:  rateLimitHandler,
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: true,
});

router.get('/login',  authController.showLogin);
router.post('/login', loginLimiter, loginValidation, authController.postLogin);
router.post('/logout', requireAuth, authController.postLogout);

router.get('/change-password',  requireAuth, authController.showChangePassword);
router.post('/change-password', requireAuth, changePasswordValidation, authController.postChangePassword);

module.exports = router;
