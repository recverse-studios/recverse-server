/**
 * RecVerse Server Authentication Middleware
 * JWT validation and account lookup
 */

const { verifyToken } = require('./verse-utils');
const { getDb } = require('./verse-db');
const logger = require('./verse-logger');

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * Validate JWT and return account ID
 */
function validateAndGetAccountId(req) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  const accountId = parseInt(payload.sub, 10);
  return Number.isInteger(accountId) && accountId > 0 ? accountId : null;
}

/**
 * Validate JWT and return full payload
 */
function validateAndGetPayload(req) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) return null;
  return verifyToken(token);
}

/**
 * Check if account has Plus subscription
 */
async function validateAndGetPlus(req) {
  const payload = validateAndGetPayload(req);
  if (!payload) return false;
  return payload['rn.plus'] === true;
}

/**
 * Check if account has specific role
 */
function hasRole(payload, role) {
  if (!payload || !payload.role) return false;
  const roles = Array.isArray(payload.role) ? payload.role : [payload.role];
  return roles.includes(role);
}

/**
 * Check if account is staff (developer or moderator)
 */
function isStaff(payload) {
  return hasRole(payload, 'developer') || hasRole(payload, 'moderator');
}

/**
 * Authentication middleware - requires valid JWT
 */
function requireAuth(req, res, next) {
  const accountId = validateAndGetAccountId(req);
  if (!accountId) {
    return res.status(401).send(); // Empty body per RecNet convention
  }
  req.accountId = accountId;
  next();
}

/**
 * Optional authentication - adds accountId if valid token present
 */
function optionalAuth(req, res, next) {
  const accountId = validateAndGetAccountId(req);
  if (accountId) {
    req.accountId = accountId;
  }
  next();
}

/**
 * Role-based authorization middleware
 */
function requireRole(...roles) {
  return (req, res, next) => {
    const payload = validateAndGetPayload(req);
    if (!payload) {
      return res.status(401).send();
    }
    if (!roles.some(role => hasRole(payload, role))) {
      return res.status(403).send();
    }
    req.tokenPayload = payload;
    next();
  };
}

/**
 * Staff authorization middleware
 */
function requireStaff(req, res, next) {
  const payload = validateAndGetPayload(req);
  if (!payload || !isStaff(payload)) {
    return res.status(403).send();
  }
  req.tokenPayload = payload;
  next();
}

/**
 * Get account from database by ID
 */
async function getAccountById(accountId) {
  const db = getDb();
  return db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId);
}

/**
 * Get account from database by username
 */
async function getAccountByUsername(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM accounts WHERE username_lower = ?').get(username.toLowerCase());
}

/**
 * Get account from database by email
 */
async function getAccountByEmail(email) {
  const db = getDb();
  return db.prepare('SELECT * FROM accounts WHERE email_lower = ?').get(email.toLowerCase());
}

/**
 * Get multiple accounts by IDs
 */
async function getAccountsByIds(accountIds) {
  if (!accountIds.length) return [];
  const db = getDb();
  const placeholders = accountIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM accounts WHERE account_id IN (${placeholders})`).all(...accountIds);
}

/**
 * Create a default account object (for accounts not in DB)
 */
function defaultAccount(accountId) {
  return {
    account_id: accountId,
    username: `Player${accountId}`,
    username_lower: `player${accountId}`,
    display_name: `Player${accountId}`,
    email: '',
    email_lower: '',
    password_hash: '',
    bio: '',
    profile_image: '',
    banner_image: '',
    display_emoji: '',
    identity_flags: 0,
    personal_pronouns: 0,
    platforms: 0,
    platform_id: '',
    platform: 0,
    is_junior: 0,
    is_developer: 0,
    is_moderator: 0,
    is_influencer: 0,
    has_screenshare: 0,
    has_plus: 0,
    available_username_changes: 3,
    created_at: new Date().toISOString(),
    last_login_time: null,
    last_login_ip: '',
    signup_ip: '',
    is_deleted: 0,
    deleted_at: null,
  };
}

/**
 * Update account in database
 */
async function updateAccount(accountId, updates) {
  const db = getDb();
  const allowedFields = [
    'username', 'username_lower', 'display_name', 'email', 'email_lower',
    'password_hash', 'bio', 'profile_image', 'banner_image', 'display_emoji',
    'identity_flags', 'personal_pronouns', 'platforms', 'platform_id', 'platform',
    'is_junior', 'is_developer', 'is_moderator', 'is_influencer', 'has_screenshare',
    'has_plus', 'available_username_changes', 'last_login_time', 'last_login_ip',
    'signup_ip', 'is_deleted', 'deleted_at', 'birthday'
  ];

  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (!fields.length) return null;

  values.push(accountId);
  const stmt = db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE account_id = ?`);
  stmt.run(...values);
  return db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId);
}

/**
 * Create new account
 */
