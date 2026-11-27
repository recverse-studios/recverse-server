/**
 * RecVerse Chat Service
 * Chat messages, history, channels - compatible with February 2023 client
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const { requireAuth, optionalAuth, getAccountById, getAccountsByIds } = require('./verse-auth-middleware');
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
  res.json({ service: 'chat', status: 'ok' });
});

/**
 * POST /chat/send - Send chat message
 */
router.post('/chat/send', requireAuth, [
  body('roomId').isInt(),
  body('subRoomId').isInt(),
  body('message').isString().isLength({ min: 1, max: 500 }),
  body('messageType').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const { roomId, subRoomId, message, messageType = 0 } = req.body;
    
    const db = getDb();
    
    // Store message
    const result = db.prepare(`
      INSERT INTO chat_messages (room_id, subroom_id, account_id, message_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, subRoomId, accountId, messageType, sanitizeString(message, 500), now());
    
    const messageId = result.lastInsertRowid;
    
    // Get sender info for broadcast
    const sender = await getAccountById(accountId);
    
    // TODO: Broadcast via WebSocket/notifications to room participants
    // For now just return success
    
    logger.chat('Message sent', { accountId, roomId, subRoomId, messageId });
    
    res.json({
      success: true,
      messageId,
      timestamp: now(),
    });
  } catch (error) {
    logger.error('CHAT', 'Send message failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /chat/history - Get chat history
 */
router.get('/chat/history', requireAuth, [
  query('roomId').isInt(),
  query('subRoomId').isInt(),
  query('before').optional().isInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  validate,
], async (req, res) => {
  try {
    const { roomId, subRoomId, before, limit = 50 } = req.query;
    const db = getDb();
    
    let query = `
      SELECT cm.*, a.username, a.display_name, a.profile_image
      FROM chat_messages cm
      JOIN accounts a ON a.account_id = cm.account_id
      WHERE cm.room_id = ? AND cm.subroom_id = ?
    `;
    const params = [roomId, subRoomId];
    
    if (before) {
      query += ' AND cm.id < ?';
      params.push(before);
    }
    
    query += ' ORDER BY cm.id DESC LIMIT ?';
    params.push(limit);
    
    const messages = db.prepare(query).all(...params);
    
    res.json(messages.reverse().map(msg => ({
      id: msg.id,
      roomId: msg.room_id,
      subRoomId: msg.subroom_id,
      accountId: msg.account_id,
      username: msg.username,
      displayName: msg.display_name,
      profileImage: msg.profile_image,
      messageType: msg.message_type,
      content: msg.content,
      createdAt: msg.created_at,
    })));
  } catch (error) {
    logger.error('CHAT', 'Get history failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /chat/channels - Get chat channels for room
 */
router.get('/chat/channels', requireAuth, [
  query('roomId').isInt(),
  query('subRoomId').isInt(),
  validate,
], async (req, res) => {
  // Return default channels
  res.json([
    { id: 0, name: 'General', type: 0 },
    { id: 1, name: 'System', type: 1 },
  ]);
});

module.exports = router;