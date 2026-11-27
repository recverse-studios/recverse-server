/**
 * RecVerse Server - Admin Command Integration
 * src/systems/verse-admin.js
 *
 * Integrates the maintenance and broadcast systems into the administrative
 * command infrastructure. Provides HTTP endpoints for admin-controlled
 * server maintenance and player notifications.
 *
 * Commands:
 *   POST /admin/maintenance/start   - Start scheduled maintenance
 *   POST /admin/maintenance/cancel  - Cancel scheduled maintenance
 *   GET  /admin/maintenance/status  - Get maintenance status
 *   POST /admin/maintenance/reschedule - Reschedule maintenance
 *   POST /admin/broadcast           - Broadcast a message to all players
 *
 * Permission model (adapted from RecFlare's requireAdmin/requireDeveloper):
 *   - Maintenance commands: require 'developer' role (same as RecFlare's
 *     requireDeveloper, since maintenance speaks to every player)
 *   - Broadcast: require 'developer' role (broadcast speaks to every player)
 *
 * RecFlare reference: apps/notify/src/notify.app.ts - /internal/* routes
 *   - POST /internal/broadcast (requireDeveloper)
 *   - The maintenance frame carries Msg: { StartsInMinutes }
 */

const express = require('express');
const { requireStaff } = require('../../verse-auth-middleware');
const { writeAuditLog } = require('../../verse-auth-middleware');
const { getDb } = require('../../verse-db');
const logger = require('../../verse-logger');
const {
  startMaintenance,
  cancelMaintenance,
  rescheduleMaintenance,
  getMaintenanceStatus,
  isMaintenanceActive,
  NOTIFICATION_TYPE_SERVER_MAINTENANCE,
} = require('./verse-maintenance');
const {
  broadcastNotification,
  notifyPlayer,
  NOTIFICATION_TYPE_SERVER_MAINTENANCE: BROADCAST_MAINT_TYPE,
} = require('./verse-broadcast');

// ============================================================================
// Admin role check
// ============================================================================

/**
 * Check if the request payload has the 'developer' role.
 * RecFlare's requireDeveloper gate: maintenance and broadcast are restricted
 * to developers because they affect every connected player.
 * @param {Object} payload - JWT token payload
 * @returns {boolean}
 */
function isDeveloper(payload) {
  if (!payload || !payload.role) return false;
  const roles = Array.isArray(payload.role) ? payload.role : [payload.role];
  return roles.includes('developer');
}

/**
 * Middleware: require developer role for maintenance/broadcast endpoints.
 * Returns 401 for missing/invalid token, 403 for non-developer.
 */
function requireDeveloper(req, res, next) {
  const { validateAndGetPayload } = require('../../verse-auth-middleware');
  const payload = validateAndGetPayload(req);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isDeveloper(payload)) {
    // Audited like any other call: a signed-in account reaching for an admin endpoint
    const accountId = parseInt(payload.sub, 10);
    if (Number.isInteger(accountId) && accountId > 0) {
      try {
        writeAuditLog({
          playerId: accountId,
          action: 'admin_endpoint_forbidden',
          data: { path: req.path, method: req.method, roles: payload.role },
        });
      } catch (_) { /* auditing must not block the response */ }
    }
    return res.status(403).json({ error: 'Forbidden: developer role required' });
  }
  req.tokenPayload = payload;
  next();
}

// ============================================================================
// Audit logging helper
// ============================================================================

/**
 * Record an administrative action to the audit log.
 * Never throws - failures are logged to console only.
 * @param {number} playerId - The admin account ID
 * @param {string} action - The action verb (e.g. 'maintenance_start')
 * @param {Record<string, unknown>} data - Action details
 */
