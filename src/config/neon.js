const { Pool } = require('pg');
const config = require('./env');
const logger = require('../utils/logger');

let neonPool = null;

function getNeonPool() {
  if (!neonPool && config.neonDatabaseUrl) {
    neonPool = new Pool({
      connectionString: config.neonDatabaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    neonPool.on('error', (err) => {
      logger.error({ err }, 'Unexpected Neon database pool error');
    });
  }
  return neonPool;
}

async function query(text, params) {
  const pool = getNeonPool();
  if (!pool) {
    throw new Error('Neon database not configured');
  }
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug({ query: text.substring(0, 80), duration, rows: result.rowCount }, 'Neon DB query');
    return result;
  } catch (err) {
    logger.error({ err, query: text.substring(0, 80) }, 'Neon DB query error');
    throw err;
  }
}

async function healthCheck() {
  try {
    const pool = getNeonPool();
    if (!pool) return { status: 'not_configured' };
    const result = await pool.query('SELECT NOW()');
    return { status: 'ok', timestamp: result.rows[0].now };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

module.exports = { query, healthCheck, getNeonPool };
