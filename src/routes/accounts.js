/**
 * RecVerse Server - Accounts Service Route (Cloudflare Workers)
 * Account management & profiles - compatible with February 2023 client
 */

import { Hono } from 'hono';
import {
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
  linkPlatformIdentity,
} from '../auth/middleware.js';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { hashPassword } from '../auth/jwt.js';
import config from '../config.js';

const router = new Hono();

// GET /health
router.get('/health', (c) => {
  return c.json({ service: 'accounts', status: 'ok', version: '1.0.0', gameVersion: config.game.version });
});

// GET /emojiConfig/whitelistedEmojis
router.get('/emojiConfig/whitelistedEmojis', (c) => {
  return c.json([]);
});

// GET /account/me
router.get('/account/me', async (c) => {
  const accountId = c.get('accountId');
  if (!accountId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json(toSelfAccountDto(account));
});

// GET /account/search
router.get('/account/search', async (c) => {
  const name = c.req.query('name');
  if (!name) {
    return c.json([]);
  }
  
  if (!isDbInitialized()) {
    return c.json([]);
  }
  
  const accounts = await dbAll(
    'SELECT * FROM accounts WHERE username_lower LIKE ? OR display_name LIKE ? LIMIT 20',
    [`%${name.toLowerCase()}%`, `%${name.toLowerCase()}%`]
  );
  
  return c.json(accounts.map(a => toAccountDto(a)));
};

// GET /account/username/:name
router.get('/account/username/:name', async (c) => {
  const { name } = c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const account = await dbGet('SELECT * FROM accounts WHERE username_lower = ?', [name.toLowerCase()]);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json(toAccountDto(account));
});

// GET /account/:id
router.get('/account/:id', async (c) => {
  const { id } = c.req.param();
  const accountId = parseInt(id, 10);
  
  if (!accountId || !isDbInitialized()) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json(toAccountDto(account));
});

// POST /account/create
router.post('/account/create', async (c) => {
  try {
    const body = await c.req.json();
    const { username, password, email, platform, platform_id } = body;
    
    if (!username || !password) {
      return c.json({ error: 'Username and password required' }, 400);
    }
    
    if (!isDbInitialized()) {
      return c.json({ error: 'Database not available' }, 500);
    }
    
    // Check if username is taken
    const taken = await isUsernameTaken(username);
    if (taken) {
      return c.json({ error: 'Username already taken' }, 400);
    }
    
    // Check account limits
    const maxPerPlatformId = config.accountLimits.maxPerPlatformId;
    if (maxPerPlatformId > 0 && platform_id) {
      const count = await countAccountsForPlatformIdentity(platform || 0, platform_id);
      if (count >= maxPerPlatformId) {
        return c.json({ error: 'Account limit reached for this platform account' }, 400);
      }
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    
    // Create account
    const account = await createAccount({
      username,
      password_hash: passwordHash,
      email: email || '',
      platforms: platform || 0,
      platform_id: platform_id || '',
      lastLoginTime: new Date().toISOString(),
      signupIp: c.req.header('cf-connecting-ip') || '',
      lastLoginIp: c.req.header('cf-connecting-ip') || '',
    });
    
    // Link platform identity if provided
    if (platform && platform_id) {
      await linkPlatformIdentity(account.account_id, platform, platform_id);
    }
    
    return c.json({
      accountId: account.account_id,
      username: account.username,
      displayName: account.display_name,
      createdAt: account.created_at,
    });
  } catch (error) {
    console.error('Account creation error:', error);
    return c.json({ error: 'server_error', error_description: 'Internal server error' }, 500);
  }
});

// PUT /account/me/displayname
router.put('/account/me/displayname', async (c) => {
  const accountId = c.get('accountId');
  if (!accountId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const { displayName } = await c.req.json();
  if (!displayName) {
    return c.json({ error: 'Display name required' }, 400);
  }
  
  const account = await updateAccount(accountId, { display_name: displayName });
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json({ success: true });
});

// PUT /account/me/username
router.put('/account/me/username', async (c) => {
  const accountId = c.get('accountId');
  if (!accountId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const { username } = await c.req.json();
  if (!username) {
    return c.json({ error: 'Username required' }, 400);
  }
  
  const taken = await isUsernameTaken(username, accountId);
  if (taken) {
    return c.json({ error: 'Username already taken' }, 400);
  }
  
  const account = await updateAccount(accountId, { username, username_lower: username.toLowerCase() });
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json({ success: true });
});

// GET /account/:id/bio
router.get('/account/:id/bio', async (c) => {
  const { id } = c.req.param();
  const accountId = parseInt(id, 10);
  
  if (!accountId || !isDbInitialized()) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json({ bio: account.bio || '' });
});

// PUT /account/me/bio
router.put('/account/me/bio', async (c) => {
  const accountId = c.get('accountId');
  if (!accountId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const { bio } = await c.req.json();
  const account = await updateAccount(accountId, { bio: bio || '' });
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }
  
  return c.json({ success: true });
});

// Helper functions
function toAccountDto(account) {
  return {
    accountId: account.account_id,
    username: account.username,
    displayName: account.display_name,
    profileImage: account.profile_image || '',
    bannerImage: account.banner_image || '',
    displayEmoji: account.display_emoji || '',
    isJunior: account.is_junior === 1,
    platforms: account.platforms || 0,
    personalPronouns: account.personal_pronouns || 0,
    identityFlags: account.identity_flags || 0,
    createdAt: account.created_at,
  };
}

function toSelfAccountDto(account) {
  return {
    ...toAccountDto(account),
    email: account.email || '',
    birthday: account.birthday || '1904-01-01T00:00:00.000Z',
    availableUsernameChanges: account.available_username_changes !== undefined ? account.available_username_changes : 3,
    isDeleted: account.is_deleted === 1,
  };
}

export default router;