async function createAccount(data = {}) {
  const db = getDb();
  const { platforms = 0, lastLoginTime, signupIp, lastLoginIp } = data;
  
  const now = new Date().toISOString();
  const accountId = db.prepare(`
    INSERT INTO accounts (platforms, last_login_time, signup_ip, last_login_ip, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(platforms, lastLoginTime || now, signupIp || '', lastLoginIp || '', now).lastInsertRowid;

  return db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId);
}

/**
 * Check if username is taken
 */
async function isUsernameTaken(username, excludeAccountId = null) {
  const db = getDb();
  let query = 'SELECT account_id FROM accounts WHERE username_lower = ?';
  const params = [username.toLowerCase()];
  if (excludeAccountId) {
    query += ' AND account_id != ?';
    params.push(excludeAccountId);
  }
  return !!db.prepare(query).get(...params);
}

/**
 * Check if email is taken
 */
async function isEmailTaken(email, excludeAccountId = null) {
  const db = getDb();
  let query = 'SELECT account_id FROM accounts WHERE email_lower = ?';
  const params = [email.toLowerCase()];
  if (excludeAccountId) {
    query += ' AND account_id != ?';
    params.push(excludeAccountId);
  }
  return !!db.prepare(query).get(...params);
}

/**
 * Count accounts by platform identity
 */
async function countAccountsForPlatformIdentity(platform, platformId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM platform_links WHERE platform = ? AND platform_id = ?')
    .get(platform, platformId).count;
}

/**
 * Count accounts by signup IP
 */
async function countAccountsBySignupIp(ip) {
  if (!ip) return 0;
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM accounts WHERE signup_ip = ?').get(ip).count;
}

/**
 * Count accounts by device ID
 */
async function countAccountsByDeviceId(deviceId) {
  if (!deviceId) return 0;
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM accounts WHERE platform_id = ?').get(deviceId).count;
}

/**
 * Link platform identity to account
 */
async function linkPlatformIdentity(accountId, platform, platformId, roles = []) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO platform_links (account_id, platform, platform_id, roles)
      VALUES (?, ?, ?, ?)
    `).run(accountId, platform, platformId, JSON.stringify(roles));
    
    // Update account's primary platform if not set
    const account = db.prepare('SELECT platform_id FROM accounts WHERE account_id = ?').get(accountId);
    if (account && !account.platform_id) {
      db.prepare('UPDATE accounts SET platform = ?, platform_id = ? WHERE account_id = ?')
        .run(platform, platformId, accountId);
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if platform identity is linked to account
 */
async function isPlatformIdentityLinked(accountId, platform, platformId) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM platform_links WHERE account_id = ? AND platform = ? AND platform_id = ?')
    .get(accountId, platform, platformId);
}

/**
 * Get links for platform identity
 */
async function getLinksForPlatformIdentity(platform, platformId) {
  const db = getDb();
  return db.prepare('SELECT * FROM platform_links WHERE platform = ? AND platform_id = ?')
    .all(platform, platformId);
}

/**
 * Get links for platform ID (any platform)
 */
async function getLinksForPlatformId(platformId) {
  const db = getDb();
  return db.prepare('SELECT * FROM platform_links WHERE platform_id = ?').all(platformId);
}

/**
 * Get links for identity
 */
async function getLinksForIdentity(platform, platformId) {
  return getLinksForPlatformIdentity(platform, platformId);
}

/**
 * Get links for account
 */
async function getLinksForAccount(accountId) {
  const db = getDb();
  return db.prepare('SELECT * FROM platform_links WHERE account_id = ?').all(accountId);
}

/**
 * Set last login time
 */
async function setLastLoginTime(accountId, time) {
  const db = getDb();
  db.prepare('UPDATE accounts SET last_login_time = ? WHERE account_id = ?').run(time, accountId);
}

/**
 * Set login context (IP)
 */
async function setLoginContext(accountId, context) {
  const db = getDb();
  if (context.ip) {
    db.prepare('UPDATE accounts SET last_login_ip = ? WHERE account_id = ?').run(context.ip, accountId);
  }
}

/**
 * Record account IP
 */
async function recordAccountIp(accountId, ip, meta = {}) {
  // Could store in a separate table for IP history
  // For now just update last_login_ip
  if (ip) {
    const db = getDb();
    db.prepare('UPDATE accounts SET last_login_ip = ? WHERE account_id = ?').run(ip, accountId);
  }
}

/**
 * Request country from headers
 */
function requestCountry(req) {
  return req.headers['cf-ipcountry'] || req.headers['x-country'] || 'US';
}

/**
 * Write audit log
 */
async function writeAuditLog(data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_logs (player_id, action, data)
    VALUES (?, ?, ?)
  `).run(data.playerId, data.action, JSON.stringify(data.data));
}

module.exports = {
  validateAndGetAccountId,
  validateAndGetPayload,
  validateAndGetPlus,
  hasRole,
  isStaff,
  requireAuth,
  optionalAuth,
  requireRole,
  requireStaff,
  getAccountById,
  getAccountByUsername,
  getAccountByEmail,
  getAccountsByIds,
  defaultAccount,
  updateAccount,
  createAccount,
  isUsernameTaken,
  isEmailTaken,
  countAccountsForPlatformIdentity,
  countAccountsBySignupIp,
  countAccountsByDeviceId,
  linkPlatformIdentity,
  isPlatformIdentityLinked,
  getLinksForPlatformIdentity,
  getLinksForPlatformId,
  getLinksForIdentity,
  getLinksForAccount,
  setLastLoginTime,
  setLoginContext,
  recordAccountIp,
  requestCountry,
  writeAuditLog,
};