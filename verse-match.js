/**
 * RecVerse Matchmaking Service
 * Matchmaking, presence, Photon integration - compatible with February 2023 client
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const { requireAuth, optionalAuth, getAccountById, getAccountsByIds, defaultAccount, toAccountDto } = require('./verse-auth-middleware');
const { getDb } = require('./verse-db');
const { now, buildEndpoints } = require('./verse-utils');
const config = require('./verse-config');
const logger = require('./verse-logger');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      result: 1, 
      errorCode: 1, 
      correlationId: req.body.CorrelationId || '00000000-0000-0000-0000-000000000000',
      errorMessage: errors.array()[0].msg 
    });
  }
  next();
};

// Matchmaking result codes (match client expectations)
const MATCH_RESULT = {
  Success: 0,
  GeneralError: 1,
  RoomNotFound: 2,
  RoomFull: 3,
  RoomClosed: 4,
  InvalidRoom: 5,
  NotAuthorized: 6,
  Banned: 7,
  VersionMismatch: 8,
  Maintenance: 9,
};

const ROOM_INSTANCE_TYPE = {
  Public: 0,
  Private: 1,
  Club: 2,
  Dorm: 3,
};

/**
 * GET /health
 */
router.get('/health', (req, res) => {
  res.json({ service: 'match', status: 'ok' });
});

/**
 * GET /matchmake/room/:roomId/:subRoomId - Matchmake into room
 */
router.get('/matchmake/room/:roomId/:subRoomId', requireAuth, [
  param('roomId').isInt(),
  param('subRoomId').isInt(),
  query('correlationId').optional().isUUID(),
  validate,
], async (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId, 10);
    const subRoomId = parseInt(req.params.subRoomId, 10);
    const correlationId = req.query.correlationId || '00000000-0000-0000-0000-000000000000';
    const accountId = req.accountId;
    
    logger.match('Matchmake request', { accountId, roomId, subRoomId, correlationId });
    
    const db = getDb();
    
    // Get room
    const room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!room) {
      return res.json({
        result: MATCH_RESULT.RoomNotFound,
        errorCode: MATCH_RESULT.RoomNotFound,
        correlationId,
        errorMessage: 'Room not found',
      });
    }
    
    // Get subroom
    const subroom = db.prepare('SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?').get(subRoomId, roomId);
    if (!subroom) {
      return res.json({
        result: MATCH_RESULT.RoomNotFound,
        errorCode: MATCH_RESULT.RoomNotFound,
        correlationId,
        errorMessage: 'Subroom not found',
      });
    }
    
    // Check access
    if (room.access_level === 0 && room.creator_id !== accountId) { // Private
      return res.json({
        result: MATCH_RESULT.NotAuthorized,
        errorCode: MATCH_RESULT.NotAuthorized,
        correlationId,
        errorMessage: 'Room is private',
      });
    }
    
    // Check ban
    const ban = db.prepare('SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)')
      .get(accountId, now());
    if (ban) {
      return res.json({
        result: MATCH_RESULT.Banned,
        errorCode: MATCH_RESULT.Banned,
        correlationId,
        errorMessage: 'You are banned from this server',
      });
    }
    
    // Get current save (published)
    let dataBlob = '';
    if (subroom.current_save_id) {
      const save = db.prepare('SELECT data_blob FROM subroom_saves WHERE save_id = ?').get(subroom.current_save_id);
      if (save) dataBlob = save.data_blob;
    }
    
    // Create or get room instance
    // For simplicity, use a fixed instance ID per room/subroom
    const roomInstanceId = roomId * 1000 + subRoomId;
    
    // Update presence
    db.prepare(`
      INSERT OR REPLACE INTO presence (account_id, room_instance_id, room_id, sub_room_id, room_instance_type, 
        location, data_blob, event_id, club_id, room_code, photon_region, photon_region_id, photon_room_id, 
        name, max_capacity, is_full, is_private, is_in_progress, encrypt_voice_chat, 
        status_visibility, device_class, vr_movement_mode, platform, app_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, '', 'us', 'us', ?, ?, ?, 0, 0, 0, 0, 0, 0, 1, 0, ?, ?)
    `).run(
      accountId,
      roomInstanceId,
      roomId,
      subRoomId,
      ROOM_INSTANCE_TYPE.Public,
      subroom.unity_scene_id || 'Default',
      dataBlob,
      `rec.${roomId}`,
      `^${room.name}`,
      subroom.max_players || room.max_players || 16,
      0,
      room.access_level === 0 ? 1 : 0,
      0,
      config.game.version,
      now()
    );
    
    // Get Photon config
    const photonHost = config.photon.nameServer || 'ns.exitgames.com';
    const photonPort = config.photon.nameServerPort || 4533;
    
    res.json({
      result: MATCH_RESULT.Success,
      errorCode: MATCH_RESULT.Success,
      correlationId,
      roomInstanceId,
      roomId,
      subRoomId,
      roomInstanceType: ROOM_INSTANCE_TYPE.Public,
      location: subroom.unity_scene_id || 'Default',
      dataBlob,
      eventId: 0,
      clubId: 0,
      roomCode: '',
      photonRegion: 'us',
      photonRegionId: 'us',
      photonRoomId: `rec.${roomId}`,
      name: `^${room.name}`,
      maxCapacity: subroom.max_players || room.max_players || 16,
      isFull: false,
      isPrivate: room.access_level === 0,
      isInProgress: false,
      EncryptVoiceChat: false,
      PhotonAppId: config.photon.realtimeAppId,
      PhotonAppVersion: '1.0',
      PhotonServer: photonHost,
      PhotonPort: photonPort,
      PhotonProtocol: 'Udp',
    });
  } catch (error) {
    logger.error('MATCH', 'Matchmake failed', { error: error.message });
    res.status(500).json({
      result: MATCH_RESULT.GeneralError,
      errorCode: MATCH_RESULT.GeneralError,
      correlationId: req.query.correlationId || '00000000-0000-0000-0000-000000000000',
      errorMessage: 'Internal server error',
    });
  }
});

