'use strict';

/**
 * Database migration runner.
 * Applies SQL migration files in order.
 * Safe to run multiple times — already-applied migrations are skipped.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config/env');
const { DOCUMENT_TYPES } = require('../document-types/registry');

async function runMigrations() {
  console.log('🗄  Running database migrations...');
  console.log(`   Host: ${config.db.host}:${config.db.port}`);
  console.log(`   Database: ${config.db.name}`);

  if (!/^[A-Za-z0-9_]+$/.test(config.db.name)) {
    throw new Error('DB_NAME may contain only letters, numbers, and underscores.');
  }

  const conn = await mysql.createConnection({
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.name,
    user:     config.db.user,
    password: config.db.password,
    multipleStatements: true,
    timezone: '+00:00',
  });

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace('.sql', '');

    // Check if already applied (the table may not exist yet for the very first migration)
    let alreadyApplied = false;
    try {
      const [rows] = await conn.query(
        `SELECT id FROM schema_migrations WHERE version = ? LIMIT 1`,
        [version]
      );
      alreadyApplied = rows.length > 0;
    } catch {
      // Table doesn't exist yet — first run
    }

    if (alreadyApplied) {
      console.log(`   ⏭  Skipping ${file} (already applied)`);
      continue;
    }

    console.log(`   ▶  Applying ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await conn.query(sql);
    console.log(`   ✅ Applied ${file}`);
  }

  for (const type of DOCUMENT_TYPES) {
    await conn.execute(
      `INSERT IGNORE INTO document_types (id, display_name, category, description, schema_version, fields_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [type.id, type.name, type.category, type.authenticity, type.schemaVersion, JSON.stringify(type.fields)]
    );
    const rules = [
      ...type.fields.flatMap(field => [
        ...(field.required ? [{
          id: `REQUIRED_${field.id.toUpperCase()}`,
          name: `Required field: ${field.label}`,
          requiresHuman: false,
        }] : []),
        ...(field.type === 'date' ? [{
          id: `DATE_${field.id.toUpperCase()}`,
          name: `Valid date: ${field.label}`,
          requiresHuman: false,
        }] : []),
        ...(field.type === 'decimal' ? [{
          id: `NUMBER_${field.id.toUpperCase()}`,
          name: `Numeric value: ${field.label}`,
          requiresHuman: false,
        }] : []),
        {
          id: `CONFIDENCE_${field.id.toUpperCase()}`,
          name: `OCR confidence: ${field.label}`,
          requiresHuman: true,
        },
      ]),
      { id: 'AUTHENTICITY_MANUAL_REVIEW', name: 'Authenticity requires human review', requiresHuman: true },
    ];
    if (type.id === 'invoice') {
      rules.push(
        { id: 'AMOUNT_CONSISTENCY', name: 'Invoice amount consistency', requiresHuman: false },
        { id: 'DUPLICATE_INVOICE', name: 'Potential duplicate invoice', requiresHuman: true },
        { id: 'PURCHASE_ORDER_REFERENCE', name: 'Purchase order reference comparison', requiresHuman: true }
      );
    }
    if (type.id === 'academic_marksheet') {
      rules.push(
        { id: 'MARKS_RANGE', name: 'Marks do not exceed maximum', requiresHuman: false },
        { id: 'PERCENTAGE_CONSISTENCY', name: 'Percentage matches marks', requiresHuman: false }
      );
    }
    for (const rule of rules) {
      await conn.execute(
        `INSERT IGNORE INTO verification_rules
         (id, document_type_id, rule_id, rule_name, rule_version, config_json, requires_human)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          require('crypto').randomUUID(), type.id, rule.id, rule.name, type.schemaVersion,
          JSON.stringify({ schemaVersion: type.schemaVersion }), rule.requiresHuman ? 1 : 0,
        ]
      );
    }
  }

  await conn.end();
  console.log('✅ Migrations complete.');
}

runMigrations().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
