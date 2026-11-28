/**
 * RecVerse API Service
 * Main game API endpoints - images, cheers, reports, friends, CAI
 */

import express from 'express';
import { dbGet, dbRun, dbAll, isDbInitialized } from './verse-db.js';
import { authMiddleware, optionalAuth } from './verse-auth-middleware.js';
import config from './verse-config.js';

const router = express.Router();

// GET /api/versioncheck/v4
router.get('/versioncheck/v4', async (req, res) => {
  res.json({
    status: 'ok',
    gameVersion: config.game.version,
    supportedVersions: config.game.supportedVersions,
    rolloutVersions: config.game.rolloutVersions,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/images/v5/player/:id
router.get('/images/v5/player/:id', async (req, res) => {
  const { id } = req.params;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const db = getDb();
  const images = db.prepare(
    'SELECT * FROM saved_images WHERE account_id = ? AND image_type = 4 ORDER BY created_at DESC'
  ).all(parseInt(id, 10));
  
  res.json(images.map(img => ({
    SavedImageId: img.id,
    SavedImageType: img.image_type,
    SavedImageName: img.filename,
    ThumbnailImageName: img.thumbnail_filename,
    CreatedAt: img.created_at,
  })));
});

// POST /api/sanitize/v1/isPure
router.post('/sanitize/v1/isPure', async (req, res) => {
  const { text } = req.body;
  
  // Simple sanitization check
  const isPure = !/<script|<iframe|javascript:/i.test(text || '');
  
  res.json({ isPure });
});

// POST /api/PlayerCheer/v1/create
router.post('/PlayerCheer/v1/create', async (req, res) => {
  // Require authentication
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).send();
  }
  
  // Simplified implementation
  res.json({ Success: true, Message: null });
});

// POST /api/PlayerCheer/v1/SetSelectedCheer
router.post('/PlayerCheer/v1/SetSelectedCheer', async (req, res) => {
  res.json({ Success: true, Message: null });
});

// GET /api/PlayerCheer/v1/GetCheerCounts
router.get('/PlayerCheer/v1/GetCheerCounts', async (req, res) => {
  res.json({
    IsCheerful: true,
    SelectedCheer: null,
    CheerCredit: 0,
    CheerGeneral: 0,
    CheerHelpful: 0,
    CheerCreative: 0,
    CheerGreatHost: 0,
    CheerSportsman: 0,
  });
});

// POST /api/PlayerReporting/v1/moderationBlockDetails
router.post('/PlayerReporting/v1/moderationBlockDetails', async (req, res) => {
  const { reportedId } = req.body;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const db = getDb();
  const ban = db.prepare(
    'SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)'
  ).get(reportedId, new Date().toISOString());
  
  res.json({
    isBanned: !!ban,
    banReason: ban?.reason || null,
    banDuration: ban?.duration || 0,
    banExpiresAt: ban?.expires_at || null,
  });
});

// POST /api/PlayerReporting/v3/voteToKick
router.post('/PlayerReporting/v3/voteToKick', async (req, res) => {
  res.json({ Success: true, Message: null });
});

// POST /api/chatreport/createChatReport
router.post('/chatreport/createChatReport', async (req, res) => {
  res.json({ success: true, error: '' });
});

// POST /api/relationships/v2/sendfriendrequest
router.post('/relationships/v2/sendfriendrequest', async (req, res) => {
  res.json({ success: true, message: 'Friend request sent' });
});

// POST /api/relationships/v2/acceptfriendrequest
router.post('/relationships/v2/acceptfriendrequest', async (req, res) => {
  res.json({ success: true, message: 'Friend request accepted' });
}

// GET /api/customAvatarItems/v1/bulk
router.get('/customAvatarItems/v1/bulk', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).send();
  }
  
  // Simplified - return empty for now
  res.json({ items: [], created: [] });
});

// GET /api/customAvatarItems/v1/search
router.get('/customAvatarItems/v1/search', async (req, res) => {
  const { query } = req.query;
  
  if (!isDbInitialized()) {
    return res.json({ items: [] });
  }
  
  const db = getDb();
  const items = db.prepare(
    'SELECT * FROM custom_avatar_items WHERE name LIKE ? LIMIT 20'
  ).all(`%${query || ''}%`);
  
  res.json({
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
router.get('/customAvatarItems/:id', async (req, res) => {
  const { id } = req.params;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not available' });
  }
  
  const db = getDb();
  const item = db.prepare('SELECT * FROM custom_avatar_items WHERE id = ?').get(parseInt(id, 10));
  
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }
  
  res.json({
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