/**
 * RecVerse Server Database - Cloudflare Workers + Hyperdrive
 * 
 * Database layer using Cloudflare Hyperdrive to connect to Layerbase PostgreSQL.
 * Provides a consistent interface similar to the original verse-db.js.
 * 
 * Hyperdrive binding provides a DATABASE_URL that works with standard PostgreSQL clients.
 * With nodejs_compat enabled, we can use the `pg` library.
 */

import { Pool } from 'pg';
import config from './config.js';

let pool = null;
let isInitialized = false;

/**
 * Initialize the Hyperdrive connection pool
 * @param {Object} dbBinding - The Hyperdrive binding from Workers env (env.DB)
 */
export async function initDatabase(dbBinding) {
  if (isInitialized && pool) return pool;

  try {
    // Hyperdrive provides the connection string via the binding
    // The binding object has a .connectionString property or we construct it
    let connectionString = '';
    
    if (dbBinding && typeof dbBinding === 'object') {
      // Hyperdrive binding may provide connectionString directly or via properties
      connectionString = dbBinding.connectionString || dbBinding.databaseUrl || '';
    }

    // Fallback: try to construct from env vars if binding doesn't have connectionString
    if (!connectionString) {
      // In production, DATABASE_URL would be set as a secret
      connectionString = process.env.DATABASE_URL || '';
    }

    if (!connectionString) {
      console.warn('No database connection string available. Database-dependent routes will fail.');
      return null;
    }

    // Create connection pool with Hyperdrive connection string
    pool = new Pool({
      connectionString: connectionString,
      // Hyperdrive connection settings
      max: 10, // Maximum connections in pool
      min: 2,  // Minimum connections
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Enable SSL for Hyperdrive (required for most cloud PostgreSQL)
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    // Test connection
    await pool.query('SELECT 1');
    
    isInitialized = true;
    console.log('Database connected via Hyperdrive (PostgreSQL)');
    
    // Run migrations
    await runMigrations();
    await seedDefaultData();
    
    return pool;
  } catch (err) {
    console.error('Database initialization error:', err.message);
    pool = null;
    throw err;
  }
}

/**
 * Get the database pool
 */
export function getDb() {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase(env.DB) first.');
  }
  return pool;
}

/**
 * Check if database is initialized
 */
export function isDbInitialized() {
  return isInitialized && pool !== null;
}

/**
 * Close database pool (for graceful shutdown)
 */
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    isInitialized = false;
  }
}

/**
 * Execute a query that returns no results (INSERT, UPDATE, DELETE)
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Object} { rows, rowCount, lastInsertId }
 */
export async function dbRun(sql, params = []) {
  if (!pool) throw new Error('Database not initialized');
  
  // Convert SQLite-style ? placeholders to PostgreSQL $1, $2, etc.
  const pgSql = convertPlaceholders(sql);
  
  const result = await pool.query(pgSql, params);
  
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    lastInsertId: result.rows.length > 0 ? result.rows[0].id : null,
  };
}

/**
 * Execute a query that returns a single row
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Object|null} Single row or null
 */
export async function dbGet(sql, params = []) {
  if (!pool) throw new Error('Database not initialized');
  
  const pgSql = convertPlaceholders(sql);
  const result = await pool.query(pgSql, params);
  
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Execute a query that returns multiple rows
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Array} Array of rows
 */
export async function dbAll(sql, params = []) {
  if (!pool) throw new Error('Database not initialized');
  
  const pgSql = convertPlaceholders(sql);
  const result = await pool.query(pgSql, params);
  
  return result.rows;
}

/**
 * Convert SQLite-style ? placeholders to PostgreSQL $1, $2, etc.
 * Handles ? outside of string literals
 */
