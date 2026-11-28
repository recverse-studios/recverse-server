/**
 * RecVerse Admin System
 * Maintenance and broadcast endpoints for administrative control
 */

import express from 'express';
import { dbGet, dbRun, isDbInitialized } from '../../verse-db.js';
import { requireStaff, requireDeveloper } from '../auth/middleware.js';
import config from '../../verse-config.js';
import logger from '../../verse-logger.js';

const router = express.Router();

// GET /admin/maintenance/status
router.get('/maintenance/status', requireStaff, async (req, res) => {
  if (!isDbInitialized()) {
    return res.json({
      success: true,
      isActive: false,
      scheduledAt: null,
      startsAt: null,
      startsInMinutes: null,
      cancelled: false,
      warningIntervals: [5, 3, 1],
      lastWarningSent: null,
      liveConnections: 0,
      timersPending: 0,
    });
  }
  
  const state = await dbGet('SELECT * FROM server_maintenance WHERE id = 1');
  
  if (!state) {
    return res.json({
      success: true,
      isActive: false,
      scheduledAt: null,
      startsAt: null,
      startsInMinutes: null,
      cancelled: false,
      warningIntervals: [5, 3, 1],
      lastWarningSent: null,
      liveConnections: 0,
      timersPending: 0,
    });
  }
  
  let remainingMinutes = null;
  if (state.is_active && state.starts_at && !state.cancelled) {
    const startsAtMs = new Date(state.starts_at).getTime();
    const nowMs = Date.now();
    if (startsAtMs > nowMs) {
      remainingMinutes = Math.ceil((startsAtMs - nowMs) / (1000 * 60));
    }
  }
  
  return res.json({
    success: true,
    isActive: !!state.is_active,
    scheduledAt: state.scheduled_at,
    startsAt: state.starts_at,
    startsInMinutes: remainingMinutes !== null ? remainingMinutes : state.starts_in_minutes,
    cancelled: !!state.cancelled,
    warningIntervals: state.warning_intervals ? JSON.parse(state.warning_intervals) : [5, 3, 1],
    lastWarningSent: state.last_warning_sent,
    liveConnections: 0,
    timersPending: 0,
  });
});

// POST /admin/maintenance/start
router.post('/maintenance/start', async (req, res) => {
  // Check developer role
  const devCheck = await requireDeveloper(req, res, () => {});
  if (res.headersSent) return;
  
  const { minutes, warningIntervals } = req.body;
  
  if (typeof minutes !== 'number' || minutes < 1) {
    return res.status(400).json({ error: 'minutes must be a positive integer' });
  }
  
  if (warningIntervals && (!Array.isArray(warningIntervals) || !warningIntervals.every(Number.isInteger))) {
    return res.status(400).json({ error: 'warningIntervals must be an array of integers' });
  }
  
  const result = startMaintenance(minutes, warningIntervals);
  
  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }
  
  logger.info('ADMIN', 'Maintenance started by developer', { 
    adminId: req.accountId, 
    minutes, 
    warningIntervals: result.warningIntervals 
  });
  
  return res.json({
    success: true,
    scheduledAt: result.scheduledAt,
    startsAt: result.startsAt,
    startsInMinutes: result.startsInMinutes,
    message: `Server maintenance scheduled in ${minutes} minute(s). Warnings will be sent at ${result.warningIntervals.join(', ')} minutes before.`,
  });
});

// POST /admin/maintenance/cancel
router.post('/maintenance/cancel', async (req, res) => {
  const devCheck = await requireDeveloper(req, res, () => {});
  if (res.headersSent) return;
  
  const result = cancelMaintenance();
  
  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }
  
  logger.info('ADMIN', 'Maintenance cancelled by developer', { adminId: req.accountId });
  
  return res.json({
    success: true,
    cancelled: true,
    message: 'Server maintenance cancelled.',
  });
});

// POST /admin/maintenance/reschedule
router.post('/maintenance/reschedule', async (req, res) => {
  const devCheck = await requireDeveloper(req, res, () => {});
  if (res.headersSent) return;
  
  const { minutes } = req.body;
  
  if (typeof minutes !== 'number' || minutes < 1) {
    return res.status(400).json({ error: 'minutes must be a positive integer' });
  }
  
  const result = rescheduleMaintenance(minutes);
  
  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }
  
  logger.info('ADMIN', 'Maintenance rescheduled by developer', { 
    adminId: req.accountId, 
    minutes 
  });
  
  return res.json({
    success: true,
    startsAt: result.startsAt,
    startsInMinutes: result.startsInMinutes,
    message: `Server maintenance rescheduled to ${minutes} minute(s) from now.`,
  });
});

// POST /admin/broadcast
router.post('/broadcast', async (req, res) => {
  const devCheck = await requireDeveloper(req, res, () => {});
  if (res.headersSent) return;
  
  const { message, notificationType } = req.body;
  
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required and must be a non-empty string (max 1000 chars)' });
  }
  
  if (message.length > 1000) {
    return res.status(400).json({ error: 'message must not exceed 1000 characters' });
  }
  
  // Default to MessageReceived (type 2) with Coach system pattern
  const type = notificationType !== undefined ? notificationType : 2;
  
  const result = broadcastNotification(type, { message: message.trim() });
  
  logger.info('ADMIN', 'Broadcast sent by developer', { 
    adminId: req.accountId, 
    type, 
    delivered: result.delivered 
  });
  
  return res.json({
    success: true,
    delivered: result.delivered,
    message: `Broadcast sent to ${result.delivered} connection(s).`,
  });
});

export default router;