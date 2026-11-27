/**
 * RecVerse Accounts Service
 * Account management, profiles, lookups - compatible with February 2023 client
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

const {
  validateAndGetAccountId,
  requireAuth,
  optionalAuth,
  getAccountById,
  getAccountByUsername,
  getAccountsByIds,
  defaultAccount,
  updateAccount,
  createAccount,
  isUsernameTaken,
  isEmailTaken,
  toAccountDto,
  toSelfAccountDto,
} = require('./verse-auth-middleware');

const { generateCode, hashCode, now, sanitizeString } = require('./verse-utils');
const { getDb } = require('./verse-db');
const config = require('./verse-config');
const logger = require('./verse-logger');

const router = express.Router();

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: errors.array()[0].msg });
  }
  next();
};

/**
 * GET /health - Health check
 */
router.get('/health', (req, res) => {
  res.json({ service: 'accounts', status: 'ok' });
});

/**
 * GET /emojiConfig/whitelistedEmojis - Get whitelisted emojis
 * Returns bare array as expected by client
 */
router.get('/emojiConfig/whitelistedEmojis', (req, res) => {
  const emojis = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
    '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
    '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩',
    '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣',
    '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
    '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗',
    '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯',
    '😦', '😧', '😮', '😲', '😴', '🤤', '😪', '😵', '🤐', '🥴',
    '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿',
    '👹', '👺', '💀', '☠️', '👻', '👽', '👾', '🤖', '💩', '😺',
    '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🙌', '👏',
    '👋', '🤝', '👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️',
    '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👌',
    '🤌', '🤏', '✍️', '🙏', '💅', '💪', '🦾', '🦿', '🦵', '🦶',
    '👂', '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄',
    '💋', '🩸', '🫀', '🫁', '🧬', '🦠', '💊', '💉', '🩹', '🩺',
  ];
  res.json(emojis);
});

/**
 * GET /account/me - Get caller's own account (private)
 */
