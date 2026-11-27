/**
 * RecVerse API Service
 * Main game API endpoints - compatible with February 2023 client
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const crypto = require('crypto');

const { requireAuth, optionalAuth, validateAndGetAccountId, getAccountById, getAccountsByIds, defaultAccount, toAccountDto, updateAccount } = require('./verse-auth-middleware');
const { getDb } = require('./verse-db');
const { now, sanitizeString, buildEndpoints } = require('./verse-utils');
const config = require('./verse-config');
const logger = require('./verse-logger');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

/**
 * GET /health
 */
router.get('/health', (req, res) => {
  res.json({ service: 'api', status: 'ok' });
});

/**
 * GET /api/versioncheck/v4 - Version check
 * Tells client if it needs to update
 */
router.get('/api/versioncheck/v4', optionalAuth, (req, res) => {
  const clientVer = req.query.ver || req.headers['x-game-version'];
  const supported = config.game.supportedVersions;
  const rollout = config.game.rolloutVersions;
  
  let needsUpdate = false;
  let isRollout = false;
  
  if (clientVer) {
    const cleanVer = clientVer.split('.')[0];
    needsUpdate = !supported.includes(cleanVer);
    isRollout = rollout.includes(cleanVer);
  }
  
  res.json({
    Supported: !needsUpdate,
    Rollout: isRollout,
    CurrentVersion: config.game.version,
    MinimumVersion: supported[0],
    Message: needsUpdate ? 'A new version of Rec Room is available. Please update to continue.' : '',
    DownloadUrl: '',
  });
});

/**
 * GET /api/images/v5/player/:id - Player images (v5)
 */
