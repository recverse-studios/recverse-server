/**
 * RecVerse Server - Chat Service Route (Cloudflare Workers)
 * Messages, history, channels - compatible with February 2023 client
 */

import { Hono } from 'hono';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { authMiddleware } from '../auth/middleware.js';
import config from '../config.js';

const router = new Hono();

// POST /chat/send
router.post('/send', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { roomId, subRoomId, messageType, content } = body;
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  await dbRun(
    `INSERT INTO chat_messages (room_id, subroom_id, account_id, message_type, content, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [parseInt(roomId, 10), parseInt(subRoomId, 10), parseInt(messageType, 10) || 0, accountId, content || '']
  );
  
  return c.json({ success: true, messageId: Date.now() });
});

// GET /chat/history
router.get('/history', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const { roomId, subRoomId, limit } = c.req.query();
  
  if (!isDbInitialized()) {
    return c.json({ messages: [] });
  }
  
  const messages = await dbAll(
    `SELECT * FROM chat_messages WHERE room_id = ? AND subroom_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [parseInt(roomId, 10), parseInt(subRoomId, 10), parseInt(limit, 10) || 50]
  );
  
  return c.json({
    messages: messages.map(m => ({
      id: m.id,
      roomId: m.room_id,
      subRoomId: m.subroom_id,
      accountId: m.account_id,
      messageType: m.message_type,
      content: m.content,
      createdAt: m.created_at,
    })),
  });
});

// GET /chat/channels
router.get('/channels', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ channels: [] });
  }
  
  return c.json({
    channels: [
      { id: 1, name: 'General', type: 0, isDefault: true },
    ],
  });
});

export default router;