/**
 * POST /matchmake/room/:roomId/:subRoomId - Matchmake (POST form)
 */
router.post('/matchmake/room/:roomId/:subRoomId', requireAuth, [
  param('roomId').isInt(),
  param('subRoomId').isInt(),
  body('CorrelationId').optional().isUUID(),
  validate,
], async (req, res) => {
  // Same as GET but with body params
  req.query.correlationId = req.body.CorrelationId;
  return router.handle(req, res);
});

/**
 * GET /matchmake/quick - Quick match (placeholder)
 */
router.get('/matchmake/quick', requireAuth, [
  query('tags').optional().isString(),
  query('correlationId').optional().isUUID(),
  validate,
], async (req, res) => {
  const correlationId = req.query.correlationId || '00000000-0000-0000-0000-000000000000';
  
  // Return first available public room
  const db = getDb();
  const room = db.prepare(`
    SELECT r.*, s.subroom_id, s.unity_scene_id, s.max_players 
    FROM rooms r 
    JOIN subrooms s ON s.room_id = r.room_id 
    WHERE r.access_level = 1 AND r.is_dorm = 0 
    ORDER BY r.room_id LIMIT 1
  `).get();
  
  if (!room) {
    return res.json({
      result: MATCH_RESULT.RoomNotFound,
      errorCode: MATCH_RESULT.RoomNotFound,
      correlationId,
      errorMessage: 'No rooms available',
    });
  }
  
  // Redirect to room matchmake
  req.params.roomId = room.room_id;
  req.params.subRoomId = room.subroom_id;
  return router.handle(req, res);
});

/**
 * GET /matchmake/random - Random room (placeholder)
 */
router.get('/matchmake/random', requireAuth, [
  query('correlationId').optional().isUUID(),
  validate,
], async (req, res) => {
  // Same as quick for now
  return router.handle(req, res);
});