router.get('/api/images/v5/player/:id', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const db = getDb();
    
    const images = db.prepare(`
      SELECT * FROM saved_images 
      WHERE account_id = ? AND image_type IN (0, 1, 2)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(accountId);
    
    // Transform to client format: Id -> SavedImageId, Type -> SavedImageType
    const results = images.map(img => ({
      SavedImageId: img.id,
      SavedImageType: img.image_type,
      ThumbnailImageFilename: img.thumbnail_filename || img.filename,
      TaggedPlayerIds: [], // Not included for player images
      CreatedAt: img.created_at,
    }));
    
    res.json(results);
  } catch (error) {
    logger.error('API', 'Player images v5 failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/images/v4/player/:id - Player images (v4)
 */
router.get('/api/images/v4/player/:id', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const db = getDb();
    
    const images = db.prepare(`
      SELECT * FROM saved_images 
      WHERE account_id = ? AND image_type IN (0, 1, 2)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(accountId);
    
    const results = images.map(img => ({
      SavedImageId: img.id,
      SavedImageType: img.image_type,
      ThumbnailImageFilename: img.thumbnail_filename || img.filename,
      TaggedPlayerIds: [],
      CreatedAt: img.created_at,
    }));
    
    res.json(results);
  } catch (error) {
    logger.error('API', 'Player images v4 failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/images/v3/feed/player/:id - Player image feed (v3)
 */
router.get('/api/images/v3/feed/player/:id', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const db = getDb();
    
    const images = db.prepare(`
      SELECT * FROM saved_images 
      WHERE account_id = ? AND image_type IN (0, 1, 2)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(accountId);
    
    const results = images.map(img => ({
      SavedImageId: img.id,
      SavedImageType: img.image_type,
      ThumbnailImageFilename: img.thumbnail_filename || img.filename,
      TaggedPlayerIds: [],
      CreatedAt: img.created_at,
    }));
    
    res.json(results);
  } catch (error) {
    logger.error('API', 'Player images v3 failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/images/v4/room/:roomId - Room photos (raw SavedImage)
 */
router.get('/api/images/v4/room/:roomId', optionalAuth, [
  param('roomId').isInt(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId, 10);
    const db = getDb();
    
    const images = db.prepare(`
      SELECT * FROM saved_images 
      WHERE image_type = 3 AND tagged_player_ids LIKE ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(`%${roomId}%`);
    
    // Room feed returns raw SavedImage (not projected)
    res.json(images.map(img => ({
      Id: img.id,
      AccountId: img.account_id,
      ImageType: img.image_type,
      Filename: img.filename,
      ThumbnailImageFilename: img.thumbnail_filename,
      TaggedPlayerIds: JSON.parse(img.tagged_player_ids || '[]'),
      CreatedAt: img.created_at,
    })));
  } catch (error) {
    logger.error('API', 'Room images failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/sanitize/v1/isPure - Profanity check
 */
router.post('/api/sanitize/v1/isPure', optionalAuth, [
  body('text').isString(),
  validate,
], async (req, res) => {
  const { text } = req.body;
  // Simple profanity check - in production use a proper filter
  const profanity = ['badword1', 'badword2']; // Add real list
  const isPure = !profanity.some(w => text.toLowerCase().includes(w));
  res.json({ IsPure: isPure });
});

/**
 * POST /api/PlayerCheer/v1/create - Create cheer
 */
router.post('/api/PlayerCheer/v1/create', requireAuth, [
  body('Category').isString().notEmpty(),
  body('RoomId').optional().isInt(),
  body('Anonymous').optional().isBoolean(),
  validate,
], async (req, res) => {
  try {
    const { Category, RoomId, Anonymous } = req.body;
    const db = getDb();
    
    // Update reputation
    const account = await getAccountById(req.accountId);
    const cheerful = 1; // Always true for now
    
    // Send ReputationUpdate to room instance via notifications
    // For now just return success
    logger.api('Cheer created', { accountId: req.accountId, category: Category, anonymous: Anonymous });
    
    res.json({ Success: true, Message: null });
  } catch (error) {
    logger.error('API', 'Cheer creation failed', { error: error.message });
    res.status(500).json({ Success: false, Message: 'Internal server error' });
  }
});

/**
 * POST /api/PlayerCheer/v1/SetSelectedCheer - Set selected cheer
 */
router.post('/api/PlayerCheer/v1/SetSelectedCheer', requireAuth, [
  body('CheerCategory').isString().notEmpty(),
  validate,
], async (req, res) => {
  try {
    const { CheerCategory } = req.body;
    await updateAccount(req.accountId, { /* store selected cheer */ });
    res.json({ Success: true, Message: null });
  } catch (error) {
    logger.error('API', 'Set selected cheer failed', { error: error.message });
    res.status(500).json({ Success: false, Message: 'Internal server error' });
  }
});

/**
 * GET /api/PlayerCheer/v1/GetCheerCounts - Get cheer counts
 */
router.get('/api/PlayerCheer/v1/GetCheerCounts', requireAuth, async (req, res) => {
  // Return default counts
  res.json({
    Cheerful: 0,
    GreatHost: 0,
    Creative: 0,
    Helpful: 0,
    Sportmanship: 0,
    Welcome: 0,
  });
});

/**
 * POST /api/PlayerReporting/v1/moderationBlockDetails - Get ban details
 */
router.post('/api/PlayerReporting/v1/moderationBlockDetails', requireAuth, [
  body('AccountId').isInt(),
  validate,
], async (req, res) => {
  try {
    const { AccountId } = req.body;
    const db = getDb();
    
    const ban = db.prepare(`
      SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(AccountId, now());
    
    if (!ban) {
      return res.json({ Blocked: false, Duration: 0, Reason: '' });
    }
    
    const duration = ban.expires_at 
      ? Math.max(0, Math.floor((new Date(ban.expires_at) - new Date()) / 1000))
      : 0;
    
    res.json({
      Blocked: true,
      Duration: duration,
      Reason: ban.reason,
    });
  } catch (error) {
    logger.error('API', 'Moderation block details failed', { error: error.message });
    res.status(500).json({ Blocked: false, Duration: 0, Reason: '' });
  }
});

/**
 * POST /api/PlayerReporting/v3/voteToKick - Vote to kick
 */
router.post('/api/PlayerReporting/v3/voteToKick', requireAuth, [
  body('AccountId').isInt(),
  body('Reason').isString(),
  body('RoomId').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const { AccountId, Reason, RoomId } = req.body;
    
    // Send vote-to-kick notification to room
    // FromPlayerId should be the player being voted ON (AccountId)
    // Data should be the reason as plain text
    
    logger.api('Vote to kick', { voter: req.accountId, target: AccountId, reason: Reason });
    
    res.json({ success: true, error: '' });
  } catch (error) {
    logger.error('API', 'Vote to kick failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/chatreport/createChatReport - Create chat report
 */
router.post('/api/chatreport/createChatReport', requireAuth, async (req, res) => {
  try {
    const { MessageId, ReportCategory, ReportText } = req.body;
    
    // Map category name to number
    const categoryMap = {
      'Discriminatory': 1,
      'Harassment': 2,
      'Spam': 3,
      'Inappropriate': 4,
      'Other': 5,
    };
    
    const category = categoryMap[ReportCategory] || 0;
    
    const db = getDb();
    db.prepare(`
      INSERT INTO reports (reporter_id, reported_id, category, details, room_id, subroom_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(req.accountId, 0, category, JSON.stringify({ messageId: MessageId, text: ReportText }), 0, 0);
    
    logger.api('Chat report created', { reporter: req.accountId, category: ReportCategory });
    
    res.json({ success: true, error: '' });
  } catch (error) {
    logger.error('API', 'Chat report failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/relationships/v2/sendfriendrequest - Send friend request
 */
router.post('/api/relationships/v2/sendfriendrequest', requireAuth, [
  body('AccountId').isInt(),
  validate,
], async (req, res) => {
  try {
    const { AccountId } = req.body;
    
    if (AccountId === req.accountId) {
      return res.json({ Success: false, Error: 'Cannot friend yourself' });
    }
    
    const db = getDb();
    // Check if already friends or request exists
    const existing = db.prepare(`
      SELECT 1 FROM relationships 
      WHERE (account_id = ? AND friend_id = ?) OR (account_id = ? AND friend_id = ?)
    `).get(req.accountId, AccountId, AccountId, req.accountId);
    
    if (existing) {
      return res.json({ Success: false, Error: 'Already friends or request pending' });
    }
    
    // Create friend request (stored as relationship with status pending)
    db.prepare(`
      INSERT INTO relationships (account_id, friend_id, status, created_at)
      VALUES (?, ?, 0, ?)
    `).run(req.accountId, AccountId, now());
    
    // Send FriendInvite message to target
    // Message type 4
    
    logger.api('Friend request sent', { from: req.accountId, to: AccountId });
    
    res.json({ Success: true, Error: null });
  } catch (error) {
    logger.error('API', 'Friend request failed', { error: error.message });
    res.status(500).json({ Success: false, Error: 'Internal server error' });
  }
});

/**
 * POST /api/relationships/v2/acceptfriendrequest - Accept friend request
 */
router.post('/api/relationships/v2/acceptfriendrequest', requireAuth, [
  body('AccountId').isInt(),
  validate,
], async (req, res) => {
  try {
    const { AccountId } = req.body;
    const db = getDb();
    
    // Update relationship to accepted
    db.prepare(`
      UPDATE relationships SET status = 1, updated_at = ? 
      WHERE account_id = ? AND friend_id = ?
    `).run(now(), AccountId, req.accountId);
    
    // Also create reverse relationship
    db.prepare(`
      INSERT OR IGNORE INTO relationships (account_id, friend_id, status, created_at)
      VALUES (?, ?, 1, ?)
    `).run(req.accountId, AccountId, now());
    
    // Send FriendRequestAccepted message (type 40) to requester
    
    logger.api('Friend request accepted', { by: req.accountId, from: AccountId });
    
    res.json({ Success: true, Error: null });
  } catch (error) {
    logger.error('API', 'Accept friend request failed', { error: error.message });
    res.status(500).json({ Success: false, Error: 'Internal server error' });
  }
});

/**
 * GET /api/customAvatarItems/v1/bulk - Bulk custom avatar items
 */
router.get('/api/customAvatarItems/v1/bulk', optionalAuth, [
  query('ids').isString(),
  query('unityAssetTarget').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const ids = req.query.ids.split(',').map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n));
    const unityAssetTarget = parseInt(req.query.unityAssetTarget) || 0;
    
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    const items = db.prepare(`
      SELECT * FROM custom_avatar_items WHERE id IN (${placeholders})
    `).all(...ids);
    
    const results = items.map(item => {
      const saves = JSON.parse(item.current_saves || '[]');
      const questSaves = saves.map(save => ({
        ...save,
        UnityAsset: unityAssetTarget === 2 ? save.UnityAsset2 : save.UnityAsset,
        UnityAssetHash: unityAssetTarget === 2 ? save.UnityAsset2Hash : save.UnityAssetHash,
        UnityAsset2: undefined,
        UnityAsset2Hash: undefined,
      }));
      
      return {
        Id: item.id,
        CreatorAccountId: item.creator_account_id,
        Name: item.name,
        Description: item.description,
        BaseAvatarItemId: item.base_avatar_item_id,
        BaseAvatarItemColor: item.base_avatar_item_color,
        DesignFilename: item.design_filename,
        ThumbnailImageFilename: item.thumbnail_image_filename,
        Price: item.price,
        CurrencyType: item.currency_type,
        PurchaseCurrencyType: item.purchase_currency_type,
        OutfitType: item.outfit_type,
        CurrentSaves: questSaves,
        Tags: JSON.parse(item.tags || '[]'),
        CustomBadgeMetadata: item.custom_badge_metadata,
        CreatedAt: item.created_at,
        UpdatedAt: item.updated_at,
      };
    });
    
    res.json(results);
  } catch (error) {
    logger.error('API', 'Custom avatar items bulk failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/customAvatarItems/v1/search - Search custom avatar items
 */
router.get('/api/customAvatarItems/v1/search', optionalAuth, [
  query('query').optional().isString(),
  query('take').optional().isInt({ min: 1, max: 50 }),
  query('unityAssetTarget').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const query = req.query.query || '';
    const take = Math.min(parseInt(req.query.take) || 20, 50);
    const unityAssetTarget = parseInt(req.query.unityAssetTarget) || 0;
    
    const db = getDb();
    let items;
    
    if (query) {
      items = db.prepare(`
        SELECT * FROM custom_avatar_items 
        WHERE name LIKE ? OR description LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, take);
    } else {
      items = db.prepare(`
        SELECT * FROM custom_avatar_items 
        ORDER BY created_at DESC
        LIMIT ?
      `).all(take);
    }
    
    const results = items.map(item => {
      const saves = JSON.parse(item.current_saves || '[]');
      const questSaves = saves.map(save => ({
        ...save,
        UnityAsset: unityAssetTarget === 2 ? save.UnityAsset2 : save.UnityAsset,
        UnityAssetHash: unityAssetTarget === 2 ? save.UnityAsset2Hash : save.UnityAssetHash,
      }));
      
      return {
        Id: item.id,
        CreatorAccountId: item.creator_account_id,
        Name: item.name,
        Description: item.description,
        BaseAvatarItemId: item.base_avatar_item_id,
        BaseAvatarItemColor: item.base_avatar_item_color,
        DesignFilename: item.design_filename,
        ThumbnailImageFilename: item.thumbnail_image_filename,
        Price: item.price,
        CurrencyType: item.currency_type,
        PurchaseCurrencyType: item.purchase_currency_type,
        OutfitType: item.outfit_type,
        CurrentSaves: questSaves,
        Tags: JSON.parse(item.tags || '[]'),
        CustomBadgeMetadata: item.custom_badge_metadata,
        CreatedAt: item.created_at,
        UpdatedAt: item.updated_at,
      };
    });
    
    res.json(results);
  } catch (error) {
    logger.error('API', 'Custom avatar items search failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/customAvatarItems/:id - Single custom avatar item
 */
router.get('/api/customAvatarItems/:id', optionalAuth, [
  param('id').isInt(),
  query('unityAssetTarget').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const unityAssetTarget = parseInt(req.query.unityAssetTarget) || 0;
    
    const db = getDb();
    const item = db.prepare('SELECT * FROM custom_avatar_items WHERE id = ?').get(id);
    
    if (!item) {
      return res.status(404).json({ error: 'Not found' });
    }
    
    const saves = JSON.parse(item.current_saves || '[]');
    const questSaves = saves.map(save => ({
      ...save,
      UnityAsset: unityAssetTarget === 2 ? save.UnityAsset2 : save.UnityAsset,
      UnityAssetHash: unityAssetTarget === 2 ? save.UnityAsset2Hash : save.UnityAssetHash,
    }));
    
    res.json({
      Id: item.id,
      CreatorAccountId: item.creator_account_id,
      Name: item.name,
      Description: item.description,
      BaseAvatarItemId: item.base_avatar_item_id,
      BaseAvatarItemColor: item.base_avatar_item_color,
      DesignFilename: item.design_filename,
      ThumbnailImageFilename: item.thumbnail_image_filename,
      Price: item.price,
      CurrencyType: item.currency_type,
      PurchaseCurrencyType: item.purchase_currency_type,
      OutfitType: item.outfit_type,
      CurrentSaves: questSaves,
      Tags: JSON.parse(item.tags || '[]'),
      CustomBadgeMetadata: item.custom_badge_metadata,
      CreatedAt: item.created_at,
      UpdatedAt: item.updated_at,
    });
  } catch (error) {
    logger.error('API', 'Custom avatar item failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;