/**
 * RecVerse Auth Service
 * OAuth2 token endpoints, authentication, device authorization - compatible with February 2023 client
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const crypto = require('crypto');

const {
  validateAndGetAccountId,
  requireAuth,
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
  setLastLoginTime,
  setLoginContext,
  recordAccountIp,
  requestCountry,
  writeAuditLog,
  validateAndGetPlus,
  hashPassword,
  verifyPassword,
  generateToken,
} = require('./verse-auth-middleware');

const { generateCode, hashCode, now, parsePlatformType, getPlatformName, isSupportedGameVersion, isRolloutGameVersion } = require('./verse-utils');
const { getDb } = require('./verse-db');
const config = require('./verse-config');
const logger = require('./verse-logger');

const router = express.Router();

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'invalid_grant', 
      error_description: errors.array()[0].msg 
    });
  }
  next();
};

// OAuth error response
function oauthError(res, error, description, status = 400) {
  return res.status(status).json({ error, error_description: description });
}

// Token scope
const TOKEN_SCOPE = 'offline_access profile rn rn.accounts rn.accounts.gc rn.api rn.chat rn.clubs rn.commerce rn.match.read rn.match.write rn.notify rn.rooms rn.storage';
const TOKEN_TTL = config.jwt.accessTokenTtl;

/**
 * GET /eac/challenge - EAC challenge (stub)
 */
router.get('/eac/challenge', (req, res) => {
  res.type('text/plain').send('"AA=="');
});

/**
 * GET/POST /cachedlogin/forplatformid/:platform/:id - Cached login lookup
 */
