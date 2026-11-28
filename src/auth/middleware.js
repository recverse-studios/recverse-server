/**
 * RecVerse Server Authentication Middleware - Cloudflare Workers Version
 * JWT validation and account lookup
 * Adapted from verse-auth-middleware.js for Hono + Workers
 */

import { verifyToken } from './jwt.js';
import { dbGet, dbRun, dbAll, getDb, isDbInitialized } from '../db/hyperdrive.js';

/**
 * Extract Bearer token from Authorization header
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} Token or null
 */
function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * Validate JWT and return account ID
 * @param {Object} c - Hono context
 * @returns {number|null} Account ID or null
 */
function validateAndGetAccountId(c) {
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  const accountId = parseInt(payload.sub, 10);
  return Number.isInteger(accountId) && accountId > 0 ? accountId : null;
}

/**
 * Validate JWT and return full payload
 * @param {Object} c - Hono context
 * @returns {Object|null} Decoded payload or null
 */
function validateAndGetPayload(c) {
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) return null;
  return verifyToken(token);
}

/**
 * Check if account has Plus subscription
 * @param {Object} payload - JWT payload
 * @returns {boolean} True if has Plus
 */
function validateAndGetPlus(payload) {
  if (!payload) return false;
  return payload['rn.plus'] === true;
}

/**
 * Check if account has specific role
 * @param {Object} payload - JWT payload
 * @param {string} role - Role to check
 * @returns {boolean} True if has role
 */
function hasRole(payload, role) {
  if (!payload || !payload.role) return false;
  const roles = Array.isArray(payload.role) ? payload.role : [payload.role];
  return roles.includes(role);
}

/**
 * Check if account is staff (developer or moderator)
 * @param {Object} payload - JWT payload
 * @returns {boolean} True if staff
 */
function isStaff(payload) {
  return hasRole(payload, 'developer') || hasRole(payload, 'moderator');
}

/**
 * Authentication middleware - requires valid JWT
 * @param {Object} c - Hono context
 * @param {Function} next - Next middleware
 */
