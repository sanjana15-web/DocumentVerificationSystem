'use strict';

const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const userRepo = require('../repositories/userRepository');
const { auditRepo } = require('../repositories/auditRepository');
const config = require('../config/env');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { AppError } = require('../middleware/errorHandler');
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('DocVerify timing-only password', config.security.bcryptRounds);

class AuthService {
  /**
   * Authenticate a user. Returns the user object on success.
   * Throws AppError with a generic message on failure (never reveals which field was wrong).
   */
  async login(email, password) {
    if (!email || !password) throw new AppError('Email and password are required.', 400);

    const user = await userRepo.findByEmail(email.toLowerCase().trim());

    // Use constant-time comparison even when user not found (prevent timing oracle)
    const hash  = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const match = await bcrypt.compare(password, hash);

    if (!match || !user) {
      throw new AppError('Invalid email or password.', 401);
    }

    if (!user.is_active) {
      throw new AppError('Your account has been deactivated. Contact an administrator.', 403);
    }

    await userRepo.updateLastLogin(user.id);

    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Change a user's password.
   */
  async changePassword(userId, currentPassword, newPassword) {
    if (!currentPassword || !newPassword) throw new AppError('Both current and new password are required.');

    const user = await userRepo.findById(userId);
    if (!user) throw new AppError('User not found.', 404);

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) throw new AppError('Current password is incorrect.');

    this._validatePasswordStrength(newPassword);

    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    await userRepo.updatePassword(userId, hash);
  }

  /**
   * Set a password for a user (admin or first-run use only).
   */
  async setPassword(userId, newPassword) {
    this._validatePasswordStrength(newPassword);
    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    await userRepo.updatePassword(userId, hash);
  }

  /**
   * Create an initial admin account at first run.
   * Returns the generated password so it can be printed once.
   */
  async provisionInitialAdmin() {
    const email = (process.env.ADMIN_EMAIL || 'admin@docverify.local').toLowerCase().trim();
    const existing = await userRepo.findByEmail(email);
    if (existing) return null; // Already provisioned

    const password = this._generatePassword();
    const hash     = await bcrypt.hash(password, config.security.bcryptRounds);

    await userRepo.create({
      email,
      passwordHash: hash,
      fullName: 'System Administrator',
      role: 'admin',
      isActive: true,
      mustChangePwd: true,
    });

    logger.warn(`\n${'='.repeat(60)}\n  INITIAL ADMIN ACCOUNT CREATED\n  Email:    ${email}\n  Password: ${password}\n  Change this password immediately after first login.\n${'='.repeat(60)}\n`);
    return { email, password };
  }

  _validatePasswordStrength(password) {
    if (password.length < 10) throw new AppError('Password must be at least 10 characters.');
    if (!/[A-Z]/.test(password)) throw new AppError('Password must contain at least one uppercase letter.');
    if (!/[a-z]/.test(password)) throw new AppError('Password must contain at least one lowercase letter.');
    if (!/[0-9]/.test(password)) throw new AppError('Password must contain at least one number.');
  }

  _generatePassword() {
    const groups = [
      'ABCDEFGHJKLMNPQRSTUVWXYZ',
      'abcdefghjkmnpqrstuvwxyz',
      '23456789',
      '!@#$%',
    ];
    const chars = groups.join('');
    const password = groups.map(group => group[crypto.randomInt(group.length)]);
    for (let i = password.length; i < 24; i++) password.push(chars[crypto.randomInt(chars.length)]);
    for (let i = password.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [password[i], password[j]] = [password[j], password[i]];
    }
    return password.join('');
  }
}

module.exports = new AuthService();
