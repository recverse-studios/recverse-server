/**
 * RecVerse Server Database
 * Database abstraction with SQLite and PostgreSQL support.
 * Uses verse-db-adapter for multi-database compatibility.
 */

import adapter from './src/systems/verse-db-adapter.js';
import config from './verse-config.js';
import logger from './verse-logger.js';

let _db = null;

/**
 * Returns a database connection object with a `prepare()` method compatible
 * with sqlite3's Statement interface. Works for both SQLite and PostgreSQL.
 *
 * If the database hasn't been initialized yet, this will initialize it
 * synchronously (for SQLite) or return a promise (for PostgreSQL).
 * Callers should ensure initDatabase() has been called at startup.
 */
export function getDb() {
  if (_db) return _db;

  // Not yet initialized - try to initialize synchronously
  // For SQLite this works; for PostgreSQL the caller must await initDatabase() first
  const result = adapter.getDb();
  if (result && typeof result.then === 'function') {
    // PostgreSQL - return a promise; callers should use await
    return result.then(() => {
      _db = {
        prepare: (sql) => adapter.createStatement(sql),
        run: (sql, params) => adapter.dbRun(sql, params),
        get: (sql, params) => adapter.dbGet(sql, params),
        all: (sql, params) => adapter.dbAll(sql, params),
        close: () => adapter.closeDb(),
        client: adapter.databaseClient,
      };
      return _db;
    }

  // SQLite - synchronous initialization
  _db = {
    prepare: (sql) => adapter.createStatement(sql),
    run: (sql, params) => adapter.dbRun(sql, params),
    get: (sql, params) => adapter.dbGet(sql, params),
    all: (sql, params) => adapter.dbAll(sql, params),
    close: () => adapter.closeDb(),
    client: adapter.databaseClient,
  };

  return _db;
}

export async function closeDb() {
  await adapter.closeDb();
  _db = null;
}

// Promise wrappers (used internally and by migration system)
export async function dbRun(sql, params = []) {
  return adapter.dbRun(sql, params);
}

export async function dbGet(sql, params = []) {
  return adapter.dbGet(sql, params);
}

export async function dbAll(sql, params = []) {
  return adapter.dbAll(sql, params);
}

// Dialect helpers (exported for use in migration SQL)
export const autoIncrement = adapter.autoIncrement;
export const boolTrue = adapter.boolTrue;
export const boolFalse = adapter.boolFalse;
export const nowFn = adapter.nowFn;
export const uuidGen = adapter.uuidGen;
export const jsonType = adapter.jsonType;
export const IS_PG = adapter.IS_PG;
export const databaseClient = adapter.databaseClient;

export { adapter };

// Re-export adapter methods for convenience
export const { getDb: adapterGetDb, closeDb: adapterCloseDb, initDatabase, runMigrations, seedDefaultData } = adapter;