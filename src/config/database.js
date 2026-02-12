const { Pool } = require('pg');
const config = require('./env');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug({ query: text.substring(0, 80), duration, rows: result.rowCount }, 'DB query');
    return result;
  } catch (err) {
    logger.error({ err, query: text.substring(0, 80) }, 'DB query error');
    throw err;
  }
}

async function getClient() {
  return pool.connect();
}

async function healthCheck() {
  try {
    const result = await pool.query('SELECT NOW()');
    return { status: 'ok', timestamp: result.rows[0].now };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

module.exports = { pool, query, getClient, healthCheck };
