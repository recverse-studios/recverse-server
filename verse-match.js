/**
 * RecVerse Match Service
 * Matchmaking & presence - compatible with February 2023 client
 */

import express from 'express';
import { dbGet, dbRun, dbAll, isDbInitialized } from './verse-db.js';
import { authMiddleware } from './verse-auth-middleware.js';
import config from './verse-config.js';

const router = express.Router();

// GET /match/matchmake/room/:roomId/:subRoomId
router.get('/matchmake/room/:roomId/:subRoomId', authMiddleware, async (req, res) => {
  const { roomId, subRoomId } = req.params;
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [parseInt(roomId, 10)]);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const subroom = await dbGet(
    'SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?',
    [parseInt(subRoomId, 10), parseInt(roomId, 10)]
  );
  
  return res.json({
    roomId: parseInt(roomId, 10),
    subRoomId: parseInt(subRoomId, 10),
    roomName: room.name,
    subRoomName: subroom.name,
    maxPlayers: subroom.max_players,
    photonRegion: 'us',
    photonRoomId: `rec.${roomId}`,
    correlationId: '00000000-0000-0000-0000-000000000000',
    result: 0,
    errorCode: 0,
  });
});

// POST /match/matchmake/room/:roomId/:subRoomId
router.post('/matchmake/room/:roomId/:subRoomId', authMiddleware, async (req, res) => {
  const { roomId, subRoomId } = req.params;
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  return res.json({
    roomId: parseInt(roomId, 10),
    subRoomId: parseInt(subRoomId, 10),
    result: 0,
    errorCode: 0,
    correlationId: '00000000-0000-0000-0000-000000000000',
  });
});

// GET /match/matchmake/quick
router.get('/matchmake/quick', authMiddleware, async (req, res) => {
  return res.json({
    roomId: 13,
    subRoomId: 1,
    result: 0,
    errorCode: 0,
  });
});

// POST /match/matchmake/heartbeat
router.post('/matchmake/heartbeat', authMiddleware, async (req, res) => {
  return res.json({ success: true });
});

// POST /match/matchmake/leave
router.post('/matchmake/leave', authMiddleware, async (req, res) => {
  return res.json({ success: true });
});

// GET /match/presence/:accountId
router.get('/presence/:accountId', authMiddleware, async (req, res) => {
  const { accountId } = req.params;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const presence = await dbGet(
    'SELECT * FROM presence WHERE account_id = ?',
    [parseInt(accountId, 10)]
  );
  
  if (!presence) {
    return res.json({
      accountId: parseInt(accountId, 10),
      roomInstanceId: -2,
      roomId: 13,
      subRoomId: 1,
      location: 'Orientation',
      statusVisibility: 0,
    });
  }
  
  return res.json({
    accountId: presence.account_id,
    roomInstanceId: presence.room_instance_id,
    roomId: presence.room_id,
    subRoomId: presence.sub_room_id,
    location: presence.location,
    statusVisibility: presence.status_visibility,
    roomInstanceType: presence.room_instance_type,
    maxCapacity: presence.max_capacity,
    isFull: presence.is_full === 1,
    isPrivate: presence.is_private === 1,
    isInProgress: presence.is_in_progress === 1,
    encryptVoiceChat: presence.encrypt_voice_chat === 1,
    deviceClass: presence.device_class,
    vrMovementMode: presence.vr_movement_mode,
    platform: presence.platform,
    appVersion: presence.app_version,
    roomCode: presence.room_code,
    photonRegion: presence.photon_region,
    photonRegionId: presence.photon_region_id,
    photonRoomId: presence.photon_room_id,
  });
});

// POST /match/presence/bulk
router.post('/presence/bulk', authMiddleware, async (req, res) => {
  const body = req.body;
  const { accountIds } = body;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const presences = [];
  for (const id of accountIds) {
    const presence = await dbGet(
      'SELECT * FROM presence WHERE account_id = ?',
      [parseInt(id, 10)]
    );
    if (presence) {
      presences.push({
        accountId: presence.account_id,
        roomInstanceId: presence.room_instance_id,
        roomId: presence.room_id,
        subRoomId: presence.sub_room_id,
        location: presence.location,
        statusVisibility: presence.status_visibility,
      });
    }
  }
  
  return res.json({ presences });
});

// GET /match/photon/config
router.get('/photon/config', async (req, res) => {
  return res.json({
    realtimeAppId: config.photon.realtimeAppId,
    voiceAppId: config.photon.voiceAppId,
    chatAppId: config.photon.chatAppId,
    nameServer: config.photon.nameServer,
    nameServerPort: config.photon.nameServerPort,
    region: 'us',
  });
});

export default router;