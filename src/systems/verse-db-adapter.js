/**
 * RecVerse Server Database Adapter
 * src/systems/verse-db-adapter.js
 *
 * Abstraction layer that supports both SQLite and PostgreSQL.
 * Provides a consistent interface for all database operations.
 *
 * Configuration (via verse-config.js or environment variables):
 *   DB_CLIENT: 'sqlite3' | 'pg' (default: 'sqlite3')
 *   For PostgreSQL:
 *     PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_SSL
 *
 * The adapter converts SQLite-style `?` placeholders to PostgreSQL `$1`, `$2`, etc.
 * and handles dialect-specific SQL (AUTOINCREMENT -> SERIAL, etc.).
 */

const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const config = require('../../verse-config');
const logger = require('../../verse-logger');

// ============================================================================
// Database client detection
// ============================================================================

const DB_CLIENT = (process.env.DB_CLIENT || config.database.client || 'sqlite3').toLowerCase();
const IS_PG = DB_CLIENT === 'pg' || DB_CLIENT === 'postgresql';

let db = null;
let pgPool = null;

// ============================================================================
// Placeholder conversion: SQLite `?` -> PostgreSQL `$1`, `$2`, ...
// ============================================================================

/**
 * Convert SQLite-style `?` placeholders to PostgreSQL `$n` placeholders.
 * Handles `?` outside of string literals.
 */
function convertPlaceholders(sql) {
  if (!IS_PG) return sql;

  let result = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let paramIndex = 1;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inSingleQuote) {
      result += ch;
      if (ch === "'" && next !== "'") {
        inSingleQuote = false;
      } else if (ch === "'" && next === "'") {
        result += next; // escaped quote
        i++;
      }
      continue;
    }

    if (inDoubleQuote) {
      result += ch;
      if (ch === '"' && next !== '"') {
        inDoubleQuote = false;
      } else if (ch === '"' && next === '"') {
        result += next; // escaped quote
        i++;
      }
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      result += ch;
    } else if (ch === '"') {
      inDoubleQuote = true;
      result += ch;
    } else if (ch === '?') {
      result += `$${paramIndex++}`;
    } else {
      result += ch;
    }
  }

  return result;
}

// ============================================================================
// SQLite implementation
// ============================================================================

function openSqlite() {
  return new Promise((resolve, reject) => {
    const dbPath = config.database.path;
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const sqlite = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) {
        logger.error('DB', 'Failed to open SQLite database', { error: err.message, path: dbPath });
        reject(err);
        return;
      }

      // Enable WAL mode for better concurrency
      sqlite.run('PRAGMA journal_mode = WAL', (err) => {
        if (err) logger.warn('DB', 'Failed to set WAL mode', { error: err.message });
      });

      sqlite.run('PRAGMA foreign_keys = ON', (err) => {
        if (err) logger.warn('DB', 'Failed to enable foreign keys', { error: err.message });
      });

      sqlite.run('PRAGMA synchronous = NORMAL', (err) => {
        if (err) logger.warn('DB', 'Failed to set synchronous', { error: err.message });
      });

      sqlite.run('PRAGMA cache_size = -32768', (err) => {
        if (err) logger.warn('DB', 'Failed to set cache size', { error: err.message });
      });

      sqlite.run('PRAGMA temp_store = MEMORY', (err) => {
        if (err) logger.warn('DB', 'Failed to set temp store', { error: err.message });
      });

      logger.db('SQLite connected', { path: dbPath });
      resolve(sqlite);
    });
  });
}

// ============================================================================
// PostgreSQL implementation
// ============================================================================

