/**
 * Database Adapter
 * Provides a unified interface for both SQLite and PostgreSQL
 */

import sqlite3 from 'sqlite3';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import config from '../../verse-config.js';
import logger from '../../verse-logger.js';

let db = null;
let pgPool = null;

export async function getDb() {
  if (db) return Promise.resolve(db);

  const dbClient = config.database.client;

  if (dbClient === 'pg') {
    return initPostgreSQL();
  } else {
    return initSQLite();
  }
}

function initSQLite() {
  return new Promise((resolve, reject) => {
    const dbPath = config.database.path;
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) {
        logger.error('DB', 'Failed to open database', { error: err.message });
        reject(err);
        return;
      }

      // Enable WAL mode for better concurrency
      db.run('PRAGMA journal_mode = WAL', (err) => {
        if (err) logger.warn('DB', 'Failed to set WAL mode', { error: err.message });
      });

      db.run('PRAGMA foreign_keys = ON', (err) => {
        if (err) logger.warn('DB', 'Failed to enable foreign keys', { error: err.message });
      });

      db.run('PRAGMA synchronous = NORMAL', (err) => {
        if (err) logger.warn('DB', 'Failed to set synchronous', { error: err.message });
      });

      db.run('PRAGMA cache_size = -32768', (err) => {
        if (err) logger.warn('DB', 'Failed to set cache size', { error: err.message });
      });

      db.run('PRAGMA temp_store = MEMORY', (err) => {
        if (err) logger.warn('DB', 'Failed to set temp store', { error: err.message });
      });

      logger.db('Database connected', { path: dbPath });
      resolve(db);
    });
  });
}

async function initPostgreSQL() {
  const dbConfig = config.database;

  let connectionString = '';

  if (config.database.databaseUrl) {
    connectionString = config.database.databaseUrl;
  } else {
    connectionString = `postgresql://${dbConfig.pgUser}:${dbConfig.pgPassword}@${dbConfig.pgHost}:${dbConfig.pgPort}/${dbConfig.pgDatabase}`;
    if (dbConfig.pgSsl) {
      connectionString += '?ssl=true';
    }
  }

  pgPool = new Pool({
    connectionString,
    max: dbConfig.pgMaxConnections,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: config.database.pgSsl ? { rejectUnauthorized: false } : false,
  });

  try {
    await pgPool.query('SELECT 1');
    logger.db('PostgreSQL connected', { host: config.database.pgHost });
  } catch (err) {
    logger.error('DB', 'Failed to connect to PostgreSQL', { error: err.message });
    throw err;
  }

  // Wrap pg Pool to match sqlite3-like interface
  db = createPgWrapper(pgPool);
  return db;
}

function createPgWrapper(pool) {
  return {
    prepare: (sql) => {
      let paramIndex = 1;
      const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

      return {
        run: async (...params) => {
          const result = await pool.query(pgSql, params);
          return { lastID: result.rows[0]?.id, changes: result.rowCount };
        },
        get: async (...params) => {
          const result = await pool.query(pgSql, params);
          return result.rows[0] || null;
        },
        all: async (...params) => {
          const result = await pool.query(pgSql, params);
          return result.rows;
        },
        run: async (sql, params = []) => {
          const pgSql = sql.replace(/\?/g, (_, i) => `$${i + 1}`);
          const result = await pool.query(pgSql, params);
          return { lastID: result.rows[0]?.id, changes: result.rowCount };
        },
        get: async (sql, params = []) => {
          const pgSql = sql.replace(/\?/g, (_, i) => `$${i + 1}`);
          const result = await pool.query(pgSql, params);
          return result.rows[0] || null;
        },
        all: async (sql, params = []) => {
          const pgSql = sql.replace(/\?/g, (_, i) => `$${i + 1}`);
          const result = await pool.query(pgSql, params);
          return result.rows;
        },
      };
    },
    close: async () => {
      if (pgPool) {
        await pgPool.end();
        pgPool = null;
      }
    },
  };
}

function closeDb() {
  if (config.database.client === 'pg') {
    if (pgPool) {
      return pgPool.end().then(() => {
        pgPool = null;
      });
    } else {
      if (db) {
        return new Promise((resolve) => {
          db.close((err) => {
            if (err) logger.error('DB', 'Error closing database', { error: err.message });
            db = null;
            logger.db('Database closed');
            resolve();
          });
        });
      }
      return Promise.resolve();
    }
  }

// Promise wrappers for db methods
async function dbRun(sql, params = []) {
  const dbInstance = await getDb();
  if (config.database.client === 'pg') {
    return dbInstance.run(sql, params);
  } else {
    return new Promise((resolve, reject) => {
      dbInstance.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
}

async function dbGet(sql, params = []) {
  const dbInstance = await getDb();
  if (config.database.client === 'pg') {
    return dbInstance.get(sql, params);
  } else {
    return new Promise((resolve, reject) => {
      dbInstance.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
}

async function dbAll(sql, params = []) {
  const dbInstance = await getDb();
  if (config.database.client === 'pg') {
    return dbInstance.all(sql, params);
  } else {
    return new Promise((resolve, reject) => {
      dbInstance.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

// Dialect helpers
const autoIncrement = config.database.client === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const boolTrue = config.database.client === 'pg' ? 'TRUE' : '1';
const boolFalse = config.database.client === 'pg' ? 'FALSE' : '0';
const nowFn = config.database.client === 'pg' ? 'NOW()' : "datetime('now')";
const uuidGen = config.database.client === 'pg' ? 'gen_random_uuid()' : 'lower(hex(randomblob(16)))';
const jsonType = config.database.client === 'pg' ? 'JSONB' : 'TEXT';
const IS_PG = config.database.client === 'pg';
const databaseClient = config.database.client;

module.exports = {
  getDb,
  closeDb,
  dbRun,
  dbGet,
  dbAll,
  autoIncrement,
  boolTrue,
  boolFalse,
  nowFn,
  uuidGen,
  jsonType,
  IS_PG,
  databaseClient,
};