/**
 * RecVerse Rooms Service
 * Room management, subrooms, saves - compatible with February 2023 client
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');

const { requireAuth, optionalAuth, getAccountById, getAccountsByIds, defaultAccount, toAccountDto, updateAccount } = require('./verse-auth-middleware');
const { getDb } = require('./verse-db');
const { now, sanitizeString } = require('./verse-utils');
const config = require('./verse-config');
const logger = require('./verse-logger');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: errors.array()[0].msg });
  }
  next();
};

/**
 * GET /health
 */
router.get('/health', (req, res) => {
  res.json({ service: 'rooms', status: 'ok' });
});

/**
 * GET /rooms/:id - Get room details
 */
router.get('/rooms/:id', optionalAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    // Get subrooms
    const subrooms = db.prepare('SELECT * FROM subrooms WHERE room_id = ?').all(roomId);
    
    // Get current save for each subroom
    for (const sub of subrooms) {
      if (sub.current_save_id) {
        const save = db.prepare('SELECT * FROM subroom_saves WHERE save_id = ?').get(sub.current_save_id);
        if (save) {
          sub.CurrentSave = {
            SaveId: save.save_id,
            SubRoomId: save.subroom_id,
            AccountId: save.account_id,
            Description: save.description,
            DataBlob: save.data_blob,
            UnityAsset: save.unity_asset,
            UnityAssetHash: save.unity_asset_hash,
            UnityAsset2: save.unity_asset2,
            UnityAsset2Hash: save.unity_asset2_hash,
            UnitySubAssets: JSON.parse(save.unity_sub_assets || '[]'),
            PersistenceVersion: save.persistence_version,
            InventionUsage: JSON.parse(save.invention_usage || '[]'),
            CreatedAt: save.created_at,
          };
        }
      }
    }
    
    const result = {
      RoomId: room.room_id,
      Name: room.name,
      Description: room.description,
      AccessLevel: room.access_level,
      CreatorId: room.creator_id,
      CreatedAt: room.created_at,
      UpdatedAt: room.updated_at,
      ImageName: room.image_name,
      Tags: JSON.parse(room.tags || '[]'),
      MaxPlayers: room.max_players,
      IsDorm: room.is_dorm === 1,
      LoadScreens: JSON.parse(room.load_screens || '[]'),
      SubRooms: subrooms.map(sub => ({
        SubRoomId: sub.subroom_id,
        RoomId: sub.room_id,
        Name: sub.name,
        UnitySceneId: sub.unity_scene_id,
        MaxPlayers: sub.max_players,
        CurrentSaveId: sub.current_save_id,
        StagedSubRoomDataSaveId: sub.staged_save_id,
        CreatedAt: sub.created_at,
        UpdatedAt: sub.updated_at,
        CurrentSave: sub.CurrentSave,
      })),
    };
    
    res.json(result);
  } catch (error) {
    logger.error('ROOMS', 'Get room failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /rooms - Create room
 */
router.post('/rooms', requireAuth, [
  body('name').isString().isLength({ min: 1, max: 50 }),
  body('description').optional().isString(),
  body('accessLevel').optional().isInt({ min: 0, max: 4 }),
  body('isDorm').optional().isBoolean(),
  body('maxPlayers').optional().isInt({ min: 1, max: 64 }),
  validate,
], async (req, res) => {
  try {
    const { name, description = '', accessLevel = 1, isDorm = false, maxPlayers = 16 } = req.body;
    const db = getDb();
    
    // Create room
    const roomResult = db.prepare(`
      INSERT INTO rooms (name, description, access_level, creator_id, is_dorm, max_players, tags, load_screens)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '[]')
    `).run(name, description, accessLevel, req.accountId, isDorm ? 1 : 0, maxPlayers);
    
    const roomId = roomResult.lastInsertRowid;
    
    // Create default subroom
    db.prepare(`
      INSERT INTO subrooms (room_id, name, unity_scene_id, max_players)
      VALUES (?, ?, 'Default', ?)
    `).run(roomId, name, maxPlayers);
    
    // Place creator in room
    db.prepare(`
      INSERT INTO presence (account_id, room_instance_id, room_id, sub_room_id, room_instance_type, 
        location, data_blob, photon_region, photon_region_id, photon_room_id, name, max_capacity,
        is_full, is_private, is_in_progress, encrypt_voice_chat, status_visibility, device_class,
        vr_movement_mode, platform, app_version)
      VALUES (?, 1, ?, 1, 1, 'Default', '', 'us', 'us', ?, ?, ?, 0, 0, 0, 0, 0, 0, 1, 0, ?)
    `).run(req.accountId, roomId, `rec.${roomId}`, `^${name}`, maxPlayers, config.game.version);
    
    logger.rooms('Room created', { roomId, creatorId: req.accountId, name });
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Create room failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /rooms/:id - Update room
 */
router.put('/rooms/:id', requireAuth, [
  param('id').isInt(),
  body('name').optional().isString().isLength({ min: 1, max: 50 }),
  body('description').optional().isString(),
  body('accessLevel').optional().isInt({ min: 0, max: 4 }),
  body('maxPlayers').optional().isInt({ min: 1, max: 64 }),
  body('imageName').optional().isString(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.accessLevel !== undefined) updates.access_level = req.body.accessLevel;
    if (req.body.maxPlayers !== undefined) updates.max_players = req.body.maxPlayers;
    if (req.body.imageName !== undefined) updates.image_name = req.body.imageName;
    
    if (Object.keys(updates).length > 0) {
      const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(updates), roomId];
      db.prepare(`UPDATE rooms SET ${fields}, updated_at = ? WHERE room_id = ?`).run(...values, now(), roomId);
    }
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Update room failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /rooms/:id - Delete room
 */
router.delete('/rooms/:id', requireAuth, [
  param('id').isInt(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    // Delete cascades to subrooms and saves
    db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
    
    logger.rooms('Room deleted', { roomId, accountId: req.accountId });
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Delete room failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /rooms/:id/clone - Clone room
 */
router.post('/rooms/:id/clone', requireAuth, [
  param('id').isInt(),
  body('name').isString().isLength({ min: 1, max: 50 }),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const { name } = req.body;
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    // Check access
    if (room.access_level === 0) { // Private
      // Only creator can clone private rooms
      if (room.creator_id !== req.accountId) {
        return res.status(403).json({ success: false, error: 'Cannot clone private room' });
      }
    }
    
    // Clone room
    const roomResult = db.prepare(`
      INSERT INTO rooms (name, description, access_level, creator_id, is_dorm, max_players, tags, load_screens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, room.description, room.access_level, req.accountId, room.is_dorm, room.max_players, room.tags, room.load_screens);
    
    const newRoomId = roomResult.lastInsertRowid;
    
    // Clone subrooms
    const subrooms = db.prepare('SELECT * FROM subrooms WHERE room_id = ?').all(roomId);
    for (const sub of subrooms) {
      const subResult = db.prepare(`
        INSERT INTO subrooms (room_id, name, unity_scene_id, max_players, current_save_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(newRoomId, sub.name, sub.unity_scene_id, sub.max_players, sub.current_save_id);
      
      // Clone current save if exists
      if (sub.current_save_id) {
        const save = db.prepare('SELECT * FROM subroom_saves WHERE save_id = ?').get(sub.current_save_id);
        if (save) {
          const saveResult = db.prepare(`
            INSERT INTO subroom_saves (subroom_id, account_id, description, data_blob, unity_asset, unity_asset_hash,
              unity_asset2, unity_asset2_hash, unity_sub_assets, persistence_version, invention_usage)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(subResult.lastInsertRowid, req.accountId, save.description, save.data_blob, save.unity_asset,
            save.unity_asset_hash, save.unity_asset2, save.unity_asset2_hash, save.unity_sub_assets,
            save.persistence_version, save.invention_usage);
          
          // Update subroom with new save ID
          db.prepare('UPDATE subrooms SET current_save_id = ? WHERE subroom_id = ?')
            .run(saveResult.lastInsertRowid, subResult.lastInsertRowid);
        }
      }
    }
    
    logger.rooms('Room cloned', { originalRoomId: roomId, newRoomId, accountId: req.accountId });
    
    res.json({ success: true, error: '', value: { roomId: newRoomId } });
  } catch (error) {
    logger.error('ROOMS', 'Clone room failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /rooms/:id/subrooms/:sid/data - Get subroom save data (staged or current)
 */
router.get('/rooms/:id/subrooms/:sid/data', requireAuth, [
  param('id').isInt(),
  param('sid').isInt(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const subroomId = parseInt(req.params.sid, 10);
    const db = getDb();
    
    const subroom = db.prepare('SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?').get(subroomId, roomId);
    if (!subroom) {
      return res.status(404).json({ success: false, error: 'Subroom not found' });
    }
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    // Return staged save if exists, otherwise current
    const saveId = subroom.staged_save_id || subroom.current_save_id;
    if (!saveId) {
      return res.json({ success: true, error: '', value: { room: null, subRoomDataSave: null } });
    }
    
    const save = db.prepare('SELECT * FROM subroom_saves WHERE save_id = ?').get(saveId);
    if (!save) {
      return res.json({ success: true, error: '', value: { room: null, subRoomDataSave: null } });
    }
    
    res.json({
      success: true,
      error: '',
      value: {
        room: { RoomId: roomId },
        subRoomDataSave: {
          SubRoomDataSaveId: save.save_id,
          SubRoomId: save.subroom_id,
          AccountId: save.account_id,
          Description: save.description,
          DataBlob: save.data_blob,
          UnityAsset: save.unity_asset,
          UnityAssetHash: save.unity_asset_hash,
          UnityAsset2: save.unity_asset2,
          UnityAsset2Hash: save.unity_asset2_hash,
          UnitySubAssets: JSON.parse(save.unity_sub_assets || '[]'),
          PersistenceVersion: save.persistence_version,
          InventionUsage: JSON.parse(save.invention_usage || '[]'),
          CreatedAt: save.created_at,
        },
      },
    });
  } catch (error) {
    logger.error('ROOMS', 'Get subroom data failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /rooms/:id/subrooms/:sid/data - Save subroom data
 */
router.post('/rooms/:id/subrooms/:sid/data', requireAuth, [
  param('id').isInt(),
  param('sid').isInt(),
  body('Description').optional().isString(),
  body('DataBlob').isString(),
  body('UnityAsset').optional().isString(),
  body('UnityAssetHash').optional().isString(),
  body('UnityAsset2').optional().isString(),
  body('UnityAsset2Hash').optional().isString(),
  body('UnitySubAssets').optional().isArray(),
  body('PersistenceVersion').optional().isInt(),
  body('InventionUsage').optional().isArray(),
  body('AutoPublish').optional().isBoolean(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const subroomId = parseInt(req.params.sid, 10);
    const db = getDb();
    
    const subroom = db.prepare('SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?').get(subroomId, roomId);
    if (!subroom) {
      return res.status(404).json({ success: false, error: 'Subroom not found' });
    }
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    const {
      Description = '',
      DataBlob,
      UnityAsset = '',
      UnityAssetHash = '',
      UnityAsset2 = '',
      UnityAsset2Hash = '',
      UnitySubAssets = [],
      PersistenceVersion = 0,
      InventionUsage = [],
      AutoPublish = false,
    } = req.body;
    
    // Create save
    const saveResult = db.prepare(`
      INSERT INTO subroom_saves (subroom_id, account_id, description, data_blob, unity_asset, unity_asset_hash,
        unity_asset2, unity_asset2_hash, unity_sub_assets, persistence_version, invention_usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(subroomId, req.accountId, Description, DataBlob, UnityAsset, UnityAssetHash,
      UnityAsset2, UnityAsset2Hash, JSON.stringify(UnitySubAssets), PersistenceVersion, JSON.stringify(InventionUsage));
    
    const saveId = saveResult.lastInsertRowid;
    
    if (AutoPublish) {
      // Publish immediately
      db.prepare('UPDATE subrooms SET current_save_id = ?, staged_save_id = NULL WHERE subroom_id = ?')
        .run(saveId, subroomId);
    } else {
      // Stage only
      db.prepare('UPDATE subrooms SET staged_save_id = ? WHERE subroom_id = ?')
        .run(saveId, subroomId);
    }
    
    const save = db.prepare('SELECT * FROM subroom_saves WHERE save_id = ?').get(saveId);
    
    logger.rooms('Subroom saved', { roomId, subroomId, saveId, autoPublish: AutoPublish });
    
    res.json({
      success: true,
      error: '',
      value: {
        room: { RoomId: roomId },
        subRoomDataSave: {
          SubRoomDataSaveId: save.save_id,
          SubRoomId: save.subroom_id,
          AccountId: save.account_id,
          Description: save.description,
          DataBlob: save.data_blob,
          UnityAsset: save.unity_asset,
          UnityAssetHash: save.unity_asset_hash,
          UnityAsset2: save.unity_asset2,
          UnityAsset2Hash: save.unity_asset2_hash,
          UnitySubAssets: JSON.parse(save.unity_sub_assets || '[]'),
          PersistenceVersion: save.persistence_version,
          InventionUsage: JSON.parse(save.invention_usage || '[]'),
          CreatedAt: save.created_at,
        },
      },
    });
  } catch (error) {
    logger.error('ROOMS', 'Save subroom failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /rooms/:id/subrooms/:sid/publish_save - Publish staged save
 */
router.post('/rooms/:id/subrooms/:sid/publish_save', requireAuth, [
  param('id').isInt(),
  param('sid').isInt(),
  body('subRoomDataSaveId').isInt(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const subroomId = parseInt(req.params.sid, 10);
    const { subRoomDataSaveId } = req.body;
    const db = getDb();
    
    const subroom = db.prepare('SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?').get(subroomId, roomId);
    if (!subroom) {
      return res.status(404).json({ success: false, error: 'Subroom not found' });
    }
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    // Verify save exists and belongs to this subroom
    const save = db.prepare('SELECT * FROM subroom_saves WHERE save_id = ? AND subroom_id = ?')
      .get(subRoomDataSaveId, subroomId);
    if (!save) {
      return res.status(404).json({ success: false, error: 'Save not found' });
    }
    
    // Publish
    db.prepare('UPDATE subrooms SET current_save_id = ?, staged_save_id = NULL WHERE subroom_id = ?')
      .run(subRoomDataSaveId, subroomId);
    
    // Return updated room
    const updatedRoom = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    const updatedSubrooms = db.prepare('SELECT * FROM subrooms WHERE room_id = ?').all(roomId);
    
    logger.rooms('Save published', { roomId, subroomId, saveId: subRoomDataSaveId });
    
    res.json({
      success: true,
      error: '',
      value: {
        RoomId: updatedRoom.room_id,
        Name: updatedRoom.name,
        Description: updatedRoom.description,
        AccessLevel: updatedRoom.access_level,
        CreatorId: updatedRoom.creator_id,
        CreatedAt: updatedRoom.created_at,
        UpdatedAt: updatedRoom.updated_at,
        ImageName: updatedRoom.image_name,
        Tags: JSON.parse(updatedRoom.tags || '[]'),
        MaxPlayers: updatedRoom.max_players,
        IsDorm: updatedRoom.is_dorm === 1,
        LoadScreens: JSON.parse(updatedRoom.load_screens || '[]'),
        SubRooms: updatedSubrooms.map(sub => ({
          SubRoomId: sub.subroom_id,
          RoomId: sub.room_id,
          Name: sub.name,
          UnitySceneId: sub.unity_scene_id,
          MaxPlayers: sub.max_players,
          CurrentSaveId: sub.current_save_id,
          StagedSubRoomDataSaveId: sub.staged_save_id,
          CreatedAt: sub.created_at,
          UpdatedAt: sub.updated_at,
        })),
      },
    });
  } catch (error) {
    logger.error('ROOMS', 'Publish save failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /rooms/:id/saves - List room saves
 */
router.get('/rooms/:id/saves', requireAuth, [
  param('id').isInt(),
  param('sid').isInt(),
  query('includeUnityAssets').optional().isBoolean(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const subroomId = parseInt(req.params.sid, 10);
    const includeUnityAssets = req.query.includeUnityAssets === 'true';
    const db = getDb();
    
    const subroom = db.prepare('SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?').get(subroomId, roomId);
    if (!subroom) {
      return res.status(404).json({ success: false, error: 'Subroom not found' });
    }
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    
    // Check permissions: creator, co-owner, in room, or staff
    const isCreator = room.creator_id === req.accountId;
    const isInRoom = false; // TODO: check presence
    
    if (!isCreator && !isInRoom) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const saves = db.prepare(`
      SELECT * FROM subroom_saves WHERE subroom_id = ? ORDER BY created_at DESC
    `).all(subroomId);
    
    const results = saves.map(save => ({
      SubRoomDataSaveId: save.save_id,
      SubRoomId: save.subroom_id,
      AccountId: save.account_id,
      Description: save.description,
      UnityAsset: includeUnityAssets ? save.unity_asset : '',
      UnityAssetHash: includeUnityAssets ? save.unity_asset_hash : '',
      UnityAsset2: includeUnityAssets ? save.unity_asset2 : '',
      UnityAsset2Hash: includeUnityAssets ? save.unity_asset2_hash : '',
      UnitySubAssets: includeUnityAssets ? JSON.parse(save.unity_sub_assets || '[]') : [],
      PersistenceVersion: save.persistence_version,
      InventionUsage: JSON.parse(save.invention_usage || '[]'),
      CreatedAt: save.created_at,
      IsCurrent: save.save_id === subroom.current_save_id,
      IsStaged: save.save_id === subroom.staged_save_id,
    }));
    
    res.json(results);
  } catch (error) {
    logger.error('ROOMS', 'List saves failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /rooms/:id/saves/:saveId - Get save details
 */
router.get('/rooms/:id/saves/:saveId', requireAuth, [
  param('id').isInt(),
  param('sid').isInt(),
  param('saveId').isInt(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const subroomId = parseInt(req.params.sid, 10);
    const saveId = parseInt(req.params.saveId, 10);
    const db = getDb();
    
    const save = db.prepare('SELECT * FROM subroom_saves WHERE save_id = ? AND subroom_id = ?').get(saveId, subroomId);
    if (!save) {
      return res.status(404).json({ success: false, error: 'Save not found' });
    }
    
    res.json({
      SubRoomDataSaveId: save.save_id,
      SubRoomId: save.subroom_id,
      AccountId: save.account_id,
      Description: save.description,
      DataBlob: save.data_blob,
      UnityAsset: save.unity_asset,
      UnityAssetHash: save.unity_asset_hash,
      UnityAsset2: save.unity_asset2,
      UnityAsset2Hash: save.unity_asset2_hash,
      UnitySubAssets: JSON.parse(save.unity_sub_assets || '[]').map(a => ({
        UnityAssetId: a.UnityAssetId,
        UnityAsset: a.UnityAsset,
        UnityAssetHash: a.UnityAssetHash,
      })),
      PersistenceVersion: save.persistence_version,
      InventionUsage: JSON.parse(save.invention_usage || '[]'),
      CreatedAt: save.created_at,
    });
  } catch (error) {
    logger.error('ROOMS', 'Get save details failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /rooms/:id/loadscreen - Set load screen
 */
router.put('/rooms/:id/loadscreen', requireAuth, [
  param('id').isInt(),
  body('loadScreens').isArray(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const { loadScreens } = req.body;
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    // Replace entire load screens array (client only uses first)
    db.prepare('UPDATE rooms SET load_screens = ?, updated_at = ? WHERE room_id = ?')
      .run(JSON.stringify(loadScreens), now(), roomId);
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Set load screen failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /rooms/:id/description - Set room description
 */
router.put('/rooms/:id/description', requireAuth, [
  param('id').isInt(),
  body('description').isString(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const { description } = req.body;
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    db.prepare('UPDATE rooms SET description = ?, updated_at = ? WHERE room_id = ?')
      .run(description, now(), roomId);
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Set description failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /rooms/:id/subrooms/:sid/accessibility - Set subroom accessibility
 */
router.put('/rooms/:id/subrooms/:sid/accessibility', requireAuth, [
  param('id').isInt(),
  param('sid').isInt(),
  body('accessibility').isString().isIn(['Private', 'Public', 'Unlisted', 'Dev_only', 'Dev_Unlisted']),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const subroomId = parseInt(req.params.sid, 10);
    const { accessibility } = req.body;
    const db = getDb();
    
    const subroom = db.prepare('SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?').get(subroomId, roomId);
    if (!subroom) {
      return res.status(404).json({ success: false, error: 'Subroom not found' });
    }
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    // Map string to int
    const accessMap = { Private: 0, Public: 1, Unlisted: 2, Dev_only: 3, Dev_Unlisted: 4 };
    const accessLevel = accessMap[accessibility] ?? 1;
    
    db.prepare('UPDATE rooms SET access_level = ?, updated_at = ? WHERE room_id = ?')
      .run(accessLevel, now(), roomId);
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Set accessibility failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /rooms/:id/accessibility - Set room accessibility (legacy)
 */
router.put('/rooms/:id/accessibility', requireAuth, [
  param('id').isInt(),
  body('accessibility').isInt({ min: 0, max: 4 }),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const { accessibility } = req.body;
    const db = getDb();
    
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    if (room.creator_id !== req.accountId) {
      return res.status(403).json({ success: false, error: 'Not room owner' });
    }
    
    db.prepare('UPDATE rooms SET access_level = ?, updated_at = ? WHERE room_id = ?')
      .run(accessibility, now(), roomId);
    
    res.json({ success: true, error: '', value: { roomId } });
  } catch (error) {
    logger.error('ROOMS', 'Set room accessibility failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;