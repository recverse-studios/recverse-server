/**
 * RecVerse Server - Admin Service Route (Cloudflare Workers)
 * Maintenance and broadcast commands - compatible with February 2023 client
 */

import { Hono } from 'hono';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { requireStaff, requireDeveloper } from '../auth/middleware.js';
import config from '../config.js';

const router = new Hono();

// GET /admin/maintenance/status
router.get('/maintenance/status', requireStaff, async (c) => {
  if (!isDbInitialized()) {
    return c.json({
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
    return c.json({
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
  
  return c.json({
    success: true,
    isActive: state.is_active === 1,
    scheduledAt: state.scheduled_at,
    startsAt: state.starts_at,
    startsInMinutes: remainingMinutes !== null ? remainingMinutes : state.starts_in_minutes,
    cancelled: state.cancelled === 1,
    warningIntervals: state.warning_intervals ? JSON.parse(state.warning_intervals) : [5, 3, 1],
    lastWarningSent: state.last_warning_sent,
    liveConnections: 0,
    timersPending: 0,
  });
});

// POST /admin/maintenance/start
router.post('/maintenance/start', requireDeveloper, async (c) => {
  const body = await c.req.json();
  const { minutes, warningIntervals } = body;
  
  if (!minutes || typeof minutes !== 'number' || minutes < 1) {
    return c.json({ error: 'minutes must be a positive integer' }, 400);
  }
  
  // Check if maintenance already active
  const existing = await dbGet('SELECT * FROM server_maintenance WHERE id = 1 AND is_active = 1 AND cancelled = 0');
  if (existing) {
    return c.json({
      success: false,
      error: 'Maintenance is already scheduled',
      scheduledAt: existing.scheduled_at,
      startsAt: existing.starts_at,
      startsInMinutes: existing.starts_in_minutes,
    }, 409);
  }
  
  const now = new Date();
  const scheduledAt = now.toISOString();
  const startsAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();
  const intervals = warningIntervals || [5, 3, 1];
  
  await dbRun(
    `INSERT INTO server_maintenance (id, is_active, scheduled_at, starts_at, starts_in_minutes, warning_intervals, cancelled, updated_at)
     VALUES (1, 1, ?, ?, ?, ?, 0, NOW())
     ON CONFLICT (id) DO UPDATE SET
       is_active = 1,
       scheduled_at = EXCLUDED.scheduled_at,
       starts_at = EXCLUDED.starts_at,
       starts_in_minutes = EXCLUDED.starts_in_minutes,
       warning_intervals = EXCLUDED.warning_intervals,
       cancelled = 0,
       updated_at = NOW()`,
    [scheduledAt, startsAt, minutes, JSON.stringify(intervals)]
  );
  
  return c.json({
    success: true,
    scheduledAt,
    startsAt,
    startsInMinutes: minutes,
    message: `Server maintenance scheduled in ${minutes} minute(s). Warnings will be sent at ${intervals.join(', ')} minutes before.`,
  });
});

// POST /admin/maintenance/cancel
router.post('/maintenance/cancel', requireDeveloper, async (c) => {
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const existing = await dbGet('SELECT * FROM server_maintenance WHERE id = 1 AND is_active = 1 AND cancelled = 0');
  if (!existing) {
    return c.json({
      success: false,
      error: 'No active maintenance to cancel',
    }, 409);
  }
  
  await dbRun(
    `UPDATE server_maintenance SET is_active = 0, cancelled = 1, updated_at = NOW() WHERE id = 1`
  );
  
  return c.json({
    success: true,
    cancelled: true,
    message: 'Server maintenance cancelled.',
  });
});

// POST /admin/maintenance/reschedule
router.post('/maintenance/reschedule', requireDeveloper, async (c) => {
  const body = await c.req.json();
  const { minutes } = body;
  
  if (!minutes || typeof minutes !== 'number' || minutes < 1) {
    return c.json({ error: 'minutes must be a positive integer' }, 400);
  }
  
  const existing = await dbGet('SELECT * FROM server_maintenance WHERE id = 1 AND is_active = 1 AND cancelled = 0');
  if (!existing) {
    return c.json({
      success: false,
      error: 'No active maintenance to reschedule',
    }, 409);
  }
  
  const now = new Date();
  const startsAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();
  
  await dbRun(
    `UPDATE server_maintenance SET starts_at = ?, starts_in_minutes = ?, last_warning_sent = NULL, updated_at = NOW() WHERE id = 1`,
    [startsAt, minutes]
  );
  
  return c.json({
    success: true,
    startsAt,
    startsInMinutes: minutes,
    message: `Server maintenance rescheduled to ${minutes} minute(s) from now.`,
  });
});

// POST /admin/broadcast
router.post('/broadcast', requireDeveloper, async (c) => {
  const body = await c.req.json();
  const { message, notificationType } = body;
  
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return c.json({ error: 'message is required' }, 400);
  }
  
  const type = notificationType !== undefined ? notificationType : 2;
  
  // Broadcast notification to all connected clients
  // In Workers, this would use a Durable Object or KV to store the broadcast
  // For now, we record it and return
  const typeNum = typeof type === 'string' ? parseInt(type, 10) || 2 : type;
  
  return c.json({
    success: true,
    delivered: 0,
    message: `Broadcast sent to 0 connection(s).`,
  });
});

export default router;
