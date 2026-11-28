/**
 * RecVerse Rooms Service
 * Room & subroom management - compatible with February 2023 client
 */

import express from 'express';
import { dbGet, dbRun, dbAll, isDbInitialized } from './verse-db.js';
import { authMiddleware } from './verse-auth-middleware.js';
import config from './verse-config.js';

const router = express.Router();

// GET /rooms/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const roomId = parseInt(id, 10);
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    roomId: room.room_id,
    name: room.name,
    description: room.description,
    accessLevel: room.access_level,
    creatorId: room.creator_id,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
    imageName: room.image_name || '',
    tags: room.tags ? JSON.parse(room.tags) : [],
    maxPlayers: room.max_players,
    isDorm: room.is_dorm === 1,
    loadScreens: room.load_screens ? JSON.parse(room.load_screens) : [],
  });
});

// POST /rooms
router.post('/', async (req, res) => {
  const accountId = req.accountId;
  const body = req.body;
  const { name, description, accessLevel, maxPlayers } = body;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const result = await dbRun(
    `INSERT INTO rooms (name, description, access_level, creator_id, is_dorm, max_players, tags, load_screens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name || 'New Room', description || '', accessLevel || 1, accountId, 0, maxPlayers || 16, '[]', '[]']
  );
  
  const roomId = result.lastID;
  
  await dbRun(
    `INSERT INTO subrooms (room_id, name, unity_scene_id, max_players, created_at, updated_at)
     VALUES (?, 'Orientation', 'Orientation', ?, NOW(), NOW())`,
    [roomId, maxPlayers || 16]
  );
  
  res.json({ success: true, roomId });
});

// PUT /rooms/:id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const roomId = parseInt(id, 10);
  const body = req.body;
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  // Check ownership
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.creator_id !== accountId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  await dbRun(
    `UPDATE rooms SET name = ?, description = ?, access_level = ?, max_players = ?, updated_at = NOW() WHERE room_id = ?`,
    [body.name, body.description, body.accessLevel, body.maxPlayers, roomId]
  );
  
  res.json({ success: true });
});

// DELETE /rooms/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const roomId = parseInt(id, 10);
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.creator_id !== accountId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  await dbRun('DELETE FROM rooms WHERE room_id = ?', [roomId]);
  
  res.json({ success: true });
});

// GET /rooms/:id/subrooms/:sid/data
router.get('/:roomId/subrooms/:subRoomId/data', async (req, res) => {
  const { roomId, subRoomId } = req.params;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const subroom = await dbGet(
    'SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?',
    [parseInt(subRoomId, 10), parseInt(roomId, 10)]
  );
  
  if (!subroom) {
    return res.status(404).json({ error: 'Subroom not found' });
  }
  
  res.json({
    subroomId: subroom.subroom_id,
    name: subroom.name,
    unitySceneId: subroom.unity_scene_id,
    maxPlayers: subroom.max_players,
    currentSaveId: subroom.current_save_id,
    stagedSaveId: subroom.staged_save_id,
  });
});

// POST /rooms/:id/subrooms/:sid/data
router.post('/:roomId/subrooms/:subRoomId/data', async (req, res) => {
  const { roomId, subRoomId } = req.params;
  const body = req.body;
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const { description, autoPublish } = body;
  
  await dbRun(
    `INSERT INTO subroom_saves (subroom_id, account_id, description, data_blob, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [parseInt(subRoomId, 10), accountId, description || '', body.data_blob || '']
  );
  
  res.json({ success: true });
});

// POST /rooms/:id/subrooms/:sid/publish_save
router.post('/:roomId/subrooms/:subRoomId/publish_save', async (req, res) => {
  const { roomId, subRoomId } = req.params;
  const body = req.body;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const { subRoomDataSaveId } = body;
  
  if (subRoomDataSaveId) {
    await dbRun(
      `UPDATE subrooms SET current_save_id = ?, updated_at = NOW() WHERE subroom_id = ?`,
      [parseInt(subRoomDataSaveId, 10), parseInt(subRoomId, 10)]
    );
  }
  
  res.json({ success: true });
});

// GET /rooms/:id/saves
router.get('/:id/saves', async (req, res) => {
  const { id } = req.params;
  const roomId = parseInt(id, 10);
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const saves = await dbAll(
    `SELECT s.* FROM subroom_saves s
     JOIN subrooms sr ON s.subroom_id = sr.subroom_id
     WHERE sr.room_id = ? AND s.account_id = ?
     ORDER BY s.created_at DESC`,
    [roomId, accountId]
  );
  
  res.json(saves.map(s => ({
    saveId: s.save_id,
    subroomId: s.subroom_id,
    description: s.description,
    createdAt: s.created_at,
    unityAsset: s.unity_asset,
    unityAssetHash: s.unity_asset_hash,
  }));
});

// PUT /rooms/:id/loadscreen
router.put('/:id/loadscreen', async (req, res) => {
  const { id } = req.params;
  const roomId = parseInt(id, 10);
  const body = req.body;
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.creator_id !== accountId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  await dbRun(
    'UPDATE rooms SET load_screens = ?, updated_at = NOW() WHERE room_id = ?',
    [JSON.stringify(body.loadScreens || []), roomId]
  );
  
  res.json({ success: true });
});

// PUT /rooms/:id/description
router.put('/:id/description', async (req, res) => {
  const { id } = req.params;
  const roomId = parseInt(id, 10);
  const body = req.body;
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.creator_id !== accountId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  await dbRun(
    'UPDATE rooms SET description = ?, updated_at = NOW() WHERE room_id = ?',
    [body.description || '', roomId]
  );
  
  res.json({ success: true });
});

// PUT /rooms/:id/subrooms/:sid/accessibility
router.put('/:roomId/subrooms/:subRoomId/accessibility', async (req, res) => {
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  res.json({ success: true });
});

// PUT /rooms/:id/accessibility
router.put('/:id/accessibility', async (req, res) => {
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  res.json({ success: true });
});

export default router;