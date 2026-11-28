/**
 * RecVerse Server - Match Service Route (Cloudflare Workers)
 * Matchmaking & presence - compatible with February 2023 client
 */

import { Hono } from 'hono';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { authMiddleware } from '../auth/middleware.js';
import config from '../config.js';

const router = new Hono();

// GET /match/matchmake/room/:roomId/:subRoomId
router.get('/matchmake/room/:roomId/:subRoomId', authMiddleware, async (c) => {
  const { roomId, subRoomId } = c.req.param();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const room = await dbGet('SELECT * FROM rooms WHERE room_id = ?', [parseInt(roomId, 10)]);
  if (!room) {
    return c.json({ error: 'Room not found' }, 404);
  }
  
  const subroom = await dbGet(
    'SELECT * FROM subrooms WHERE subroom_id = ? AND room_id = ?',
    [parseInt(subRoomId, 10), parseInt(roomId, 10)]
  );
  
  return c.json({
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
router.post('/matchmake/room/:roomId/:subRoomId', authMiddleware, async (c) => {
  const { roomId, subRoomId } = c.req.param();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  return c.json({
    roomId: parseInt(roomId, 10),
    subRoomId: parseInt(subRoomId, 10),
    result: 0,
    errorCode: 0,
    correlationId: '00000000-0000-0000-0000-000000000000',
  });
});

// GET /match/matchmake/quick
router.get('/matchmake/quick', authMiddleware, async (c) => {
  return c.json({
    roomId: 13,
    subRoomId: 1,
    result: 0,
    errorCode: 0,
  });
});

// POST /match/matchmake/heartbeat
router.post('/match/matchmake/heartbeat', authMiddleware, async (c) => {
  return c.json({ success: true });
});

// POST /match/matchmake/leave
router.post('/match/matchmake/leave', authMiddleware, async (c) => {
  return c.json({ success: true });
});

// GET /match/presence/:accountId
router.get('/presence/:accountId', authMiddleware, async (c) => {
  const { accountId } = c.req.param();
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const presence = await dbGet(
    'SELECT * FROM presence WHERE account_id = ?',
    [parseInt(accountId, 10)]
  );
  
  if (!presence) {
    return c.json({
      accountId: parseInt(accountId, 10),
      roomInstanceId: -2,
      roomId: 13,
      subRoomId: 1,
      location: 'Orientation',
      statusVisibility: 0,
    });
  }
  
  return c.json({
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
    name: presence.name,
    roomCode: presence.room_code,
    photonRegion: presence.photon_region,
    photonRegionId: presence.photon_region_id,
    photonRoomId: presence.photon_room_id,
  });
});

// POST /match/presence/bulk
router.post('/presence/bulk', authMiddleware, async (c) => {
  const body = await c.req.json();
  const { accountIds } = body;
  
  if (!isDbInitialized()) {
    return c.json({ presences: [] });
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
  
  return c.json({ presences });
});

// GET /match/photon/config
router.get('/photon/config', async (c) => {
  return c.json({
    realtimeAppId: config.photon.realtimeAppId,
    voiceAppId: config.photon.voiceAppId,
    chatAppId: config.photon.chatAppId,
    nameServer: config.photon.nameServer,
    nameServerPort: config.photon.nameServerPort,
    region: 'us',
  });
});

export default router;
