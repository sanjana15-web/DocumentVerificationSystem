'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

class UserRepository {
  async findById(id) {
    return db.queryOne(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [id]
    );
  }

  async findByEmail(email) {
    return db.queryOne(
      'SELECT * FROM users WHERE email = ? LIMIT 1',
      [email]
    );
  }

  async findAll({ role, isActive, search, page = 1, limit = 50 } = {}) {
    const conditions = [];
    const params = [];

    if (role) { conditions.push('role = ?'); params.push(role); }
    if (isActive !== undefined) { conditions.push('is_active = ?'); params.push(isActive ? 1 : 0); }
    if (search) {
      conditions.push('(full_name LIKE ? OR email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const rows = await db.query(
      `SELECT id, email, full_name, role, is_active, must_change_pwd, last_login_at, created_at, updated_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [{ total }] = await db.query(
      `SELECT COUNT(*) AS total FROM users ${where}`,
      params
    );

    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async create({ email, passwordHash, fullName, role = 'submitter', isActive = true, mustChangePwd = false }) {
    const id = uuidv4();
    await db.query(
      `INSERT INTO users (id, email, password_hash, full_name, role, is_active, must_change_pwd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, email.toLowerCase().trim(), passwordHash, fullName.trim(), role, isActive ? 1 : 0, mustChangePwd ? 1 : 0]
    );
    return this.findById(id);
  }

  async updateLastLogin(id) {
    await db.query(
      'UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?',
      [id]
    );
  }

  async updatePassword(id, passwordHash) {
    await db.query(
      'UPDATE users SET password_hash = ?, must_change_pwd = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [passwordHash, id]
    );
  }

  async updateRole(id, role) {
    await db.query(
      'UPDATE users SET role = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [role, id]
    );
  }

  async setActive(id, isActive) {
    await db.query(
      'UPDATE users SET is_active = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [isActive ? 1 : 0, id]
    );
  }

  async update(id, { fullName, email, role, isActive, mustChangePwd }) {
    const sets = [];
    const params = [];

    if (fullName    !== undefined) { sets.push('full_name = ?');     params.push(fullName); }
    if (email       !== undefined) { sets.push('email = ?');         params.push(email.toLowerCase().trim()); }
    if (role        !== undefined) { sets.push('role = ?');          params.push(role); }
    if (isActive    !== undefined) { sets.push('is_active = ?');     params.push(isActive ? 1 : 0); }
    if (mustChangePwd !== undefined) { sets.push('must_change_pwd = ?'); params.push(mustChangePwd ? 1 : 0); }

    if (!sets.length) return;
    sets.push('updated_at = UTC_TIMESTAMP()');
    params.push(id);

    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async countByRole() {
    return db.query(
      'SELECT role, COUNT(*) AS count, SUM(is_active) AS active FROM users GROUP BY role'
    );
  }
}

module.exports = new UserRepository();
