/**
 * RecVerse Server Utilities
 * Common helper functions
 */

const crypto = require('crypto');
const config = require('./verse-config');

/**
 * Generate a secure random string
 */
function randomString(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a UUID v4
 */
function generateUuid() {
  return crypto.randomUUID();
}

/**
 * Hash a password using bcrypt
 */
async function hashPassword(password) {
  const bcrypt = require('bcryptjs');
  return bcrypt.hash(password, 12);
}

/**
 * Verify a password against bcrypt hash
 */
async function verifyPassword(password, hash) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(password, hash);
}

/**
 * Hash a token for storage (SHA-256)
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a JWT token
 */
function generateToken(payload, options = {}) {
  const jwt = require('jsonwebtoken');
  const secret = config.jwt.secret;
  const defaultOptions = {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: config.jwt.accessTokenTtl,
  };
  return jwt.sign(payload, secret, { ...defaultOptions, ...options });
}

/**
 * Verify a JWT token
 */
function verifyToken(token) {
  const jwt = require('jsonwebtoken');
  try {
    return jwt.verify(token, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch (e) {
    return null;
  }
}

/**
 * Generate a 6-digit numeric code
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Hash a code for storage
 */
function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Get current ISO timestamp
 */
function now() {
  return new Date().toISOString();
}

/**
 * Parse platform type from string
 */
function parsePlatformType(platform) {
  const map = {
    steam: 0,
    oculus: 1,
    ps4: 2,
    xbox: 3,
    switch: 4,
    ios: 5,
    android: 6,
    windows: 7,
    mac: 8,
    discord: 101,
  };
  if (typeof platform === 'string') {
    const val = map[platform.toLowerCase()];
    return (val !== undefined && val !== null) ? val : (parseInt(platform, 10) || 0);
  }
  return platform;
}

/**
 * Get platform name from type
 */
function getPlatformName(type) {
  const names = {
    0: 'Steam',
    1: 'Oculus',
    2: 'PS4',
    3: 'Xbox',
    4: 'Switch',
    5: 'iOS',
    6: 'Android',
    7: 'Windows',
    8: 'Mac',
    101: 'Discord',
  };
  return (names[type] !== undefined && names[type] !== null) ? names[type] : 'Unknown';
}

/**
 * Check if game version is supported
 */
function isSupportedGameVersion(version) {
  const cleanVersion = version.split('.')[0]; // Strip point release
  return config.game.supportedVersions.includes(cleanVersion);
}

/**
 * Check if game version is in rollout
 */
function isRolloutGameVersion(version) {
  const cleanVersion = version.split('.')[0];
  return config.game.rolloutVersions.includes(cleanVersion);
}

/**
 * Get supported game builds
 */
function supportedGameBuilds() {
  return config.game.supportedVersions;
}

/**
 * Get rollout game builds
 */
function rolloutGameBuilds() {
  return config.game.rolloutVersions;
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deep clone object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Sanitize string for safe output
 */
function sanitizeString(str, maxLength = 1000) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLength).replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Format account DTO for client (public)
 */
function toAccountDto(account) {
  return {
    accountId: account.account_id,
    username: account.username,
    displayName: account.display_name,
    profileImage: account.profile_image,
    bannerImage: (account.banner_image !== undefined && account.banner_image !== null) ? account.banner_image : '',
    displayEmoji: (account.display_emoji !== undefined && account.display_emoji !== null) ? account.display_emoji : '',
    isJunior: account.is_junior === 1,
    platforms: (account.platforms !== undefined && account.platforms !== null) ? account.platforms : 0,
    personalPronouns: (account.personal_pronouns !== undefined && account.personal_pronouns !== null) ? account.personal_pronouns : 0,
    identityFlags: (account.identity_flags !== undefined && account.identity_flags !== null) ? account.identity_flags : 0,
    createdAt: account.created_at,
  };
}

/**
 * Format account DTO for client (private/self)
 */
function toSelfAccountDto(account) {
  return {
    ...toAccountDto(account),
    email: (account.email !== undefined && account.email !== null) ? account.email : '',
    birthday: (account.birthday !== undefined && account.birthday !== null) ? account.birthday : '1904-01-01T00:00:00.000Z',
    availableUsernameChanges: (account.available_username_changes !== undefined && account.available_username_changes !== null) ? account.available_username_changes : 3,
    isDeleted: account.is_deleted === 1,
    ...(account.is_deleted === 1 && account.deleted_at ? { deletedAt: account.deleted_at } : {}),
  };
}

/**
 * Build service endpoints for discovery
 */
function buildEndpoints(domain, subdomains = {}) {
  const SERVICE_SUBDOMAINS = {
    Accounts: 'accounts',
    AI: 'ai',
    API: 'api',
    Auth: 'auth',
    BugReporting: 'bugreporting',
    Cards: 'cards',
    CDN: 'cdn',
    Chat: 'chat',
    Clubs: 'clubs',
    CMS: 'cms',
    Commerce: 'commerce',
    Data: 'data',
    DataCollection: 'datacollection',
    Discovery: 'discovery',
    Econ: 'econ',
    GameLogs: 'gamelogs',
    Geo: 'geo',
    Images: 'img',
    Leaderboard: 'leaderboard',
    Link: 'link',
    Lists: 'lists',
    Matchmaking: 'match',
    Moderation: 'moderation',
    Notifications: 'notify',
    PlatformNotifications: 'platformnotifications',
    PlayerSettings: 'playersettings',
    RoomComments: 'roomcomments',
    RoomieIntegrations: 'roomieintegrations',
    Rooms: 'rooms',
    Storage: 'storage',
    Strings: 'strings',
    StringsCDN: 'strings-cdn',
    Studio: 'studio',
    Thorn: 'thorn',
    Videos: 'videos',
    WWW: 'www',
  };

  const protocol = config.server.protocol;
  const port = config.server.port;
  const portSuffix = (protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443) ? `:${port}` : '';
  const baseDomain = `${domain}${portSuffix}`;

  const overrides = typeof subdomains === 'string' ? JSON.parse(subdomains) : subdomains;

  return Object.fromEntries(
    Object.entries(SERVICE_SUBDOMAINS).map(([label, sub]) => [
      label,
      `${protocol}://${(overrides[sub] !== undefined && overrides[sub] !== null) ? overrides[sub] : sub}.${baseDomain}`,
    ])
  );
}

module.exports = {
  randomString,
  generateUuid,
  hashPassword,
  verifyPassword,
  hashToken,
  generateToken,
  verifyToken,
  generateCode,
  hashCode,
  now,
  parsePlatformType,
  getPlatformName,
  isSupportedGameVersion,
  isRolloutGameVersion,
  supportedGameBuilds,
  rolloutGameBuilds,
  sleep,
  deepClone,
  sanitizeString,
  toAccountDto,
  toSelfAccountDto,
  buildEndpoints,
};