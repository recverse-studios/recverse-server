/**
 * RecVerse Server - Rooms Service Route (Cloudflare Workers)
 * Room & subroom management - compatible with February 2023 client
 */

import { Hono } from 'hono';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { authMiddleware } from '../auth/middleware.js';
import config from '../config.js';

const router = new Hono();

// GET /rooms/:id
router.get('/:id', async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  
  return c.json({
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
router.post('/rooms', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { name, description, accessLevel, maxPlayers } = body;
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const result = await dbRun(
    `INSERT INTO rooms (name, description, access_level, creator_id, max_players, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [name || 'New Room', description || '', accessLevel || 1, accountId, maxPlayers || 16]
  );
  
  const roomId = result.lastInsertId;
  
  await dbRun(
    `INSERT INTO subrooms (room_id, name, unity_scene_id, max_players, created_at, updated_at)
     VALUES (?, 'Orientation', 'Orientation', ?, NOW(), NOW())`,
    [roomId, maxPlayers || 16]
  );
  
  return c.json({ success: true, roomId });
});

// PUT /rooms/:id
router.put('/:id', authMiddleware, async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  const body = await c.req.json();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  // Check ownership
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  if (room.creator_id !== accountId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  
  await dbRun(
    `UPDATE rooms SET name = ?, description = ?, access_level = ?, max_players = ?, updated_at = NOW() WHERE room_id = ?`,
    [body.name, body.description, body.accessLevel, body.maxPlayers, roomId]
  );
  
  return c.json({ success: true });
});

// DELETE /rooms/:id
router.delete('/:id', authMiddleware, async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  if (room.creator_id !== accountId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  
  await dbRun('DELETE FROM rooms WHERE room_id = ?', [roomId]);
  
  return c.json({ success: true });
});

// GET /rooms/:id/subrooms/:sid/data
router.get('/:roomId/subrooms/:subRoomId/data', async (c) => {
  const { roomId, subRoomId } = c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const subroom = await dbGet(
    'SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?',
    [parseInt(subRoomId, 10), parseInt(roomId, 10)]
  );
  
  if (!subroom) {
    return c.json({ error: 'Subroom not found' }, 404);
  }
  
  return c.json({
    subroomId: subroom.subroom_id,
    name: subroom.name,
    unitySceneId: subroom.unity_scene_id,
    maxPlayers: subroom.max_players,
    currentSaveId: subroom.current_save_id,
    stagedSaveId: subroom.staged_save_id,
  });
});

// POST /rooms/:id/subrooms/:sid/data
router.post('/:roomId/subrooms/:subRoomId/data', authMiddleware, async (c) => {
  const { roomId, subRoomId } = c.req.param();
  const body = await c.req.json();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const { description, autoPublish } = body;
  
  await dbRun(
    `INSERT INTO subroom_saves (subroom_id, account_id, description, data_blob, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [parseInt(subRoomId, 10), accountId, description || '', body.data_blob || '']
  );
  
  return c.json({ success: true });
});

// POST /rooms/:id/subrooms/:sid/publish_save
router.post('/:roomId/subrooms/:subRoomId/publish_save', authMiddleware, async (c) => {
  const { roomId, subRoomId } = c.req.param();
  const body = await c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const { subRoomDataSaveId } = body;
  
  if (subRoomDataSaveId) {
    await dbRun(
      `UPDATE subrooms SET current_save_id = ?, updated_at = NOW() WHERE subroom_id = ?`,
      [parseInt(subRoomDataSaveId, 10), parseInt(subRoomId, 10)]
    );
  }
  
  return c.json({ success: true });
});

// GET /rooms/:id/saves
router.get('/:id/saves', authMiddleware, async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json([]);
  }
  
  const saves = await dbAll(
    `SELECT s.* FROM subroom_saves s
     JOIN subrooms sr ON s.subroom_id = sr.subroom_id
     WHERE sr.room_id = ? AND s.account_id = ?
     ORDER BY s.created_at DESC`,
    [roomId, accountId]
  );
  
  return c.json(saves.map(s => ({
    saveId: s.save_id,
    subroomId: s.subroom_id,
    description: s.description,
    createdAt: s.created_at,
    unityAsset: s.unity_asset,
    unityAssetHash: s.unity_asset_hash,
  })));
});

// PUT /rooms/:id/loadscreen
router.put('/:id/loadscreen', authMiddleware, async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  const body = await c.req.json();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  if (room.creator_id !== accountId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  
  await dbRun(
    'UPDATE rooms SET load_screens = ?, updated_at = NOW() WHERE room_id = ?',
    [JSON.stringify(body.loadScreens || []), roomId]
  );
  
  return c.json({ success: true });
});

// PUT /rooms/:id/description
router.put('/:id/description', authMiddleware, async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  const body = await c.req.json();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  if (room.creator_id !== accountId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  
  await dbRun(
    'UPDATE rooms SET description = ?, updated_at = NOW() WHERE room_id = ?',
    [body.description || '', roomId]
  );
  
  return c.json({ success: true });
});

// PUT /rooms/:id/subrooms/:sid/accessibility
router.put('/:roomId/subrooms/:subRoomId/accessibility', authMiddleware, async (c) => {
  const { roomId, subRoomId } = c.req.param();
  const body = await c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  return c.json({ success: true });
});

// PUT /rooms/:id/accessibility
router.put('/:id/accessibility', authMiddleware, async (c) => {
  const { id } = c.req.param();
  const roomId = parseInt(id, 10);
  const body = await c.req.param();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  if (room.creator_id !== accountId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  
  return c.json({ success: true });
});

export default router;
