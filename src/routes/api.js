/**
 * RecVerse Server - API Service Route (Cloudflare Workers)
 * Main game API endpoints - images, cheers, reports, friends, CAI
 */

import { Hono } from 'hono';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { authMiddleware } from '../auth/middleware.js';
import config from '../config.js';

const router = new Hono();

// GET /api/versioncheck/v4
router.get('/versioncheck/v4', async (c) => {
  return c.json({
    status: 'ok',
    gameVersion: config.game.version,
    supportedVersions: config.game.supportedVersions,
    rolloutVersions: config.game.rolloutVersions,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/images/v5/player/:id
router.get('/images/v5/player/:id', async (c) => {
  const { id } = c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const images = await dbAll(
    'SELECT * FROM saved_images WHERE account_id = ? AND image_type = 4 ORDER BY created_at DESC',
    [parseInt(id, 10)]
  );
  
  return c.json(images.map(img => ({
    SavedImageId: img.id,
    SavedImageType: img.image_type,
    SavedImageName: img.filename,
    ThumbnailImageName: img.thumbnail_filename,
    CreatedAt: img.created_at,
  })));
});

// POST /api/sanitize/v1/isPure
router.post('/sanitize/v1/isPure', async (c) => {
  const body = await c.req.json();
  const { text } = body;
  
  // Simple sanitization check
  const isPure = !/<script|<iframe|javascript:/i.test(text || '');
  
  return c.json({ isPure });
});

// POST /api/PlayerCheer/v1/create
router.post('/PlayerCheer/v1/create', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { cheeredPlayerId, category, anonymous } = body;
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  // Record cheer in audit log
  await dbRun(
    'INSERT INTO audit_logs (player_id, action, data) VALUES (?, ?, ?)',
    [accountId, 'cheer_sent', JSON.stringify({ cheeredPlayerId, category, anonymous })]
  );
  
  return c.json({ Success: true, Message: null });
});

// POST /api/PlayerCheer/v1/SetSelectedCheer
router.post('/PlayerCheer/v1/SetSelectedCheer', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { cheerId } = body;
  
  // Store selected cheer in player settings
  await dbRun(
    `INSERT INTO player_settings (account_id, settings_json, updated_at)
     VALUES (?, ?, NOW())
     ON CONFLICT (account_id) DO UPDATE SET settings_json = ?, updated_at = NOW()`,
    [accountId, JSON.stringify({ selectedCheer: cheerId }), JSON.stringify({ selectedCheer: cheerId })]
  );
  
  return c.json({ success: true });
});

// GET /api/PlayerCheer/v1/GetCheerCounts
router.get('/PlayerCheer/v1/GetCheerCounts', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  
  const settings = await dbGet(
    'SELECT settings_json FROM player_settings WHERE account_id = ?',
    [accountId]
  );
  
  const settingsJson = settings ? JSON.parse(settings.settings_json) : {};
  
  return c.json({
    IsCheerful: true,
    SelectedCheer: settingsJson.selectedCheer || null,
    CheerCredit: settingsJson.cheerCredit || 0,
    CheerGeneral: settingsJson.cheerGeneral || 0,
    CheerHelpful: settingsJson.cheerHelpful || 0,
    CheerCreative: settingsJson.cheerCreative || 0,
    CheerGreatHost: settingsJson.cheerGreatHost || 0,
    CheerSportsman: settingsJson.cheerSportsman || 0,
  });
});

// POST /api/PlayerReporting/v1/moderationBlockDetails
router.post('/PlayerReporting/v1/moderationBlockDetails', async (c) => {
  const body = await c.req.json();
  const { reportedId } = body;
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const ban = await dbGet(
    'SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > NOW())',
    [reportedId]
  );
  
  return c.json({
    isBanned: !!ban,
    banReason: ban?.reason || null,
    banDuration: ban?.duration || 0,
    banExpiresAt: ban?.expires_at || null,
  });
});

// POST /api/PlayerReporting/v3/voteToKick
router.post('/PlayerReporting/v3/voteToKick', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { reportedId, reason } = body;
  
  return c.json({ Success: true, Message: null });
});

// POST /api/chatreport/createChatReport
router.post('/api/chatreport/createChatReport', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { reportedId, category, messageId } = body;
  
  return c.json({ success: true, error: '' });
});

// POST /api/relationships/v2/sendfriendrequest
router.post('/relationships/v2/sendfriendrequest', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { targetId } = body;
  
  return c.json({ success: true, message: 'Friend request sent' });
});

// POST /api/relationships/v2/acceptfriendrequest
router.post('/relationships/v2/acceptfriendrequest', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { requesterId } = body;
  
  return c.json({ success: true, message: 'Friend request accepted' });
});

// GET /api/customAvatarItems/v1/bulk
router.get('/customAvatarItems/v1/bulk', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ items: [], owned: [] });
  }
  
  const items = await dbAll(
    'SELECT * FROM custom_avatar_items WHERE creator_account_id = ? ORDER BY created_at DESC',
    [accountId]
  );
  
  return c.json({
    items: items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      currencyType: item.currency_type,
      createdAt: item.created_at,
    })),
    owned: [],
  });
});

// GET /api/customAvatarItems/v1/search
router.get('/api/customAvatarItems/v1/search', async (c) => {
  const { query } = c.req.query();
  
  if (!isDbInitialized()) {
    return c.json({ items: [] });
  }
  
  const items = await dbAll(
    `SELECT * FROM custom_avatar_items WHERE name LIKE ? LIMIT 20`,
    [`%${query || ''}%`]
  );
  
  return c.json({
    items: items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      currencyType: item.currency_type,
    })),
  });
});

// GET /api/customAvatarItems/:id
router.get('/api/customAvatarItems/:id', async (c) => {
  const { id } = c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Item not found' }, 404);
  }
  
  const item = await dbGet('SELECT * FROM custom_avatar_items WHERE id = ?', [parseInt(id, 10)]);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  
  return c.json({
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    currencyType: item.currency_type,
    createdAt: item.created_at,
    currentSaves: item.current_saves ? JSON.parse(item.current_saves) : [],
    tags: item.tags ? JSON.parse(item.tags) : [],
  });
});

export default router;