function auditAdminAction(playerId, action, data) {
  try {
    writeAuditLog({
      playerId,
      action,
      data: {
        ...data,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('ADMIN', 'Failed to write audit log', {
      action,
      playerId,
      error: err.message,
    });
  }
}

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate a positive integer minutes value.
 * @param {unknown} value
 * @returns {number|null} The validated minutes or null
 */
function validateMinutes(value) {
  const minutes = parseInt(value, 10);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) { // max 1 year
    return null;
  }
  return minutes;
}

/**
 * Validate a broadcast message string.
 * @param {unknown} value
 * @returns {string|null} The validated message or null
 */
function validateBroadcastMessage(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  if (value.length > 1000) return null; // Reasonable message length cap
  return value.trim();
}

// ============================================================================
// Route handlers
// ============================================================================

/**
 * POST /admin/maintenance/start
 * Body: { minutes: number, warningIntervals?: number[] }
 * Starts a scheduled maintenance with countdown notifications.
 */
async function handleMaintenanceStart(req, res) {
  const accountId = parseInt(req.tokenPayload.sub, 10);
  const { minutes, warningIntervals } = req.body;

  const validatedMinutes = validateMinutes(minutes);
  if (validatedMinutes === null) {
    auditAdminAction(accountId, 'maintenance_start_invalid', { minutes });
    return res.status(400).json({ error: 'minutes must be an integer between 1 and 525600' });
  }

  let validatedIntervals = undefined;
  if (warningIntervals !== undefined) {
    if (!Array.isArray(warningIntervals)) {
      return res.status(400).json({ error: 'warningIntervals must be an array of positive integers' });
    }
    validatedIntervals = warningIntervals
      .map(v => validateMinutes(v))
      .filter(v => v !== null);
    if (validatedIntervals.length === 0) {
      return res.status(400).json({ error: 'warningIntervals must contain at least one valid positive integer' });
    }
    validatedIntervals.sort((a, b) => b - a); // descending for countdown
  }

  const result = startMaintenance(validatedMinutes, {
    warningIntervals: validatedIntervals,
  });

  if (!result.success) {
    auditAdminAction(accountId, 'maintenance_start_rejected', {
      minutes: validatedMinutes,
      reason: result.error,
    });
    return res.status(409).json({ error: result.error });
  }

  auditAdminAction(accountId, 'maintenance_start', {
    minutes: validatedMinutes,
    startsAt: result.startsAt,
    warningIntervals: result.warningIntervals || [5, 3, 1],
  });

  logger.info('ADMIN', 'Maintenance started by admin', {
    adminAccountId: accountId,
    minutes: validatedMinutes,
    startsAt: result.startsAt,
  });

  return res.json({
    success: true,
    scheduledAt: result.scheduledAt,
    startsAt: result.startsAt,
    startsInMinutes: result.startsInMinutes,
    message: result.message,
  });
}

/**
 * POST /admin/maintenance/cancel
 * Cancels a scheduled maintenance.
 */
async function handleMaintenanceCancel(req, res) {
  const accountId = parseInt(req.tokenPayload.sub, 10);

  const result = cancelMaintenance();

  if (!result.success) {
    auditAdminAction(accountId, 'maintenance_cancel_rejected', {
      reason: result.error,
    });
    return res.status(409).json({ error: result.error });
  }

  auditAdminAction(accountId, 'maintenance_cancel', {
    scheduledAt: result.scheduledAt,
    startsAt: result.startsAt,
  });

  logger.info('ADMIN', 'Maintenance cancelled by admin', {
    adminAccountId: accountId,
  });

  return res.json({
    success: true,
    cancelled: true,
    message: result.message,
  });
}

/**
 * GET /admin/maintenance/status
 * Returns current maintenance status.
 */
async function handleMaintenanceStatus(req, res) {
  const status = getMaintenanceStatus();
  return res.json({
    success: true,
    ...status,
  });
}

/**
 * POST /admin/maintenance/reschedule
 * Body: { minutes: number }
 * Reschedules an existing maintenance.
 */
async function handleMaintenanceReschedule(req, res) {
  const accountId = parseInt(req.tokenPayload.sub, 10);
  const { minutes } = req.body;

  const validatedMinutes = validateMinutes(minutes);
  if (validatedMinutes === null) {
    auditAdminAction(accountId, 'maintenance_reschedule_invalid', { minutes });
    return res.status(400).json({ error: 'minutes must be an integer between 1 and 525600' });
  }

  const result = rescheduleMaintenance(validatedMinutes);

  if (!result.success) {
    auditAdminAction(accountId, 'maintenance_reschedule_rejected', {
      minutes: validatedMinutes,
      reason: result.error,
    });
    return res.status(409).json({ error: result.error });
  }

  auditAdminAction(accountId, 'maintenance_reschedule', {
    minutes: validatedMinutes,
    startsAt: result.startsAt,
  });

  logger.info('ADMIN', 'Maintenance rescheduled by admin', {
    adminAccountId: accountId,
    minutes: validatedMinutes,
    startsAt: result.startsAt,
  });

  return res.json({
    success: true,
    startsAt: result.startsAt,
    startsInMinutes: result.startsInMinutes,
    message: result.message,
  });
}

/**
 * POST /admin/broadcast
 * Body: { message: string, notificationType?: string|number }
 * Broadcasts a message to all connected players.
 *
 * For /broadcast, we use MessageReceived (type 2) with the Coach system pattern:
 *   - FromPlayerId: 1 (Coach/system account)
 *   - Type: 100 (system message / COACH_MESSAGE_TYPE)
 *   - Data: the message text (string on the wire)
 *   - SentTime: ISO timestamp
 *
 * This is verified against RecFlare source (notify.app.ts coachMessageAll):
 *   - Uses NotificationType.MessageReceived (2)
 *   - COACH_PLAYER_ID = 1
 *   - COACH_MESSAGE_TYPE = 100
 *   - Data carries the message content as a string
 *
 * Client compatibility: MessageReceived is a live notification channel in the
 * Rec Room client. The Data field is a string on the wire, which the client
 * renders as message content. This is the same mechanism used for coach/system
 * messages.
 *
 * Note: Client-side Coach voice/audio is NOT reproduced - that is a separate
 * client-side system not controlled by the notification payload.
 */
async function handleBroadcast(req, res) {
  const accountId = parseInt(req.tokenPayload.sub, 10);
  const { message, notificationType } = req.body;

  const validatedMessage = validateBroadcastMessage(message);
  if (validatedMessage === null) {
    auditAdminAction(accountId, 'broadcast_invalid', { message: typeof message });
    return res.status(400).json({ error: 'message is required and must be a non-empty string (max 1000 chars)' });
  }

  // Default to MessageReceived (type 2) with Coach system pattern
  const type = notificationType !== undefined ? notificationType : 2;
  const data = {
    FromPlayerId: 1, // Coach/system account
    Type: 100, // System message type (COACH_MESSAGE_TYPE equivalent)
    Data: validatedMessage,
    SentTime: new Date().toISOString(),
  };

  const result = broadcastNotification(type, data);

  auditAdminAction(accountId, 'broadcast', {
    message: validatedMessage,
    notificationType: String(type),
    delivered: result.delivered,
  });

  logger.info('ADMIN', 'Broadcast sent by admin', {
    adminAccountId: accountId,
    message: validatedMessage,
    notificationType: String(type),
    delivered: result.delivered,
    totalLiveConnections: result.delivered > 0 ? 'unknown' : 0,
  });

  return res.json({
    success: true,
    delivered: result.delivered,
    message: `Broadcast sent to ${result.delivered} connection(s).`,
  });
}

// ============================================================================
// Router setup
// ============================================================================

const router = express.Router();

// Apply JSON body parsing (Express handles this at app level, but ensure it's available)
router.use(express.json({ limit: '10mb' }));

// All admin routes require developer role
router.use(requireDeveloper);

// Maintenance routes
router.post('/maintenance/start', handleMaintenanceStart);
router.post('/maintenance/cancel', handleMaintenanceCancel);
router.get('/maintenance/status', handleMaintenanceStatus);
router.post('/maintenance/reschedule', handleMaintenanceReschedule);

// Broadcast route
router.post('/broadcast', handleBroadcast);

// ============================================================================
// Module exports
// ============================================================================

module.exports = {
  router,
  requireDeveloper,
  isDeveloper,
  handleMaintenanceStart,
  handleMaintenanceCancel,
  handleMaintenanceStatus,
  handleMaintenanceReschedule,
  handleBroadcast,
  auditAdminAction,
  validateMinutes,
  validateBroadcastMessage,
};