const cachedLoginHandler = async (req, res) => {
  try {
    const platform = parseInt(req.params.platform, 10);
    const id = req.params.id;
    
    logger.auth('Cached login lookup', { platform, id });
    
    // Sideloaded Oculus placeholder (platform 1, id "1")
    if (platform === 1 && id === '1') {
      return res.json([{
        platform: 1,
        platformId: '1',
        accountId: 1,
        lastLoginTime: '2026-07-19T17:13:29.225Z',
        requirePassword: true,
      }]);
    }
    
    const links = isNaN(platform) 
      ? await getLinksForPlatformId(id)
      : await getLinksForPlatformIdentity(platform, id);
    
    const results = [];
    for (const link of links) {
      const account = await getAccountById(link.account_id);
      if (account) {
        results.push({
          platform: link.platform,
          platformId: link.platform_id,
          accountId: account.account_id,
          lastLoginTime: account.last_login_time || account.created_at,
          requirePassword: false,
        });
      }
    }
    
    res.json(results);
  } catch (error) {
    logger.error('AUTH', 'Cached login lookup failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

router.get('/cachedlogin/forplatformid/:platform/:id', cachedLoginHandler);
router.post('/cachedlogin/forplatformid/:platform/:id', cachedLoginHandler);

/**
 * POST /cachedlogin/forplatformids - Bulk cached login lookup
 */
router.post('/cachedlogin/forplatformids', async (req, res) => {
  try {
    const ids = (req.body.id || [])
      .flatMap(v => (Array.isArray(v) ? v : [v]))
      .map(String);
    
    const results = [];
    for (const pid of ids) {
      const links = await getLinksForPlatformId(pid);
      for (const link of links) {
        const account = await getAccountById(link.account_id);
        if (account) {
          results.push({
            platform: link.platform,
            platformId: link.platform_id,
            accountId: account.account_id,
            lastLoginTime: account.last_login_time || account.created_at,
            requirePassword: false,
          });
        }
      }
    }
    
    res.json(results);
  } catch (error) {
    logger.error('AUTH', 'Bulk cached login failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /connect/deviceauthorization - Studio device authorization
 */
router.post('/connect/deviceauthorization', async (req, res) => {
  try {
    const clientId = req.body.client_id;
    const clientSecret = req.body.client_secret;
    
    if (clientId !== 'recroom.studio') {
      return oauthError(res, 'unauthorized_client', 'Invalid client');
    }
    
    // Generate device code
    const deviceCode = crypto.randomBytes(32).toString('hex');
    const userCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
    
    const db = getDb();
    db.prepare(`
      INSERT INTO studio_device_grants (user_code, client_id, expires_at)
      VALUES (?, ?, ?)
    `).run(userCode, clientId, expiresAt);
    
    const www = config.server.baseUrl.replace('auth', 'www');
    const verificationUri = `${www}/device`;
    
    res.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${userCode}`,
      expires_in: 900,
      interval: 5,
    });
  } catch (error) {
    logger.error('AUTH', 'Device authorization failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /connect/token - OAuth2 token endpoint
 */
router.post('/connect/token', async (req, res) => {
  try {
    const grantType = req.body.grant_type;
    const clientIp = requestCountry(req); // Actually using for IP, but function returns country. Let's get IP from headers.
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '';
    
    logger.auth('Token request', { grantType, ip });
    
    // Handle different grant types
    switch (grantType) {
      case 'password':
        return handlePasswordGrant(req, res, ip);
      case 'cached_login':
        return handleCachedLoginGrant(req, res, ip);
      case 'refresh_token':
        return handleRefreshTokenGrant(req, res, ip);
      case 'identity_assertion':
        return handleIdentityAssertionGrant(req, res, ip);
      case 'device_code':
        return handleDeviceCodeGrant(req, res, ip);
      default:
        return oauthError(res, 'unsupported_grant_type', 'Unsupported grant type');
    }
  } catch (error) {
    logger.error('AUTH', 'Token endpoint error', { error: error.message });
    return oauthError(res, 'server_error', 'Internal server error', 500);
  }
});

/**
 * Password grant - username/password login
 */
async function handlePasswordGrant(req, res, ip) {
  const username = req.body.username;
  const password = req.body.password;
  const platformAuth = req.body.platform_auth;
  const platform = req.body.platform ? parseInt(req.body.platform, 10) : null;
  const platformId = req.body.platform_id;
  const deviceId = req.body.device_id;
  const ver = req.body.ver;
  
  if (!username || !password) {
    return oauthError(res, 'invalid_grant', 'Username and password required');
  }
  
  // Check game version
  if (ver && !isSupportedGameVersion(ver)) {
    return oauthError(res, 'invalid_grant', 'This game version is not supported by this server; update your game');
  }
  
  if (ver && isRolloutGameVersion(ver)) {
    // Check rollout access - for now allow all
  }
  
  // Find account by username or email
  let account = await getAccountByUsername(username);
  if (!account && username.includes('@')) {
    account = await getAccountByEmail(username);
  }
  
  if (!account) {
    return oauthError(res, 'invalid_grant', 'Invalid username or password');
  }
  
  // Verify password
  if (!account.password_hash || !(await verifyPassword(password, account.password_hash))) {
    return oauthError(res, 'invalid_grant', 'Invalid username or password');
  }
  
  // Check if account is deleted
  if (account.is_deleted) {
    return oauthError(res, 'invalid_grant', 'Account is deleted');
  }
  
  // Verify platform auth if provided
  if (platformAuth && platform && platformId) {
    // TODO: Implement Steam/Meta ticket verification
    // For now, accept and link
    await linkPlatformIdentity(account.account_id, platform, platformId);
  }
  
  // Link device ID if provided
  if (deviceId) {
    // Store device ID on account
    await updateAccount(account.account_id, { platform_id: deviceId });
  }
  
  // Issue session
  return await issueSession(res, account, ip, 'password', { 
    ver,
    deviceId,
  });
}

/**
 * Cached login grant - platform identity login
 */
async function handleCachedLoginGrant(req, res, ip) {
  const accountId = parseInt(req.body.account_id, 10);
  const platform = req.body.platform ? parseInt(req.body.platform, 10) : null;
  const platformId = req.body.platform_id;
  const platformAuth = req.body.platform_auth;
  const ver = req.body.ver;
  
  if (!accountId) {
    return oauthError(res, 'invalid_grant', 'Account ID required');
  }
  
  // Check game version
  if (ver && !isSupportedGameVersion(ver)) {
    return oauthError(res, 'invalid_grant', 'This game version is not supported by this server; update your game');
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return oauthError(res, 'invalid_grant', 'Account not found');
  }
  
  // Verify platform auth if provided
  if (platformAuth && platform && platformId) {
    const linked = await isPlatformIdentityLinked(accountId, platform, platformId);
    if (!linked) {
      return oauthError(res, 'invalid_grant', 'Platform identity not linked to this account');
    }
    // TODO: Verify Steam ticket / Meta nonce
  }
  
  return await issueSession(res, account, ip, 'cached_login', { ver });
}

/**
 * Refresh token grant
 */
async function handleRefreshTokenGrant(req, res, ip) {
  const refreshToken = req.body.refresh_token;
  
  if (!refreshToken) {
    return oauthError(res, 'invalid_grant', 'Refresh token required');
  }
  
  const db = getDb();
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  
  const tokenRow = db.prepare(`
    SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(tokenHash, now());
  
  if (!tokenRow) {
    return oauthError(res, 'invalid_grant', 'Invalid or expired refresh token');
  }
  
  // Revoke old token
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?').run(now(), tokenHash);
  
  const account = await getAccountById(tokenRow.account_id);
  if (!account) {
    return oauthError(res, 'invalid_grant', 'Account no longer exists');
  }
  
  return await issueSession(res, account, ip, 'refresh_token');
}

/**
 * Identity assertion grant - Discord/third-party
 */
async function handleIdentityAssertionGrant(req, res, ip) {
  const assertion = req.body.assertion;
  
  if (!assertion) {
    return oauthError(res, 'invalid_grant', 'Identity assertion required');
  }
  
  // Verify JWT assertion
  const jwt = require('jsonwebtoken');
  let identity;
  try {
    identity = jwt.verify(assertion, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: 'recverse-identity',
    });
  } catch (e) {
    return oauthError(res, 'invalid_grant', 'Invalid or expired identity assertion');
  }
  
  const platform = identity.platform;
  const platformId = identity.platform_id;
  
  // Find linked account
  const links = await getLinksForIdentity(platform, platformId);
  
  if (links.length > 1) {
    return oauthError(res, 'invalid_grant', 'Platform identity is linked to more than one account');
  }
  
  if (links.length === 1) {
    const account = await getAccountById(links[0].account_id);
    return await issueSession(res, account, ip, 'identity_assertion');
  }
  
  // Create new account (Discord signup)
  // Check signup caps
  const maxPerPlatformId = config.accountLimits.maxPerPlatformId;
  if (maxPerPlatformId > 0) {
    const count = await countAccountsForPlatformIdentity(platform, platformId);
    if (count >= maxPerPlatformId) {
      return oauthError(res, 'invalid_grant', 'Account limit reached for this platform account');
    }
  }
  
  const maxPerIp = config.accountLimits.maxPerIp;
  if (maxPerIp > 0 && ip) {
    const count = await countAccountsBySignupIp(ip);
    if (count >= maxPerIp) {
      return oauthError(res, 'invalid_grant', 'Too many accounts created from this network');
    }
  }
  
  const account = await createAccount({
    platforms: 0,
    lastLoginTime: now(),
    signupIp: ip,
    lastLoginIp: ip,
  });
  
  await linkPlatformIdentity(account.account_id, platform, platformId);
  
  // Place in orientation
  const db = getDb();
  db.prepare(`
    INSERT INTO presence (account_id, room_instance_id, room_id, sub_room_id, room_instance_type, 
      location, data_blob, photon_region, photon_region_id, photon_room_id, name, max_capacity,
      is_full, is_private, is_in_progress, encrypt_voice_chat, status_visibility, device_class,
      vr_movement_mode, platform, app_version)
    VALUES (?, -2, 13, 1, 0, 'Orientation', '', 'us', 'us', 'rec.13', '^Orientation', 4, 0, 0, 0, 0, 0, 0, 1, 0, ?)
  `).run(account.account_id, config.game.version);
  
  return await issueSession(res, account, ip, 'identity_assertion', { created: true });
}

/**
 * Device code grant - Studio approval
 */
async function handleDeviceCodeGrant(req, res, ip) {
  const deviceCode = req.body.device_code;
  const clientId = req.body.client_id;
  
  if (!deviceCode || clientId !== 'recroom.studio') {
    return oauthError(res, 'invalid_grant', 'Invalid device code or client');
  }
  
  const db = getDb();
  const grant = db.prepare('SELECT * FROM studio_device_grants WHERE user_code = ?').get(deviceCode);
  
  if (!grant) {
    return oauthError(res, 'invalid_grant', 'Device code not found');
  }
  
  if (grant.expires_at < now()) {
    return oauthError(res, 'expired_token', 'That code has expired. Start the login in Studio again.');
  }
  
  if (grant.approved_at) {
    if (grant.account_id) {
      const account = await getAccountById(grant.account_id);
      return await issueSession(res, account, ip, 'device_code');
    }
    return oauthError(res, 'invalid_grant', 'That code was already used.');
  }
  
  if (grant.denied_at) {
    return oauthError(res, 'access_denied', 'That code was denied.');
  }
  
  return oauthError(res, 'authorization_pending', 'Waiting for user approval');
}

/**
 * Issue session tokens
 */
async function issueSession(res, account, ip, grantType, extra = {}) {
  const db = getDb();
  
  // Check for ban
  const ban = db.prepare(`
    SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
  `).get(account.account_id, now());
  
  if (ban) {
    logger.auth('Token issued to banned account', { accountId: account.account_id, grantType });
    // Still issue token - match service handles blocking
  }
  
  // Generate access token
  const accessToken = generateToken({
    sub: String(account.account_id),
    platform_id: account.platform_id || '',
    platform: account.platform || 0,
    roles: getAccountRoles(account),
    privileges: getAccountPrivileges(account),
    rn: {
      ver: config.game.version,
      plus: account.has_plus === 1,
    },
  });
  
  // Generate refresh token
  const refreshToken = crypto.randomBytes(64).toString('hex');
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const refreshExpires = new Date(Date.now() + config.jwt.refreshTokenTtl * 1000).toISOString();
  
  db.prepare(`
    INSERT INTO refresh_tokens (token_hash, account_id, expires_at)
    VALUES (?, ?, ?)
  `).run(refreshTokenHash, account.account_id, refreshExpires);
  
  // Update login time and context
  await setLastLoginTime(account.account_id, now());
  await setLoginContext(account.account_id, { ip });
  await recordAccountIp(account.account_id, ip, { country: requestCountry({ headers: { 'cf-ipcountry': 'US' } }) });
  
  // Audit log for staff
  if (account.is_developer || account.is_moderator) {
    await writeAuditLog({
      playerId: account.account_id,
      action: 'staff_login',
      data: { ip, roles: getAccountRoles(account), grantType, username: account.username },
    });
  }
  
  logger.auth('Token issued', { accountId: account.account_id, grantType });
  
  return res.json({
    access_token: accessToken,
    expires_in: TOKEN_TTL,
    token_type: 'Bearer',
    refresh_token: refreshToken,
    scope: TOKEN_SCOPE,
    key: '8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY=', // RecNet compatibility key
    ...extra,
  });
}

/**
 * Get account roles for token
 */
function getAccountRoles(account) {
  const roles = [];
  if (account.has_screenshare) roles.push('screenshare');
  if (account.is_developer) roles.push('developer');
  if (account.is_moderator) roles.push('moderator');
  if (account.is_junior) roles.push('junior');
  // betastudio would require Studio access check
  if (account.is_influencer) roles.push('influencer');
  return roles;
}

/**
 * Get account privileges for token
 */
function getAccountPrivileges(account) {
  if (account.is_junior) return ['BanVChat', 'BanRmChat'];
  return [];
}

/**
 * POST /account/recoverpassword - Forgot password
 */
router.post('/account/recoverpassword', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  
  // Always return success to prevent email enumeration
  if (!email) {
    return res.json({ Success: true, Error: null, error_id: null });
  }
  
  const account = await getAccountByEmail(email);
  if (!account) {
    return res.json({ Success: true, Error: null, error_id: null });
  }
  
  // TODO: Send recovery email
  // For now, just log and return success
  logger.auth('Password recovery requested', { accountId: account.account_id, email });
  
  res.json({ Success: true, Error: null, error_id: null });
});

/**
 * POST /account/resetpassword - Reset password (from email link)
 */
router.post('/account/resetpassword', async (req, res) => {
  // TODO: Implement with token from email
  res.json({ Success: true, Error: null });
});

/**
 * POST /account/changepassword - Change password (authenticated)
 */
router.post('/account/changepassword', requireAuth, [
  body('currentPassword').isString().notEmpty(),
  body('newPassword').isString().isLength({ min: 8 }),
  validate,
], async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const account = await getAccountById(req.accountId);
    
    if (!account || !account.password_hash) {
      return res.json({ success: false, error: 'Set a password first' });
    }
    
    if (!(await verifyPassword(currentPassword, account.password_hash))) {
      return res.json({ success: false, error: 'Current password is incorrect' });
    }
    
    const hash = await hashPassword(newPassword);
    await updateAccount(req.accountId, { password_hash: hash });
    
    // Revoke all refresh tokens
    const db = getDb();
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE account_id = ?').run(now(), req.accountId);
    
    logger.auth('Password changed', { accountId: req.accountId });
    res.json({ success: true });
  } catch (error) {
    logger.error('AUTH', 'Password change failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /role/{role}/{id} - Single role lookup
 */
router.get('/role/:role/:id', async (req, res) => {
  const { role, id } = req.params;
  const accountId = parseInt(id, 10);
  
  if (isNaN(accountId)) {
    return res.status(404).send(); // Empty 404 per spec
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return res.status(404).send();
  }
  
  let hasRole = false;
  switch (role) {
    case 'developer': hasRole = account.is_developer === 1; break;
    case 'moderator': hasRole = account.is_moderator === 1; break;
    case 'screenshare': hasRole = account.has_screenshare === 1; break;
  }
  
  res.json(hasRole);
});

/**
 * GET /role/{role}?id=1&id=2 - Bulk role lookup
 */
router.get('/role/:role', async (req, res) => {
  const { role } = req.params;
  const ids = (req.query.id || [])
    .flatMap(v => v.split(','))
    .map(v => parseInt(v.trim(), 10))
    .filter(n => !isNaN(n));
  
  const uniqueIds = [...new Set(ids)];
  const accounts = await getAccountsByIds(uniqueIds);
  const accountMap = new Map(accounts.map(a => [a.account_id, a]));
  
  const results = [];
  for (const id of uniqueIds) {
    const account = accountMap.get(id);
    if (account) {
      let hasRole = false;
      switch (role) {
        case 'developer': hasRole = account.is_developer === 1; break;
        case 'moderator': hasRole = account.is_moderator === 1; break;
        case 'screenshare': hasRole = account.has_screenshare === 1; break;
      }
      if (hasRole) results.push(id);
    }
  }
  
  res.json(results);
});

module.exports = router;