function convertPlaceholders(sql) {
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
        result += next;
        i++;
      }
      continue;
    }

    if (inDoubleQuote) {
      result += ch;
      if (ch === '"' && next !== '"') {
        inDoubleQuote = false;
      } else if (ch === '"' && next === '"') {
        result += next;
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

/**
 * Run migrations against the database
 */
async function runMigrations() {
  // Migration 1: Core tables
  await dbRun(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      username_lower TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '',
      email_lower TEXT DEFAULT '',
      password_hash TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      profile_image TEXT DEFAULT '',
      banner_image TEXT DEFAULT '',
      display_emoji TEXT DEFAULT '',
      identity_flags INTEGER DEFAULT 0,
      personal_pronouns INTEGER DEFAULT 0,
      platforms INTEGER DEFAULT 0,
      platform_id TEXT DEFAULT '',
      platform INTEGER DEFAULT 0,
      is_junior INTEGER DEFAULT 0,
      is_developer INTEGER DEFAULT 0,
      is_moderator INTEGER DEFAULT 0,
      is_influencer INTEGER DEFAULT 0,
      has_screenshare INTEGER DEFAULT 0,
      has_plus INTEGER DEFAULT 0,
      available_username_changes INTEGER DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      last_login_time TEXT DEFAULT NULL,
      last_login_ip TEXT DEFAULT '',
      signup_ip TEXT DEFAULT '',
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT DEFAULT NULL
    );
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON accounts(username_lower);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_accounts_email_lower ON accounts(email_lower);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_accounts_platform_id ON accounts(platform_id);`);

  // Refresh tokens
  await dbRun(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      expires_at TEXT NOT NULL,
      revoked_at TEXT DEFAULT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account ON refresh_tokens(account_id);`);

  // Platform links
  await dbRun(`
    CREATE TABLE IF NOT EXISTS platform_links (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      platform INTEGER NOT NULL,
      platform_id TEXT NOT NULL,
      roles TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      UNIQUE(platform, platform_id)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_platform_links_account ON platform_links(account_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_platform_links_platform_id ON platform_links(platform, platform_id);`);

  // Email codes
  await dbRun(`
    CREATE TABLE IF NOT EXISTS email_codes (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      expires_at TEXT NOT NULL,
      consumed_at TEXT DEFAULT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_email_codes_account_purpose ON email_codes(account_id, purpose);`);

  // Rate limits
  await dbRun(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      window_start TEXT NOT NULL DEFAULT (NOW())
    );
  `);

  // Presence
  await dbRun(`
    CREATE TABLE IF NOT EXISTS presence (
      account_id INTEGER PRIMARY KEY,
      room_instance_id INTEGER NOT NULL DEFAULT -2,
      room_id INTEGER NOT NULL DEFAULT 13,
      sub_room_id INTEGER NOT NULL DEFAULT 1,
      room_instance_type INTEGER NOT NULL DEFAULT 0,
      location TEXT DEFAULT '',
      data_blob TEXT DEFAULT '',
      event_id INTEGER DEFAULT 0,
      club_id INTEGER DEFAULT 0,
      room_code TEXT DEFAULT '',
      photon_region TEXT DEFAULT 'us',
      photon_region_id TEXT DEFAULT 'us',
      photon_room_id TEXT DEFAULT 'rec.13',
      name TEXT DEFAULT '^Orientation',
      max_capacity INTEGER DEFAULT 4,
      is_full INTEGER DEFAULT 0,
      is_private INTEGER DEFAULT 0,
      is_in_progress INTEGER DEFAULT 0,
      encrypt_voice_chat INTEGER DEFAULT 0,
      status_visibility INTEGER DEFAULT 0,
      device_class INTEGER DEFAULT 0,
      vr_movement_mode INTEGER DEFAULT 1,
      platform INTEGER DEFAULT 0,
      app_version TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Rooms
  await dbRun(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      access_level INTEGER DEFAULT 1,
      creator_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      image_name TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      max_players INTEGER DEFAULT 16,
      is_dorm INTEGER DEFAULT 0,
      load_screens TEXT DEFAULT '[]',
      FOREIGN KEY (creator_id) REFERENCES accounts(account_id)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_rooms_creator ON rooms(creator_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_rooms_access ON rooms(access_level);`);

  // Subrooms
  await dbRun(`
    CREATE TABLE IF NOT EXISTS subrooms (
      subroom_id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unity_scene_id TEXT DEFAULT '',
      max_players INTEGER DEFAULT 16,
      current_save_id INTEGER DEFAULT NULL,
      staged_save_id INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_subrooms_room ON subrooms(room_id);`);

  // Subroom saves
  await dbRun(`
    CREATE TABLE IF NOT EXISTS subroom_saves (
      save_id SERIAL PRIMARY KEY,
      subroom_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      description TEXT DEFAULT '',
      data_blob TEXT NOT NULL,
      unity_asset TEXT DEFAULT '',
      unity_asset_hash TEXT DEFAULT '',
      unity_asset2 TEXT DEFAULT '',
      unity_asset2_hash TEXT DEFAULT '',
      unity_sub_assets TEXT DEFAULT '[]',
      persistence_version INTEGER DEFAULT 0,
      invention_usage TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (subroom_id) REFERENCES subrooms(subroom_id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_saves_subroom ON subroom_saves(subroom_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_saves_account ON subroom_saves(account_id);`);

  // Chat messages
  await dbRun(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL,
      subroom_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      message_type INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id, subroom_id);`);

  // Economy balances
  await dbRun(`
    CREATE TABLE IF NOT EXISTS balances (
      account_id INTEGER NOT NULL,
      currency_type INTEGER NOT NULL,
      platform INTEGER NOT NULL DEFAULT -2,
      amount INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      PRIMARY KEY (account_id, currency_type, platform),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Inventory
  await dbRun(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      item_type INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      data TEXT DEFAULT '{}',
      acquired_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_inventory_account ON inventory(account_id);`);

  // Custom avatar items
  await dbRun(`
    CREATE TABLE IF NOT EXISTS custom_avatar_items (
      id SERIAL PRIMARY KEY,
      creator_account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      base_avatar_item_id INTEGER DEFAULT NULL,
      base_avatar_item_color INTEGER DEFAULT NULL,
      design_filename TEXT DEFAULT '',
      thumbnail_image_filename TEXT DEFAULT '',
      price INTEGER DEFAULT 0,
      currency_type INTEGER DEFAULT 2,
      purchase_currency_type INTEGER DEFAULT 2,
      outfit_type INTEGER DEFAULT 0,
      current_saves TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      custom_badge_metadata TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (creator_account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_cai_creator ON custom_avatar_items(creator_account_id);`);

  // Custom avatar item ownership
  await dbRun(`
    CREATE TABLE IF NOT EXISTS custom_avatar_item_ownership (
      account_id INTEGER NOT NULL,
      custom_avatar_item_id INTEGER NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (NOW()),
      PRIMARY KEY (account_id, custom_avatar_item_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      FOREIGN KEY (custom_avatar_item_id) REFERENCES custom_avatar_items(id) ON DELETE CASCADE
    );
  `);

  // Notifications
  await dbRun(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      type INTEGER NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id, read);`);

  // Player settings
  await dbRun(`
    CREATE TABLE IF NOT EXISTS player_settings (
      account_id INTEGER PRIMARY KEY,
      settings_json JSONB NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Room comments
  await dbRun(`
    CREATE TABLE IF NOT EXISTS room_comments (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_room_comments_room ON room_comments(room_id);`);

  // Reports / moderation
  await dbRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter_id INTEGER NOT NULL,
      reported_id INTEGER NOT NULL,
      category INTEGER NOT NULL,
      details TEXT DEFAULT '',
      room_id INTEGER DEFAULT NULL,
      subroom_id INTEGER DEFAULT NULL,
      status INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      resolved_at TEXT DEFAULT NULL,
      resolver_id INTEGER DEFAULT NULL,
      FOREIGN KEY (reporter_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      FOREIGN KEY (reported_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Bans
  await dbRun(`
    CREATE TABLE IF NOT EXISTS bans (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      issuer_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      duration INTEGER DEFAULT 0,
      timeout_started_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      expires_at TEXT DEFAULT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      FOREIGN KEY (issuer_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_bans_account ON bans(account_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_bans_expires ON bans(expires_at);`);

  // Audit logs
  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (player_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_audit_player ON audit_logs(player_id);`);

  // Leaderboards
  await dbRun(`
    CREATE TABLE IF NOT EXISTS leaderboard_scores (
      id SERIAL PRIMARY KEY,
      leaderboard_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      score INTEGER NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      UNIQUE(leaderboard_id, account_id)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_lb_scores_board ON leaderboard_scores(leaderboard_id, score DESC);`);

  // Images (avatars, banners, room images, etc.)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS saved_images (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      image_type INTEGER NOT NULL,
      filename TEXT NOT NULL,
      thumbnail_filename TEXT DEFAULT '',
      tagged_player_ids JSONB NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_images_account ON saved_images(account_id);`);

  // Clubs
  await dbRun(`
    CREATE TABLE IF NOT EXISTS clubs (
      club_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator_id INTEGER NOT NULL,
      clubhouse_room_id INTEGER DEFAULT NULL,
      banner_image TEXT DEFAULT '',
      additional_images JSONB DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (NOW()),
      updated_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (creator_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Club members
  await dbRun(`
    CREATE TABLE IF NOT EXISTS club_members (
      club_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      role INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT (NOW()),
      PRIMARY KEY (club_id, account_id),
      FOREIGN KEY (club_id) REFERENCES clubs(club_id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Two-factor auth
  await dbRun(`
    CREATE TABLE IF NOT EXISTS two_factor (
      account_id INTEGER PRIMARY KEY,
      method TEXT NOT NULL DEFAULT 'none',
      secret TEXT DEFAULT '',
      backup_codes JSONB NOT NULL DEFAULT '[]',
      enabled_at TEXT DEFAULT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Login challenges
  await dbRun(`
    CREATE TABLE IF NOT EXISTS login_challenges (
      key TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);

  // Studio device grants
  await dbRun(`
    CREATE TABLE IF NOT EXISTS studio_device_grants (
      user_code TEXT PRIMARY KEY,
      account_id INTEGER DEFAULT NULL,
      client_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT DEFAULT NULL,
      denied_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW())
    );
  `);

  // Unity assets
  await dbRun(`
    CREATE TABLE IF NOT EXISTS unity_assets (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      target INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      is_studio_bundle INTEGER DEFAULT 0,
      room_id INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW())
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_unity_assets_filename ON unity_assets(filename);`);

  // Avatar frames
  await dbRun(`
    CREATE TABLE IF NOT EXISTS avatar_frames (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      frame_type TEXT NOT NULL,
      frame_data JSONB NOT NULL DEFAULT '{}',
      is_equipped INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_avatar_frames_account ON avatar_frames(account_id);`);

  // Server maintenance state
  await dbRun(`
    CREATE TABLE IF NOT EXISTS server_maintenance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_active INTEGER NOT NULL DEFAULT 0,
      scheduled_at TEXT,
      starts_at TEXT,
      starts_in_minutes INTEGER,
      warning_intervals JSONB,
      last_warning_sent TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (NOW())
    );
  `);

  console.log('Database migrations completed');
}

/**
 * Seed default data
 */
async function seedDefaultData() {
  // Check if orientation room exists
  const orientation = await dbGet('SELECT room_id FROM rooms WHERE room_id = 13');
  
  if (!orientation) {
    // Create system account (ID 1)
    const systemAccount = await dbGet('SELECT account_id FROM accounts WHERE account_id = 1');
    if (!systemAccount) {
      await dbRun(`
        INSERT INTO accounts (account_id, username, username_lower, display_name, email, created_at)
        VALUES (1, 'System', 'system', 'System', 'system@recverse.local', NOW())
      `);
    }

    await dbRun(`
      INSERT INTO rooms (room_id, name, description, access_level, creator_id, is_dorm, max_players, tags, load_screens)
      VALUES (13, 'Orientation', 'Welcome to RecVerse!', 1, 1, 0, 4, '[]', '[]')
    `);

    await dbRun(`
      INSERT INTO subrooms (subroom_id, room_id, name, unity_scene_id, max_players)
      VALUES (1, 13, 'Orientation', 'Orientation', 4)
    `);

    console.log('Default data seeded');
  }
}
