/**
 * RecVerse Server Database
 * Database abstraction with SQLite and PostgreSQL support.
 * Uses verse-db-adapter for multi-database compatibility.
 */

const adapter = require('./src/systems/verse-db-adapter');
const config = require('./verse-config');
const logger = require('./verse-logger');

let _db = null;

/**
 * Returns a database connection object with a `prepare()` method compatible
 * with sqlite3's Statement interface. Works for both SQLite and PostgreSQL.
 *
 * If the database hasn't been initialized yet, this will initialize it
 * synchronously (for SQLite) or return a promise (for PostgreSQL).
 * Callers should ensure initDatabase() has been called at startup.
 */
function getDb() {
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
    });
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

async function closeDb() {
  await adapter.closeDb();
  _db = null;
}

// Promise wrappers (used internally and by migration system)
async function dbRun(sql, params = []) {
  return adapter.dbRun(sql, params);
}

async function dbGet(sql, params = []) {
  return adapter.dbGet(sql, params);
}

async function dbAll(sql, params = []) {
  return adapter.dbAll(sql, params);
}

// Dialect helpers (exported for use in migration SQL)
const autoIncrement = adapter.autoIncrement;
const boolTrue = adapter.boolTrue;
const boolFalse = adapter.boolFalse;
const nowFn = adapter.nowFn;
const uuidGen = adapter.uuidGen;
const jsonType = adapter.jsonType;
const IS_PG = adapter.IS_PG;
const databaseClient = adapter.databaseClient;

// ============================================================================
// Migration system
// ============================================================================