/**
 * POST /matchmake/heartbeat - Presence heartbeat
 */
router.post('/matchmake/heartbeat', requireAuth, [
  body('roomInstanceId').isInt(),
  body('roomId').isInt(),
  body('subRoomId').isInt(),
  body('statusVisibility').optional().isInt(),
  body('deviceClass').optional().isInt(),
  body('vrMovementMode').optional().isInt(),
  body('platform').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const { roomInstanceId, roomId, subRoomId, statusVisibility, deviceClass, vrMovementMode, platform } = req.body;
    
    const db = getDb();
    db.prepare(`
      UPDATE presence SET 
        room_instance_id = ?, room_id = ?, sub_room_id = ?, 
        status_visibility = COALESCE(?, status_visibility),
        device_class = COALESCE(?, device_class),
        vr_movement_mode = COALESCE(?, vr_movement_mode),
        platform = COALESCE(?, platform),
        app_version = ?,
        updated_at = ?
      WHERE account_id = ?
    `).run(roomInstanceId, roomId, subRoomId, statusVisibility, deviceClass, vrMovementMode, platform, config.game.version, now(), accountId);
    
    // Return other players in same instance
    const others = db.prepare(`
      SELECT account_id FROM presence 
      WHERE room_instance_id = ? AND account_id != ?
    `).all(roomInstanceId, accountId);
    
    res.json({
      success: true,
      players: others.map(p => p.account_id),
    });
  } catch (error) {
    logger.error('MATCH', 'Heartbeat failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /matchmake/leave - Leave room instance
 */
router.post('/matchmake/leave', requireAuth, [
  body('roomInstanceId').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const db = getDb();
    
    // Reset presence to dorm
    db.prepare(`
      UPDATE presence SET 
        room_instance_id = -2, room_id = 13, sub_room_id = 1, room_instance_type = 0,
        location = 'Orientation', data_blob = '', photon_room_id = 'rec.13', name = '^Orientation',
        max_capacity = 4, is_full = 0, is_private = 0, is_in_progress = 0, encrypt_voice_chat = 0,
        updated_at = ?
      WHERE account_id = ?
    `).run(now(), accountId);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('MATCH', 'Leave failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /presence/:accountId - Get player presence
 */
router.get('/presence/:accountId', optionalAuth, [
  param('accountId').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    const db = getDb();
    
    const presence = db.prepare('SELECT * FROM presence WHERE account_id = ?').get(accountId);
    if (!presence) {
      return res.json({ accountId, roomInstanceId: -2, roomId: 13, subRoomId: 1 });
    }
    
    res.json(presence);
  } catch (error) {
    logger.error('MATCH', 'Get presence failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /presence/bulk - Bulk presence lookup
 */
router.post('/presence/bulk', optionalAuth, [
  body('ids').isArray(),
  validate,
], async (req, res) => {
  try {
    const ids = req.body.ids.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
    const db = getDb();
    
    const placeholders = ids.map(() => '?').join(',');
    const results = db.prepare(`SELECT * FROM presence WHERE account_id IN (${placeholders})`).all(...ids);
    
    res.json(results);
  } catch (error) {
    logger.error('MATCH', 'Bulk presence failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /photon/config - Get Photon configuration for client
 */
router.get('/photon/config', optionalAuth, (req, res) => {
  res.json({
    AppIdRealtime: config.photon.realtimeAppId,
    AppIdVoice: config.photon.voiceAppId,
    AppIdChat: config.photon.chatAppId,
    FixedRegion: 'us',
    UseNameServer: true,
    Protocol: 'Udp',
    Server: config.photon.nameServer || 'ns.exitgames.com',
    Port: config.photon.nameServerPort || 4533,
  });
});

/**
 * POST /photon/token - Get Photon auth token (if using custom auth)
 */
router.post('/photon/token', requireAuth, (req, res) => {
  // For custom Photon authentication
  const token = crypto.randomBytes(32).toString('hex');
  res.json({ token, expiresIn: 3600 });
});

module.exports = router;