export async function authMiddleware(c, next) {
  const accountId = validateAndGetAccountId(c);
  if (!accountId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('accountId', accountId);
  await next();
}

/**
 * Optional authentication - adds accountId if valid token present
 * @param {Object} c - Hono context
 * @param {Function} next - Next middleware
 */
export async function optionalAuth(c, next) {
  const accountId = validateAndGetAccountId(c);
  if (accountId) {
    c.set('accountId', accountId);
  }
  await next();
}

/**
 * Role-based authorization middleware
 * @param {...string} roles - Required roles
 * @returns {Function} Middleware function
 */
export function requireRole(...roles) {
  return async (c, next) => {
    const payload = validateAndGetPayload(c);
    if (!payload) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!roles.some(role => hasRole(payload, role))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    c.set('tokenPayload', payload);
    await next();
  };
}

/**
 * Staff authorization middleware (developer or moderator)
 * @param {Object} c - Hono context
 * @param {Function} next - Next middleware
 */
export async function requireStaff(c, next) {
  const payload = validateAndGetPayload(c);
  if (!payload || !isStaff(payload)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  c.set('tokenPayload', payload);
  await next();
}

/**
 * Get account from database by ID
 * @param {number} accountId - Account ID
 * @returns {Object|null} Account record or null
 */
export async function getAccountById(accountId) {
  if (!isDbInitialized()) return null;
  return dbGet('SELECT * FROM accounts WHERE account_id = ?', [accountId]);
}

/**
 * Get account from database by username
 * @param {string} username - Username
 * @returns {Object|null} Account record or null
 */
export async function getAccountByUsername(username) {
  if (!isDbInitialized()) return null;
  return dbGet('SELECT * FROM accounts WHERE username_lower = ?', [username.toLowerCase()]);
}

/**
 * Get account from database by email
 * @param {string} email - Email address
 * @returns {Object|null} Account record or null
 */
export async function getAccountByEmail(email) {
  if (!isDbInitialized()) return null;
  return dbGet('SELECT * FROM accounts WHERE email_lower = ?', [email.toLowerCase()]);
}

/**
 * Get multiple accounts by IDs
 * @param {number[]} accountIds - Array of account IDs
 * @returns {Object[]} Array of account records
 */
export async function getAccountsByIds(accountIds) {
  if (!accountIds.length || !isDbInitialized()) return [];
  const placeholders = accountIds.map(() => '?').join(',');
  return dbAll(`SELECT * FROM accounts WHERE account_id IN (${placeholders})`, accountIds);
}

/**
 * Create a default account object (for accounts not in DB)
 * @param {number} accountId - Account ID
 * @returns {Object} Default account object
 */
export function defaultAccount(accountId) {
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
 * @param {number} accountId - Account ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated account or null
 */
export async function updateAccount(accountId, updates) {
  if (!isDbInitialized()) return null;
  
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
  await dbRun(`UPDATE accounts SET ${fields.join(', ')} WHERE account_id = ?`, values);
  return dbGet('SELECT * FROM accounts WHERE account_id = ?', [accountId]);
}

/**
 * Create new account
 * @param {Object} data - Account data
 * @returns {Object} Created account
 */
export async function createAccount(data = {}) {
  if (!isDbInitialized()) throw new Error('Database not initialized');
  
  const { platforms = 0, lastLoginTime, signupIp, lastLoginIp } = data;
  
  const now = new Date().toISOString();
  const result = await dbRun(`
    INSERT INTO accounts (platforms, last_login_time, signup_ip, last_login_ip, created_at)
    VALUES (?, ?, ?, ?, ?)
  `, [platforms, lastLoginTime || now, signupIp || '', lastLoginIp || '', now]);
  
  const accountId = result.lastInsertId;
  return getAccountById(accountId);
}

/**
 * Check if username is taken
 * @param {string} username - Username to check
 * @param {number} excludeAccountId - Account ID to exclude
 * @returns {boolean} True if username is taken
 */
export async function isUsernameTaken(username, excludeAccountId = null) {
  if (!isDbInitialized()) return false;
  let query = 'SELECT account_id FROM accounts WHERE username_lower = ?';
  const params = [username.toLowerCase()];
  if (excludeAccountId) {
    query += ' AND account_id != ?';
    params.push(excludeAccountId);
  }
  const result = await dbGet(query, params);
  return !!result;
}

/**
 * Check if email is taken
 * @param {string} email - Email to check
 * @param {number} excludeAccountId - Account ID to exclude
 * @returns {boolean} True if email is taken
 */
export async function isEmailTaken(email, excludeAccountId = null) {
  if (!isDbInitialized()) return false;
  let query = 'SELECT account_id FROM accounts WHERE email_lower = ?';
  const params = [email.toLowerCase()];
  if (excludeAccountId) {
    query += ' AND account_id != ?';
    params.push(excludeAccountId);
  }
  const result = await dbGet(query, params);
  return !!result;
}

/**
 * Count accounts by platform identity
 * @param {number} platform - Platform type
 * @param {string} platformId - Platform ID
 * @returns {number} Count of accounts
 */
export async function countAccountsForPlatformIdentity(platform, platformId) {
  if (!isDbInitialized()) return 0;
  const result = await dbGet(
    'SELECT COUNT(*) as count FROM platform_links WHERE platform = ? AND platform_id = ?',
    [platform, platformId]
  );
  return result ? result.count : 0;
}

/**
 * Count accounts by signup IP
 * @param {string} ip - IP address
 * @returns {number} Count of accounts
 */
export async function countAccountsBySignupIp(ip) {
  if (!ip || !isDbInitialized()) return 0;
  const result = await dbGet(
    'SELECT COUNT(*) as count FROM accounts WHERE signup_ip = ?',
    [ip]
  );
  return result ? result.count : 0;
}

/**
 * Count accounts by device ID
 * @param {string} deviceId - Device ID
 * @returns {number} Count of accounts
 */
export async function countAccountsByDeviceId(deviceId) {
  if (!deviceId || !isDbInitialized()) return 0;
  const result = await dbGet(
    'SELECT COUNT(*) as count FROM accounts WHERE platform_id = ?',
    [deviceId]
  );
  return result ? result.count : 0;
}

/**
 * Link platform identity to account
 * @param {number} accountId - Account ID
 * @param {number} platform - Platform type
 * @param {string} platformId - Platform ID
 * @param {string[]} roles - User roles
 * @returns {boolean} True if successful
 */
export async function linkPlatformIdentity(accountId, platform, platformId, roles = []) {
  if (!isDbInitialized()) return false;
  
  try {
    await dbRun(`
      INSERT INTO platform_links (account_id, platform, platform_id, roles)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (platform, platform_id) DO NOTHING
    `, [accountId, platform, platformId, JSON.stringify(roles)]);
    
    // Update account's primary platform if not set
    const account = await dbGet('SELECT platform_id FROM accounts WHERE account_id = ?', [accountId]);
    if (account && !account.platform_id) {
      await dbRun('UPDATE accounts SET platform = ?, platform_id = ? WHERE account_id = ?', [platform, platformId, accountId]);
    }
    return true;
  } catch (e) {
    console.error('linkPlatformIdentity error:', e);
    return false;
  }
}

/**
 * Check if platform identity is linked to account
 * @param {number} accountId - Account ID
 * @param {number} platform - Platform type
 * @param {string} platformId - Platform ID
 * @returns {boolean} True if linked
 */
export async function isPlatformIdentityLinked(accountId, platform, platformId) {
  if (!isDbInitialized()) return false;
  const result = await dbGet(
    'SELECT 1 FROM platform_links WHERE account_id = ? AND platform = ? AND platform_id = ?',
    [accountId, platform, platformId]
  );
  return !!result;
}

/**
 * Get links for platform identity
 * @param {number} platform - Platform type
 * @param {string} platformId - Platform ID
 * @returns {Object[]} Array of link records
 */
export async function getLinksForPlatformIdentity(platform, platformId) {
  if (!isDbInitialized()) return [];
  return dbAll('SELECT * FROM platform_links WHERE platform = ? AND platform_id = ?', [platform, platformId]);
}

/**
 * Get links for platform ID (any platform)
 * @param {string} platformId - Platform ID
 * @returns {Object[]} Array of link records
 */
export async function getLinksForPlatformId(platformId) {
  if (!isDbInitialized()) return [];
  return dbAll('SELECT * FROM platform_links WHERE platform_id = ?', [platformId]);
}

/**
 * Get links for identity
 * @param {number} platform - Platform type
 * @param {string} platformId - Platform ID
 * @returns {Object[]} Array of link records
 */
export async function getLinksForIdentity(platform, platformId) {
  return getLinksForPlatformIdentity(platform, platformId);
}

/**
 * Get links for account
 * @param {number} accountId - Account ID
 * @returns {Object[]} Array of link records
 */
export async function getLinksForAccount(accountId) {
  if (!isDbInitialized()) return [];
  return dbAll('SELECT * FROM platform_links WHERE account_id = ?', [accountId]);
}

/**
 * Set last login time
 * @param {number} accountId - Account ID
 * @param {string} time - ISO timestamp
 */
export async function setLastLoginTime(accountId, time) {
  if (!isDbInitialized()) return;
  await dbRun('UPDATE accounts SET last_login_time = ? WHERE account_id = ?', [time, accountId]);
}

/**
 * Set login context (IP)
 * @param {number} accountId - Account ID
 * @param {Object} context - Context object with ip property
 */
export async function setLoginContext(accountId, context) {
  if (!isDbInitialized()) return;
  if (context.ip) {
    await dbRun('UPDATE accounts SET last_login_ip = ? WHERE account_id = ?', [context.ip, accountId]);
  }
}

/**
 * Record account IP
 * @param {number} accountId - Account ID
 * @param {string} ip - IP address
 * @param {Object} meta - Additional metadata
 */
export async function recordAccountIp(accountId, ip, meta = {}) {
  if (!isDbInitialized()) return;
  if (ip) {
    await dbRun('UPDATE accounts SET last_login_ip = ? WHERE account_id = ?', [ip, accountId]);
  }
}

/**
 * Request country from headers
 * @param {Object} c - Hono context
 * @returns {string} Country code
 */
export function requestCountry(c) {
  return c.req.header('cf-ipcountry') || c.req.header('x-country') || 'US';
}

/**
 * Write audit log
 * @param {Object} data - Audit log data
 */
export async function writeAuditLog(data) {
  if (!isDbInitialized()) return;
  await dbRun(
    'INSERT INTO audit_logs (player_id, action, data) VALUES (?, ?, ?)',
    [data.playerId, data.action, JSON.stringify(data.data)]
  );
}