const MIGRATIONS = [
  // Migration 1: Core tables
  {
    version: 1,
    name: 'core_tables',
    up: async () => {
      // Accounts table
      await dbRun(`
        CREATE TABLE IF NOT EXISTS accounts (
          account_id ${autoIncrement()},
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          expires_at TEXT NOT NULL,
          revoked_at TEXT DEFAULT NULL,
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account ON refresh_tokens(account_id);`);

      // Platform links
      await dbRun(`
        CREATE TABLE IF NOT EXISTS platform_links (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          platform INTEGER NOT NULL,
          platform_id TEXT NOT NULL,
          roles TEXT DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
          UNIQUE(platform, platform_id)
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_platform_links_account ON platform_links(account_id);`);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_platform_links_platform_id ON platform_links(platform, platform_id);`);

      // Email codes
      await dbRun(`
        CREATE TABLE IF NOT EXISTS email_codes (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          purpose TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          window_start TEXT NOT NULL DEFAULT (${nowFn()})
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
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          subroom_id ${autoIncrement()},
          room_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          unity_scene_id TEXT DEFAULT '',
          max_players INTEGER DEFAULT 16,
          current_save_id INTEGER DEFAULT NULL,
          staged_save_id INTEGER DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_subrooms_room ON subrooms(room_id);`);

      // Subroom saves
      await dbRun(`
        CREATE TABLE IF NOT EXISTS subroom_saves (
          save_id ${autoIncrement()},
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (subroom_id) REFERENCES subrooms(subroom_id) ON DELETE CASCADE,
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_saves_subroom ON subroom_saves(subroom_id);`);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_saves_account ON subroom_saves(account_id);`);

      // Chat messages
      await dbRun(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id ${autoIncrement()},
          room_id INTEGER NOT NULL,
          subroom_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          message_type INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
          PRIMARY KEY (account_id, currency_type, platform),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);

      // Inventory
      await dbRun(`
        CREATE TABLE IF NOT EXISTS inventory (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          item_type INTEGER NOT NULL,
          item_id INTEGER NOT NULL,
          data TEXT DEFAULT '{}',
          acquired_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_inventory_account ON inventory(account_id);`);

      // Custom avatar items
      await dbRun(`
        CREATE TABLE IF NOT EXISTS custom_avatar_items (
          id ${autoIncrement()},
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (creator_account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_cai_creator ON custom_avatar_items(creator_account_id);`);

      // Custom avatar item ownership
      await dbRun(`
        CREATE TABLE IF NOT EXISTS custom_avatar_item_ownership (
          account_id INTEGER NOT NULL,
          custom_avatar_item_id INTEGER NOT NULL,
          acquired_at TEXT NOT NULL DEFAULT (${nowFn()}),
          PRIMARY KEY (account_id, custom_avatar_item_id),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
          FOREIGN KEY (custom_avatar_item_id) REFERENCES custom_avatar_items(id) ON DELETE CASCADE
        );
      `);

      // Notifications
      await dbRun(`
        CREATE TABLE IF NOT EXISTS notifications (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          type INTEGER NOT NULL,
          data ${jsonType()} NOT NULL,
          read INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id, read);`);

      // Player settings
      await dbRun(`
        CREATE TABLE IF NOT EXISTS player_settings (
          account_id INTEGER PRIMARY KEY,
          settings_json ${jsonType()} NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);

      // Room comments
      await dbRun(`
        CREATE TABLE IF NOT EXISTS room_comments (
          id ${autoIncrement()},
          room_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_room_comments_room ON room_comments(room_id);`);

      // Reports / moderation
      await dbRun(`
        CREATE TABLE IF NOT EXISTS reports (
          id ${autoIncrement()},
          reporter_id INTEGER NOT NULL,
          reported_id INTEGER NOT NULL,
          category INTEGER NOT NULL,
          details TEXT DEFAULT '',
          room_id INTEGER DEFAULT NULL,
          subroom_id INTEGER DEFAULT NULL,
          status INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          resolved_at TEXT DEFAULT NULL,
          resolver_id INTEGER DEFAULT NULL,
          FOREIGN KEY (reporter_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
          FOREIGN KEY (reported_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);

      // Bans
      await dbRun(`
        CREATE TABLE IF NOT EXISTS bans (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          issuer_id INTEGER NOT NULL,
          reason TEXT NOT NULL,
          duration INTEGER DEFAULT 0,
          timeout_started_at TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          id ${autoIncrement()},
          player_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          data ${jsonType()} NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (player_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_audit_player ON audit_logs(player_id);`);

      // Leaderboards
      await dbRun(`
        CREATE TABLE IF NOT EXISTS leaderboard_scores (
          id ${autoIncrement()},
          leaderboard_id TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          score INTEGER NOT NULL,
          metadata ${jsonType()} DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
          UNIQUE(leaderboard_id, account_id)
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_lb_scores_board ON leaderboard_scores(leaderboard_id, score DESC);`);

      // Images (avatars, banners, room images, etc.)
      await dbRun(`
        CREATE TABLE IF NOT EXISTS saved_images (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          image_type INTEGER NOT NULL,
          filename TEXT NOT NULL,
          thumbnail_filename TEXT DEFAULT '',
          tagged_player_ids ${jsonType()} DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_images_account ON saved_images(account_id);`);

      // Clubs
      await dbRun(`
        CREATE TABLE IF NOT EXISTS clubs (
          club_id ${autoIncrement()},
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          creator_id INTEGER NOT NULL,
          clubhouse_room_id INTEGER DEFAULT NULL,
          banner_image TEXT DEFAULT '',
          additional_images ${jsonType()} DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          updated_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (creator_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);

      // Club members
      await dbRun(`
        CREATE TABLE IF NOT EXISTS club_members (
          club_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          role INTEGER NOT NULL DEFAULT 0,
          joined_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          backup_codes ${jsonType()} DEFAULT '[]',
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
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
          created_at TEXT NOT NULL DEFAULT (${nowFn()})
        );
      `);

      // Unity assets
      await dbRun(`
        CREATE TABLE IF NOT EXISTS unity_assets (
          id ${autoIncrement()},
          filename TEXT NOT NULL UNIQUE,
          hash TEXT NOT NULL,
          target INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          is_studio_bundle INTEGER DEFAULT 0,
          room_id INTEGER DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowFn()})
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_unity_assets_filename ON unity_assets(filename);`);

      // Avatar frames / avatar customization persistence
      await dbRun(`
        CREATE TABLE IF NOT EXISTS avatar_frames (
          id ${autoIncrement()},
          account_id INTEGER NOT NULL,
          frame_type TEXT NOT NULL,
          frame_data ${jsonType()} NOT NULL DEFAULT '{}',
          is_equipped INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (${nowFn()}),
          FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        );
      `);
      await dbRun(`CREATE INDEX IF NOT EXISTS idx_avatar_frames_account ON avatar_frames(account_id);`);

      logger.db('Core tables created', { client: databaseClient });
    },
  },

  // Migration 2: Additional columns and tables
  {
    version: 2,
    name: 'additional_schema',
    up: async () => {
      // Add missing columns if they don't exist
      const columns = [
        { table: 'accounts', column: 'birthday', type: "TEXT DEFAULT '1904-01-01T00:00:00.000Z'" },
        { table: 'accounts', column: 'has_screenshare', type: 'INTEGER DEFAULT 0' },
        { table: 'accounts', column: 'has_plus', type: 'INTEGER DEFAULT 0' },
        { table: 'accounts', column: 'is_influencer', type: 'INTEGER DEFAULT 0' },
      ];

      for (const col of columns) {
        try {
          await dbRun(`ALTER TABLE ${col.table} ADD COLUMN ${col.column} ${col.type};`);
        } catch (e) {
          // Column might already exist (PostgreSQL throws, SQLite too)
        }
      }

      logger.db('Additional schema applied');
    },
  },

  // Migration 3: Server maintenance state persistence
  {
    version: 3,
    name: 'server_maintenance_state',
    up: async () => {
      await dbRun(`
        CREATE TABLE IF NOT EXISTS server_maintenance (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          is_active INTEGER NOT NULL DEFAULT 0,
          scheduled_at TEXT,
          starts_at TEXT,
          starts_in_minutes INTEGER,
          warning_intervals ${jsonType()},
          last_warning_sent TEXT,
          cancelled INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (${nowFn()})
        );
      `);
      logger.db('Server maintenance state table created');
    },
  },
];

async function runMigrations() {
  await getDb();

  // Create migrations table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (${nowFn()})
    );
  `);

  const applied = (await dbAll('SELECT version FROM migrations')).map(r => r.version);

  for (const migration of MIGRATIONS) {
    if (!applied.includes(migration.version)) {
      logger.db('Running migration', { version: migration.version, name: migration.name, client: databaseClient });
      await migration.up();
      await dbRun('INSERT INTO migrations (version, name) VALUES (?, ?)', [migration.version, migration.name]);
      logger.db('Migration completed', { version: migration.version });
    }
  }

  logger.db('All migrations up to date', { client: databaseClient });
}

async function seedDefaultData() {
  await getDb();

  // Check if orientation room exists
  const orientation = await dbGet('SELECT room_id FROM rooms WHERE room_id = 13');

  if (!orientation) {
    logger.db('Seeding default data (orientation room)');

    // Create a system account (ID 1) if it doesn't exist
    const systemAccount = await dbGet('SELECT account_id FROM accounts WHERE account_id = 1');
    if (!systemAccount) {
      await dbRun(`
        INSERT INTO accounts (account_id, username, username_lower, display_name, email, created_at)
        VALUES (1, 'System', 'system', 'System', 'system@recverse.local', ${nowFn()})
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

    logger.db('Default data seeded');
  }
}

async function initDatabase() {
  await getDb();
  await runMigrations();
  await seedDefaultData();
  return _db;
}

module.exports = {
  getDb,
  closeDb,
  initDatabase,
  runMigrations,
  seedDefaultData,
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
  adapter,
};
