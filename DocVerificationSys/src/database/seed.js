'use strict';

/**
 * Development-only seed script.
 * Creates test users for all four roles.
 *
 * NEVER run this against a production database.
 * Usage:  node src/database/seed.js
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const config = require('../config/env');

if (config.isProd) {
  console.error('❌ Seed script must NOT be run in production (NODE_ENV=production).');
  process.exit(1);
}

const DEV_PASSWORD = 'DevPass123!';

const USERS = [
  { id: uuidv4(), email: 'admin@docverify.dev',     full_name: 'System Admin',     role: 'admin' },
  { id: uuidv4(), email: 'reviewer@docverify.dev',  full_name: 'Alice Reviewer',   role: 'reviewer' },
  { id: uuidv4(), email: 'approver@docverify.dev',  full_name: 'Bob Approver',     role: 'approver' },
  { id: uuidv4(), email: 'submitter@docverify.dev', full_name: 'Carol Submitter',  role: 'submitter' },
];

async function seed() {
  console.log('🌱 Seeding development users...');
  console.log(`   Dev password for all users: ${DEV_PASSWORD}`);
  console.log('   ⚠  These are DEV-ONLY accounts. Do NOT use in production.\n');

  const hash = await bcrypt.hash(DEV_PASSWORD, config.security.bcryptRounds);

  for (const user of USERS) {
    const existing = await db.queryOne(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [user.email]
    );
    if (existing) {
      console.log(`   ⏭  ${user.email} already exists — skipping`);
      continue;
    }

    await db.query(
      `INSERT INTO users (id, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [user.id, user.email, hash, user.full_name, user.role]
    );
    console.log(`   ✅ Created ${user.role}: ${user.email}`);
  }

  console.log('\n✅ Seed complete.');
  await db.closePool();
}

seed().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
