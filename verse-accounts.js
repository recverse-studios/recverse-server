/**
 * RecVerse Accounts Service
 * Account management & profiles - compatible with February 2023 client
 */

import express from 'express';
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
} from './verse-auth-middleware.js';
import { isDbInitialized } from './verse-db.js';
import config from './verse-config.js';

const router = express.Router();

// GET /health
router.get('/health', (req, res) => {
  res.json({ service: 'accounts', status: 'ok', version: '1.0.0', gameVersion: config.game.version });
});

// GET /emojiConfig/whitelistedEmojis
router.get('/emojiConfig/whitelistedEmojis', (req, res) => {
  res.json([]);
});

// GET /account/me
router.get('/account/me', async (req, res) => {
  const accountId = req.accountId;
  if (!accountId) {
    return res.status(401).send(); // Empty body per RecNet convention
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return res.status(404).send();
  }
  
  res.json(toSelfAccountDto(account));
});

// GET /account/search
router.get('/account/search', async (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.status(400).json({ error: 'name parameter required' });
  }
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const db = getDb();
  const accounts = db.prepare(
    'SELECT * FROM accounts WHERE username_lower LIKE ? OR display_name LIKE ? LIMIT 20'
  ).all(`%${name.toLowerCase()}%`, `%${name.toLowerCase()}%`);
  
  res.json(accounts.map(a => toAccountDto(a)));
});

// GET /account/username/:name
router.get('/account/username/:name', async (req, res) => {
  const { name } = req.params;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE username_lower = ?').get(name.toLowerCase());
  
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  
  res.json(toAccountDto(account));
});

// GET /account/:id
router.get('/account/:id', async (req, res) => {
  const { id } = req.params;
  const accountId = parseInt(id, 10);
  
  if (!accountId || !isDbInitialized()) {
    return res.status(404).send();
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return res.status(404).send();
  }
  
  res.json(toAccountDto(account));
});

// POST /account/create
router.post('/account/create', async (req, res) => {
  try {
    const { username, password, email, platform, platform_id } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (!isDbInitialized()) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    
    // Check if username is taken
    const taken = await isUsernameTaken(username);
    if (taken) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    
    // Check account limits
    const maxPerPlatformId = config.accountLimits.maxPerPlatformId;
    if (maxPerPlatformId > 0 && platform_id) {
      const count = await countAccountsForPlatformIdentity(platform || 0, platform_id);
      if (count >= maxPerPlatformId) {
        return res.status(400).json({ error: 'Account limit reached for this platform account' });
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
      lastLoginTime: now(),
      signupIp: req.ip,
      lastLoginIp: req.ip,
    });
    
    // Link platform identity if provided
    if (platform && platform_id) {
      await linkPlatformIdentity(account.account_id, platform, platform_id);
    }
    
    res.json({
      accountId: account.account_id,
      username: account.username,
      displayName: account.display_name,
      createdAt: account.created_at,
    });
  } catch (error) {
    logger.error('ACCOUNTS', 'Account creation failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /account/me/displayname
router.put('/account/me/displayname', async (req, res) => {
  const accountId = req.accountId;
  if (!accountId) {
    return res.status(401).send();
  }
  
  const { displayName } = req.body;
  if (!displayName) {
    return res.status(400).json({ error: 'Display name required' });
  }
  
  const account = await updateAccount(accountId, { display_name: displayName });
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  
  res.json({ success: true });
});

// PUT /account/me/username
router.put('/account/me/username', async (req, res) => {
  const accountId = req.accountId;
  if (!accountId) {
    return res.status(401).send();
  }
  
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  const taken = await isUsernameTaken(username, accountId);
  if (taken) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  
  const account = await updateAccount(accountId, { 
    username, 
    username_lower: username.toLowerCase() 
  });
  
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  
  res.json({ success: true });
});

// GET /account/:id/bio
router.get('/account/:id/bio', async (req, res) => {
  const { id } = req.params;
  const accountId = parseInt(id, 10);
  
  if (!accountId || !isDbInitialized()) {
    return res.status(404).send();
  }
  
  const account = await getAccountById(accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  
  res.json({ bio: account.bio || '' });
});

// PUT /account/me/bio
router.put('/account/me/bio', async (req, res) => {
  const accountId = req.accountId;
  if (!accountId) {
    return res.status(401).send();
  }
  
  const { bio } = req.body;
  const account = await updateAccount(accountId, { bio: bio || '' });
  
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  
  res.json({ success: true });
});

// Helper functions
function toAccountDto(account) {
  return {
    accountId: account.account_id,
    username: account.username,
    displayName: account.display_name,
    profileImage: account.profile_image || '',
    bannerImage: (account.banner_image !== undefined && account.banner_image !== null) ? account.banner_image : '',
    displayEmoji: (account.display_emoji !== undefined && account.display_emoji !== null) ? account.display_emoji : '',
    isJunior: account.is_junior === 1,
    platforms: (account.platforms !== undefined && account.platforms !== null) ? account.platforms : 0,
    personalPronouns: (account.personal_pronouns !== undefined && account.personal_pronouns !== null) ? account.personal_pronouns : 0,
    identityFlags: (account.identity_flags !== undefined && account.identity_flags !== null) ? account.identity_flags : 0,
    createdAt: account.created_at,
  };
}

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

module.exports = router;