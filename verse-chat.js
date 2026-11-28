/**
 * RecVerse Chat Service
 * Messages, history, channels - compatible with February 2023 client
 */

import express from 'express';
import { dbGet, dbRun, dbAll, isDbInitialized } from './verse-db.js';
import { authMiddleware } from './verse-auth-middleware.js';
import config from './verse-config.js';

const router = express.Router();

// POST /chat/send
router.post('/send', authMiddleware, async (req, res) => {
  const accountId = req.accountId;
  const body = req.body;
  const { roomId, subRoomId, messageType, content } = body;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  await dbRun(
    `INSERT INTO chat_messages (room_id, subroom_id, account_id, message_type, content, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [parseInt(roomId, 10), parseInt(subRoomId, 10), parseInt(messageType, 10) || 0, accountId, content || '']
  );
  
  return res.json({ success: true, messageId: Date.now() });
});

// GET /chat/history
router.get('/history', authMiddleware, async (req, res) => {
  const accountId = req.accountId;
  const { roomId, subRoomId, limit } = req.query;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  const messages = await dbAll(
    `SELECT * FROM chat_messages WHERE room_id = ? AND subroom_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [parseInt(roomId, 10), parseInt(subRoomId, 10), parseInt(limit, 10) || 50]
  );
  
  res.json({
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
router.get('/channels', authMiddleware, async (req, res) => {
  const accountId = req.accountId;
  
  if (!isDbInitialized()) {
    return res.status(500).json({ error: 'Database not initialized' });
  }
  
  return res.json({
    channels: [
      { id: 1, name: 'General', type: 0, isDefault: true },
    ],
  });
});

export default router;