router.get('/account/me', requireAuth, async (req, res) => {
  try {
    const account = await getAccountById(req.accountId) || defaultAccount(req.accountId);
    res.json(toSelfAccountDto(account));
  } catch (error) {
    logger.error('ACCOUNTS', 'Failed to get self account', { error: error.message, accountId: req.accountId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /account/search - Prefix search accounts by username
 */
router.get('/account/search', optionalAuth, [
  query('name').optional().isString(),
  query('take').optional().isInt({ min: 1, max: 50 }),
  validate,
], async (req, res) => {
  try {
    const name = (req.query.name || '').toLowerCase().trim();
    const take = Math.min(parseInt(req.query.take) || 20, 50);
    
    if (!name) {
      return res.json([]);
    }

    const db = getDb();
    const accounts = db.prepare(`
      SELECT * FROM accounts 
      WHERE username_lower LIKE ? AND is_deleted = 0
      ORDER BY username_lower
      LIMIT ?
    `).all(`${name}%`, take);

    res.json(accounts.map(toAccountDto));
  } catch (error) {
    logger.error('ACCOUNTS', 'Search failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /account/username/:name - Exact username lookup
 */
router.get('/account/username/:name', optionalAuth, [
  param('name').isString().notEmpty(),
  validate,
], async (req, res) => {
  try {
    const name = req.params.name.replace(/^@/, '').trim();
    if (!name) {
      return res.status(404).json({ error: `There's no player called @${name}.` });
    }

    const account = await getAccountByUsername(name);
    if (!account) {
      return res.status(404).json({ error: `There's no player called @${name}.` });
    }

    res.json(toAccountDto(account));
  } catch (error) {
    logger.error('ACCOUNTS', 'Username lookup failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /account - Exact username lookup (query form)
 */
router.get('/account', optionalAuth, [
  query('username').isString().notEmpty(),
  validate,
], async (req, res) => {
  try {
    const name = req.query.username.replace(/^@/, '').trim();
    if (!name) {
      return res.status(404).json({ error: `There's no player called @${name}.` });
    }

    const account = await getAccountByUsername(name);
    if (!account) {
      return res.status(404).json({ error: `There's no player called @${name}.` });
    }

    res.json(toAccountDto(account));
  } catch (error) {
    logger.error('ACCOUNTS', 'Username lookup (query) failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /account/bulk - Bulk account lookup (GET)
 */
router.get('/account/bulk', optionalAuth, [
  query('id').optional().isArray(),
  validate,
], async (req, res) => {
  try {
    const ids = (req.query.id || [])
      .flatMap(v => v.split(','))
      .map(v => parseInt(v.trim(), 10))
      .filter(n => !isNaN(n));
    
    const uniqueIds = [...new Set(ids)];
    const accounts = await getAccountsByIds(uniqueIds);
    const accountMap = new Map(accounts.map(a => [a.account_id, a]));
    
    const results = uniqueIds.map(id => toAccountDto(accountMap.get(id) || defaultAccount(id)));
    res.json(results);
  } catch (error) {
    logger.error('ACCOUNTS', 'Bulk lookup (GET) failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /account/bulk - Bulk account lookup (POST form)
 */
router.post('/account/bulk', optionalAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const ids = (body.id || [])
      .flatMap(v => (Array.isArray(v) ? v : [v]))
      .flatMap(v => v.split(','))
      .map(v => parseInt(v.trim(), 10))
      .filter(n => !isNaN(n));
    
    const uniqueIds = [...new Set(ids)];
    const accounts = await getAccountsByIds(uniqueIds);
    const accountMap = new Map(accounts.map(a => [a.account_id, a]));
    
    const results = uniqueIds.map(id => toAccountDto(accountMap.get(id) || defaultAccount(id)));
    res.json(results);
  } catch (error) {
    logger.error('ACCOUNTS', 'Bulk lookup (POST) failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /account/:id/bio - Get player bio
 */
router.get('/account/:id/bio', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const account = await getAccountById(accountId);
    res.json({ accountId, bio: account?.bio || '' });
  } catch (error) {
    logger.error('ACCOUNTS', 'Bio lookup failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /account/:id - Get public account by ID
 */
router.get('/account/:id', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const account = await getAccountById(accountId) || defaultAccount(accountId);
    res.json(toAccountDto(account));
  } catch (error) {
    logger.error('ACCOUNTS', 'Account lookup by ID failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /account/create - Create new account
 */
router.post('/account/create', async (req, res) => {
  try {
    const platform = parseInt(req.body.platform) || 0;
    
    const account = await createAccount({ platforms: platform });
    logger.accounts('Account created', { accountId: account.account_id, platform });
    
    res.json({ success: true, value: toAccountDto(account) });
  } catch (error) {
    logger.error('ACCOUNTS', 'Account creation failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /parentalcontrol/me - Get parental control settings
 */
router.get('/parentalcontrol/me', requireAuth, async (req, res) => {
  const account = await getAccountById(req.accountId) || defaultAccount(req.accountId);
  res.json({ accountId: req.accountId, disallowInAppPurchases: true });
});

/**
 * GET /accountprivacysettings/:id - Get privacy settings
 */
router.get('/accountprivacysettings/:id', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  res.json({ accountId, isRecentHistoryVisible: true });
});

/**
 * PUT /account/me/displayname - Set display name
 */
router.put('/account/me/displayname', requireAuth, [
  body('displayName').isString().isLength({ min: 1, max: 15 }).withMessage('Display name must be 1-15 characters'),
  validate,
], async (req, res) => {
  try {
    const { displayName } = req.body;
    const account = await updateAccount(req.accountId, { display_name: displayName });
    
    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to update display name' });
    }
    
    logger.accounts('Display name updated', { accountId: req.accountId, displayName });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Display name update failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/username - Change username
 */
router.put('/account/me/username', requireAuth, [
  body('username').isString().isLength({ min: 1, max: 50 }).matches(/^[a-zA-Z0-9]+$/).withMessage('Username must be alphanumeric, 1-50 characters'),
  validate,
], async (req, res) => {
  try {
    const { username } = req.body;
    const account = await getAccountById(req.accountId) || defaultAccount(req.accountId);
    
    // Check if username is taken by another account
    const existing = await getAccountByUsername(username);
    if (existing && existing.account_id !== req.accountId) {
      return res.json({ success: false, error: 'That username is already taken.', value: '' });
    }
    
    // Check remaining changes
    const remaining = account.available_username_changes ?? 3;
    if (remaining <= 0) {
      return res.json({ success: false, error: 'You have no username changes remaining.', value: '' });
    }
    
    // Update
    const updated = await updateAccount(req.accountId, {
      username,
      username_lower: username.toLowerCase(),
      available_username_changes: remaining - 1,
    });
    
    if (!updated) {
      return res.json({ success: false, error: 'That username is already taken.', value: '' });
    }
    
    logger.accounts('Username changed', { accountId: req.accountId, username });
    res.json({ success: true, error: '', value: toAccountDto(updated) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.json({ success: false, error: 'That username is already taken.', value: '' });
    }
    logger.error('ACCOUNTS', 'Username change failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error', value: '' });
  }
});

/**
 * POST /account/me/email - Change email (staged)
 */
router.post('/account/me/email', requireAuth, [
  body('email').isEmail().withMessage('Invalid email address'),
  validate,
], async (req, res) => {
  try {
    const { email } = req.body;
    const account = await getAccountById(req.accountId) || defaultAccount(req.accountId);
    const current = account.email?.toLowerCase().trim() || null;
    const newEmail = email.toLowerCase().trim();
    
    // Check if email is on another account
    const holder = await getAccountByEmail(newEmail);
    if (holder && holder.account_id !== req.accountId) {
      return res.status(400).json({ success: false, error: 'That email address is already on another account.' });
    }
    
    // Same email - apply immediately
    if (current === newEmail) {
      await updateAccount(req.accountId, { email: newEmail });
      return res.json({ success: true });
    }
    
    // TODO: Implement email code staging
    // For now, just apply directly (dev mode)
    await updateAccount(req.accountId, { email: newEmail });
    
    logger.accounts('Email changed', { accountId: req.accountId, email: newEmail });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Email change failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /account/me/email/pending - Get pending email change
 */
router.get('/account/me/email/pending', requireAuth, async (req, res) => {
  res.json({ pending: null, sentTo: null });
});

/**
 * POST /account/me/email/confirm - Confirm email change
 */
router.post('/account/me/email/confirm', requireAuth, [
  body('code').isString().isLength({ min: 6, max: 6 }).isNumeric().withMessage('Invalid code'),
  validate,
], async (req, res) => {
  // TODO: Implement email confirmation
  res.json({ success: true, applied: true, pending: null, sentTo: null });
});

/**
 * POST /account/me/phone - Set phone number
 */
router.post('/account/me/phone', requireAuth, [
  body('phone').isString().notEmpty().withMessage('Phone number required'),
  validate,
], async (req, res) => {
  try {
    const { phone } = req.body;
    await updateAccount(req.accountId, { phone: sanitizeString(phone) });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Phone update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/identityflags - Set identity flags
 */
router.put('/account/me/identityflags', requireAuth, [
  body('identityFlags').isInt().withMessage('Identity flags must be numeric'),
  validate,
], async (req, res) => {
  try {
    const identityFlags = parseInt(req.body.identityFlags, 10);
    const account = await updateAccount(req.accountId, { identity_flags: identityFlags });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Identity flags update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/personalpronouns - Set personal pronouns
 */
router.put('/account/me/personalpronouns', requireAuth, [
  body('pronounFlags').isInt().withMessage('Pronoun flags must be numeric'),
  validate,
], async (req, res) => {
  try {
    const personalPronouns = parseInt(req.body.pronounFlags, 10);
    const account = await updateAccount(req.accountId, { personal_pronouns: personalPronouns });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Pronouns update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/bio - Set bio
 */
router.put('/account/me/bio', requireAuth, [
  body('bio').isString().isLength({ max: 255 }).withMessage('Bio must be 255 characters or less'),
  validate,
], async (req, res) => {
  try {
    const { bio } = req.body;
    const account = await updateAccount(req.accountId, { bio: sanitizeString(bio, 255) });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Bio update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/emoji - Set display emoji
 */
router.put('/account/me/emoji', requireAuth, [
  body('displayEmoji').isString(),
  validate,
], async (req, res) => {
  try {
    const submitted = req.body.displayEmoji.trim();
    const displayEmoji = submitted === '' ? '' : submitted;
    
    // Check if emoji is whitelisted (simplified - accept any for now)
    if (displayEmoji !== '' && !config.features.enableImageSigning) {
      // In production, validate against whitelist
    }
    
    const account = await updateAccount(req.accountId, { display_emoji: displayEmoji });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Emoji update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/bannerimage - Set banner image
 */
router.put('/account/me/bannerimage', requireAuth, [
  body('imageName').isString().notEmpty().withMessage('Image name required'),
  validate,
], async (req, res) => {
  try {
    const { imageName } = req.body;
    const account = await updateAccount(req.accountId, { banner_image: imageName });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Banner image update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /account/me/profileimage - Set profile image
 */
router.put('/account/me/profileimage', requireAuth, [
  body('imageName').isString().notEmpty().withMessage('Image name required'),
  validate,
], async (req, res) => {
  try {
    const { imageName } = req.body;
    const account = await updateAccount(req.accountId, { profile_image: imageName });
    res.json({ success: true });
  } catch (error) {
    logger.error('ACCOUNTS', 'Profile image update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;