function openPostgreSQL() {
  // Support single connection string (DATABASE_URL)
  // Format: postgresql://user:password@host:port/database?ssl=true
  let pgConfig;
  const databaseUrl = config.database.databaseUrl;

  if (databaseUrl && databaseUrl.startsWith('postgresql://')) {
    const url = new URL(databaseUrl);
    pgConfig = {
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '5432', 10),
      user: url.username || 'postgres',
      password: url.password || '',
      database: url.pathname.replace(/^\//, '') || 'recverse',
      ssl: url.searchParams.get('ssl') === 'true' || url.searchParams.get('sslmode') === 'require',
      max: parseInt(process.env.PG_MAX_CONNECTIONS || config.database.pgMaxConnections || '20', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
    if (pgConfig.ssl) {
      pgConfig.ssl = { rejectUnauthorized: false };
    }
    logger.db('PostgreSQL config from DATABASE_URL', {
      host: pgConfig.host,
      database: pgConfig.database,
      ssl: pgConfig.ssl,
    });
  } else {
    pgConfig = {
      host: process.env.PG_HOST || config.database.pgHost || 'localhost',
      port: parseInt(process.env.PG_PORT || config.database.pgPort || '5432', 10),
      user: process.env.PG_USER || config.database.pgUser || 'postgres',
      password: process.env.PG_PASSWORD || config.database.pgPassword || '',
      database: process.env.PG_DATABASE || config.database.pgDatabase || 'recverse',
      ssl: (process.env.PG_SSL || config.database.pgSsl || 'false') === 'true',
      max: parseInt(process.env.PG_MAX_CONNECTIONS || config.database.pgMaxConnections || '20', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
    if (pgConfig.ssl) {
      pgConfig.ssl = { rejectUnauthorized: false };
    }
  }

  const pool = new Pool(pgConfig);

  pool.on('connect', () => {
    logger.db('PostgreSQL client connected', { host: pgConfig.host, database: pgConfig.database });
  });

  pool.on('error', (err) => {
    logger.error('DB', 'PostgreSQL idle client error', { error: err.message });
  });

  // Test connection
  return pool.query('SELECT 1').then(() => {
    logger.db('PostgreSQL connected', {
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
    });
    return pool;
  }).catch((err) => {
    logger.error('DB', 'Failed to connect to PostgreSQL', {
      error: err.message,
      host: pgConfig.host,
      database: pgConfig.database,
    });
    throw err;
  });
}

// ============================================================================
// Database connection management
// ============================================================================

async function getDb() {
  if (db) return db;

  if (IS_PG) {
    pgPool = await openPostgreSQL();
    db = pgPool; // Return pool for pg
  } else {
    db = await openSqlite();
  }

  return db;
}

async function closeDb() {
  try {
    if (IS_PG && pgPool) {
      await pgPool.end();
      pgPool = null;
      logger.db('PostgreSQL pool closed');
    } else if (db) {
      await new Promise((resolve) => {
        db.close((err) => {
          if (err) logger.error('DB', 'Error closing database', { error: err.message });
          db = null;
          logger.db('Database closed');
          resolve();
        });
      });
    }
  } catch (err) {
    logger.error('DB', 'Error closing database', { error: err.message });
  }
  db = null;
}

// ============================================================================
// Statement wrapper (provides .run(), .get(), .all() like sqlite3)
// ============================================================================

/**
 * Creates a statement object compatible with sqlite3's Statement interface.
 * Works for both SQLite and PostgreSQL.
 */
function createStatement(sql, params = []) {
  const convertedSql = convertPlaceholders(sql);
  const isPg = IS_PG;

  return {
    async run(...runParams) {
      const allParams = params.length > 0 ? params : runParams;
      if (isPg) {
        const result = await pgPool.query(convertedSql, allParams);
        return {
          lastID: result.rows[0] ? result.rows[0].id : undefined,
          changes: result.rowCount,
        };
      }
      return new Promise((resolve, reject) => {
        db.run(convertedSql, allParams, function(err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    },

    async get(...getParams) {
      const allParams = params.length > 0 ? params : getParams;
      if (isPg) {
        const result = await pgPool.query(convertedSql, allParams);
        return result.rows[0] || undefined;
      }
      return new Promise((resolve, reject) => {
        db.get(convertedSql, allParams, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    },

    async all(...allParams) {
      const allP = params.length > 0 ? params : allParams;
      if (isPg) {
        const result = await pgPool.query(convertedSql, allP);
        return result.rows;
      }
      return new Promise((resolve, reject) => {
        db.all(convertedSql, allP, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    },
  };
}

// ============================================================================
// High-level query helpers (dbRun, dbGet, dbAll)
// ============================================================================

async function dbRun(sql, params = []) {
  const stmt = createStatement(sql, params);
  return stmt.run();
}

async function dbGet(sql, params = []) {
  const stmt = createStatement(sql, params);
  return stmt.get();
}

async function dbAll(sql, params = []) {
  const stmt = createStatement(sql, params);
  return stmt.all();
}

// ============================================================================
// Dialect-specific SQL helpers
// ============================================================================

/**
 * Returns the correct auto-increment syntax for the current database.
 * SQLite: AUTOINCREMENT
 * PostgreSQL: SERIAL
 */
function autoIncrement() {
  return IS_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
}

/**
 * Returns the correct boolean literal for the current database.
 */
function boolTrue() {
  return IS_PG ? 'TRUE' : '1';
}

function boolFalse() {
  return IS_PG ? 'FALSE' : '0';
}

/**
 * Returns the current timestamp function for the current database.
 */
function nowFn() {
  return IS_PG ? 'NOW()' : "datetime('now')";
}

/**
 * Returns the correct UUID generation for the current database.
 */
function uuidGen() {
  return IS_PG ? 'gen_random_uuid()' : 'lower(hex(randomblob(16)))';
}

/**
 * Returns the JSONB/TEXT type for JSON columns.
 */
function jsonType() {
  return IS_PG ? 'JSONB' : 'TEXT';
}

// ============================================================================
// Export database client info
// ============================================================================

const databaseClient = IS_PG ? 'postgresql' : 'sqlite3';

module.exports = {
  getDb,
  closeDb,
  dbRun,
  dbGet,
  dbAll,
  createStatement,
  autoIncrement,
  boolTrue,
  boolFalse,
  nowFn,
  uuidGen,
  jsonType,
  databaseClient,
  IS_PG,
  // Expose raw pool/db for advanced use
  getRawDb: () => db,
};
