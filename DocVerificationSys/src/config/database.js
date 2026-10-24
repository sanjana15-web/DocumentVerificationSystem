'use strict';

const mysql = require('mysql2/promise');
const config = require('./env');
const logger = require('../utils/logger');

let pool = null;

function createPool() {
  return mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    waitForConnections: true,
    connectionLimit: config.db.poolMax,
    queueLimit: 0,
    timezone: '+00:00',
    typeCast: function(field, next) {
      // Return TINYINT(1) as boolean
      if (field.type === 'TINY' && field.length === 1) {
        return field.string() === '1';
      }
      return next();
    },
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

async function query(sql, params) {
  const p = getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function transaction(fn) {
  const p = getPool();
  const conn = await p.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function testConnection() {
  const p = getPool();
  const conn = await p.getConnection();
  await conn.ping();
  conn.release();
  logger.info('Database connection established');
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, queryOne, transaction, testConnection, closePool };
