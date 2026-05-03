const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'forkfleet',
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  min:      parseInt(process.env.DB_POOL_MIN) || 2,
  max:      parseInt(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

pool.on('connect', () => {
  logger.info('New PostgreSQL client connected');
});

// ── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Run a single query.
 * @param {string} text  SQL string with $1, $2 placeholders
 * @param {Array}  params
 */
const query = (text, params) => pool.query(text, params);

/**
 * Acquire a client from the pool for use inside a transaction.
 * Usage:
 *   const client = await db.getClient();
 *   try {
 *     await client.query('BEGIN');
 *     ...
 *     await client.query('COMMIT');
 *   } catch (e) {
 *     await client.query('ROLLBACK');
 *     throw e;
 *   } finally {
 *     client.release();
 *   }
 */
const getClient = () => pool.connect();

/**
 * Run a callback inside a transaction. Automatically commits or rolls back.
 * @param {Function} fn  async (client) => result
 */
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, withTransaction, pool };
