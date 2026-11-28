/**
 * RecVerse Server - Auth Service Route (Cloudflare Workers)
 * OAuth2 token endpoints, authentication - compatible with February 2023 client
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { verifyToken, generateToken, hashPassword, verifyPassword } from '../auth/jwt.js';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import config from '../config.js';

const router = new Hono();

// GET /eac/challenge - EAC challenge (stub)
router.get('/eac/challenge', (c) => {
  return c.text('"AA=="');
});

// POST /connect/token - OAuth2 token endpoint
router.post('/connect/token', async (c) => {
  try {
    const body = await c.req.json();
    const grantType = body.grant_type;
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-ip') || c.req.header('x-real-ip') || '';
    
    console.log('Token request', { grantType, ip });
    
    switch (grantType) {
      case 'password':
        return handlePasswordGrant(c, body, ip);
      case 'cached_login':
        return handleCachedLoginGrant(c, body, ip);
      case 'refresh_token':
        return handleRefreshTokenGrant(c, body, ip);
      case 'device_code':
        return handleDeviceCodeGrant(c, body, ip);
      default:
        return c.json({ error: 'unsupported_grant_type', error_description: 'Unsupported grant type' }, 400);
    }
  } catch (error) {
    console.error('Token endpoint error', { error: error.message });
    return c.json({ error: 'server_error', error_description: 'Internal server error' }, 500);
  }
});

// Password grant - username/password login
async function handlePasswordGrant(c, body, ip) {
  const { username, password, platform, platform_id, device_id, ver } = body;
  
  if (!username || !password) {
    return c.json({ error: 'invalid_grant', error_description: 'Username and password required' }, 400);
  }
  
  // Check game version
  if (ver && !isSupportedGameVersion(ver)) {
    return c.json({ error: 'invalid_grant', error_description: 'This game version is not supported by this server; update your game' }, 400);
  }
  
  if (!isDbInitialized()) {
    return c.json({ error: 'server_error', error_description: 'Database not available' }, 500);
  }
  
  // Find account by username or email
  let account = await dbGet('SELECT * FROM accounts WHERE username_lower = ?', [username.toLowerCase()]);
  if (!account && username.includes('@')) {
    account = await dbGet('SELECT * FROM accounts WHERE email_lower = ?', [username.toLowerCase()]);
  }
  
  if (!account) {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid username or password' }, 400);
  }
  
  // Verify password
  if (!account.password_hash || !(await verifyPassword(password, account.password_hash))) {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid username or password' }, 400);
  }
  
  // Check if account is deleted
  if (account.is_deleted) {
    return c.json({ error: 'invalid_grant', error_description: 'Account is deleted' }, 400);
  }
  
  // Link device ID if provided
  if (device_id) {
    await dbRun('UPDATE accounts SET platform_id = ? WHERE account_id = ?', [device_id, account.account_id]);
  }
  
  // Issue session
  return issueSession(c, account, ip, 'password', { ver, deviceId: device_id });
}

// Issue session tokens
async function issueSession(c, account, ip, grantType, extra = {}) {
  if (!isDbInitialized()) {
    return c.json({ error: 'server_error', error_description: 'Database not available' }, 500);
  }
  
  // Check for ban
  const ban = await dbGet(
    'SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > NOW())',
    [account.account_id]
  );
  
  if (ban) {
    console.log('Token issued to banned account', { accountId: account.account_id, grantType });
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
  
  await dbRun(
    `INSERT INTO refresh_tokens (token_hash, account_id, expires_at) VALUES (?, ?, ?)`,
    [refreshTokenHash, account.account_id, refreshExpires]
  );
  
  // Update login time and context
  await dbRun('UPDATE accounts SET last_login_time = NOW() WHERE account_id = ?', [account.account_id]);
  if (ip) {
    await dbRun('UPDATE accounts SET last_login_ip = ? WHERE account_id = ?', [ip, account.account_id]);
  }
  
  return c.json({
    access_token: accessToken,
    expires_in: config.jwt.accessTokenTtl,
    token_type: 'Bearer',
    refresh_token: refreshToken,
    scope: 'offline_access profile rn rn.accounts rn.accounts.gc rn.api rn.chat rn.clubs rn.commerce rn.match.read rn.match.write rn.notify rn.rooms rn.storage',
    key: '8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY=',
    ...extra,
  });
}

function getAccountRoles(account) {
  const roles = [];
  if (account.has_screenshare) roles.push('screenshare');
  if (account.is_developer) roles.push('developer');
  if (account.is_moderator) roles.push('moderator');
  if (account.is_junior) roles.push('junior');
  if (account.is_influencer) roles.push('influencer');
  return roles;
}

function getAccountPrivileges(account) {
  if (account.is_junior) return ['BanVChat', 'BanRmChat'];
  return [];
}

async function handleCachedLoginGrant(c, body, ip) {
  const accountId = parseInt(body.account_id, 10);
  const platform = body.platform ? parseInt(body.platform, 10) : null;
  const platformId = body.platform_id;
  const ver = body.ver;
  
  if (!accountId) {
    return c.json({ error: 'invalid_grant', error_description: 'Account ID required' }, 400);
  }
  
  if (ver && !isSupportedGameVersion(ver)) {
    return c.json({ error: 'invalid_grant', error_description: 'This game version is not supported by this server; update your game' }, 400);
  }
  
  const account = await dbGet('SELECT * FROM accounts WHERE account_id = ?', [accountId]);
  if (!account) {
    return c.json({ error: 'invalid_grant', error_description: 'Account not found' }, 400);
  }
  
  return issueSession(c, account, ip, 'cached_login', { ver });
}

async function handleRefreshTokenGrant(c, body, ip) {
  const refreshToken = body.refresh_token;
  
  if (!refreshToken) {
    return c.json({ error: 'invalid_grant', error_description: 'Refresh token required' }, 400);
  }
  
  if (!isDbInitialized()) {
    return c.json({ error: 'server_error', error_description: 'Database not available' }, 500);
  }
  
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  
  const tokenRow = await dbGet(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()',
    [tokenHash]
  );
  
  if (!tokenRow) {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
  }
  
  // Revoke old token
  await dbRun('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?', [tokenHash]);
  
  const account = await dbGet('SELECT * FROM accounts WHERE account_id = ?', [tokenRow.account_id]);
  if (!account) {
    return c.json({ error: 'invalid_grant', error_description: 'Account no longer exists' }, 400);
  }
  
  return issueSession(c, account, ip, 'refresh_token');
}

async function handleDeviceCodeGrant(c, body, ip) {
  const deviceCode = body.device_code;
  const clientId = body.client_id;
  
  if (!deviceCode || clientId !== 'recroom.studio') {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid device code or client' }, 400);
  }
  
  if (!isDbInitialized()) {
    return c.json({ error: 'server_error', error_description: 'Database not available' }, 500);
  }
  
  const grant = await dbGet('SELECT * FROM studio_device_grants WHERE user_code = ?', [deviceCode]);
  
  if (!grant) {
    return c.json({ error: 'invalid_grant', error_description: 'Device code not found' }, 400);
  }
  
  if (grant.expires_at < new Date().toISOString()) {
    return c.json({ error: 'expired_token', error_description: 'That code has expired. Start the login in Studio again.' }, 400);
  }
  
  if (grant.approved_at) {
    if (grant.account_id) {
      const account = await dbGet('SELECT * FROM accounts WHERE account_id = ?', [grant.account_id]);
      return issueSession(c, account, ip, 'device_code');
    }
    return c.json({ error: 'invalid_grant', error_description: 'That code was already used.' }, 400);
  }
  
  if (grant.denied_at) {
    return c.json({ error: 'access_denied', error_description: 'That code was denied.' }, 400);
  }
  
  return c.json({ error: 'authorization_pending', error_description: 'Waiting for user approval' }, 400);
}

export default router;
