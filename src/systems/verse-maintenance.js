/**
 * RecVerse Server - Maintenance Controller
 * src/systems/verse-maintenance.js
 *
 * Server maintenance scheduling and countdown notification system.
 * Inspired by RecFlare's "Rec Room is Going Down" event implementation.
 *
 * Protocol details (validated against RecFlare):
 *   - Notification type: ServerMaintenance = 25
 *   - Payload: { StartsInMinutes: number }
 *   - Serialized: { "Id":"25", "Msg":{ "StartsInMinutes":1 } }
 *
 * Warning intervals (configurable):
 *   - 5 minutes before maintenance
 *   - 3 minutes before maintenance
 *   - 1 minute before maintenance
 *
 * Maintenance state is persisted in SQLite so it survives server restarts.
 * Timers are cleaned up on server shutdown.
 *
 * Shutdown is a SEPARATE operation from notification broadcasting.
 * Notification type 25 does NOT automatically shut down the client or server.
 */

const { getDb, dbRun, dbGet, dbAll, closeDb } = require('../../verse-db');
const logger = require('../../verse-logger');
const { broadcastMaintenance, notifyPlayerMaintenance, getTotalLiveConnections } = require('./verse-broadcast');

// ============================================================================
// Maintenance state
// ============================================================================

/** In-memory maintenance state. */
let maintenanceState = {
  isActive: false,
  scheduledAt: null,      // ISO timestamp when maintenance was scheduled
  startsAt: null,         // ISO timestamp when maintenance starts
  startsInMinutes: null,  // Minutes from now (at schedule time)
  warningIntervals: [5, 3, 1], // Minutes before start to send warnings
  timers: [],             // Set of active Node.js timers
  lastWarningSent: null,  // ISO timestamp of last warning sent
  cancelled: false,
};

/** Warning intervals already fired (to prevent duplicates). */
const firedWarnings = new Set();

// ============================================================================
// Database persistence helpers
// ============================================================================

/**
 * Ensure the maintenance state table exists.
 */
async function ensureMaintenanceTable() {
  const db = getDb();
  await new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS server_maintenance (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_active INTEGER NOT NULL DEFAULT 0,
        scheduled_at TEXT,
        starts_at TEXT,
        starts_in_minutes INTEGER,
        warning_intervals TEXT,
        last_warning_sent TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `), (err) => {
      if (err) reject(err);
      else resolve();
    };
  });
}

/**
 * Save maintenance state to SQLite.
 */
async function persistMaintenanceState() {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO server_maintenance (
          id, is_active, scheduled_at, starts_at, starts_in_minutes,
          warning_intervals, last_warning_sent, cancelled, updated_at
        ) VALUES (
          1, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          is_active = excluded.is_active,
          scheduled_at = excluded.scheduled_at,
          starts_at = excluded.starts_at,
          starts_in_minutes = excluded.starts_in_minutes,
          warning_intervals = excluded.warning_intervals,
          last_warning_sent = excluded.last_warning_sent,
          cancelled = excluded.cancelled,
          updated_at = excluded.updated_at;
      `, [
        maintenanceState.isActive ? 1 : 0,
        maintenanceState.scheduledAt || null,
        maintenanceState.startsAt || null,
        maintenanceState.startsInMinutes || null,
        JSON.stringify(maintenanceState.warningIntervals),
        maintenanceState.lastWarningSent || null,
        maintenanceState.cancelled ? 1 : 0,
        now,
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.debug('MAINTENANCE', 'State persisted to database');
  } catch (err) {
    logger.error('MAINTENANCE', 'Failed to persist state', { error: err.message });
  }
}

/**
 * Load maintenance state from SQLite (called on server startup).
 */
async function loadMaintenanceState() {
  try {
    await ensureMaintenanceTable();
    const row = await dbGet('SELECT * FROM server_maintenance WHERE id = 1');
    if (!row) return;

    maintenanceState.isActive = row.is_active === 1;
    maintenanceState.scheduledAt = row.scheduled_at || null;
    maintenanceState.startsAt = row.starts_at || null;
    maintenanceState.startsInMinutes = row.starts_in_minutes || null;
    maintenanceState.warningIntervals = row.warning_intervals
      ? JSON.parse(row.warning_intervals)
      : [5, 3, 1];
    maintenanceState.lastWarningSent = row.last_warning_sent || null;
    maintenanceState.cancelled = row.cancelled === 1;
    maintenanceState.timers = [];

    logger.info('MAINTENANCE', 'State loaded from database', {
      isActive: maintenanceState.isActive,
      startsAt: maintenanceState.startsAt,
      cancelled: maintenanceState.cancelled,
    });

    // If maintenance was active before restart, recalculate timers
    if (maintenanceState.isActive && maintenanceState.startsAt && !maintenanceState.cancelled) {
      const startsAt = new Date(maintenanceState.startsAt).getTime();
      const now = Date.now();
      if (startsAt > now) {
        // Maintenance still pending - restart the countdown
        const remainingMinutes = Math.ceil((startsAt - now) / (1000 * 60));
        maintenanceState.startsInMinutes = remainingMinutes;
        scheduleCountdown(remainingMinutes);
      } else {
        // Maintenance time has passed - mark as completed
        maintenanceState.isActive = false;
        maintenanceState.cancelled = true;
        await persistMaintenanceState();
        logger.info('MAINTENANCE', 'Scheduled maintenance time has passed, marking complete');
      }
    }
  } catch (err) {
    logger.error('MAINTENANCE', 'Failed to load state from database', { error: err.message });
  }
}

// ============================================================================
// Countdown timer management
// ============================================================================

/**
 * Clear all active maintenance timers.
 */
function clearMaintenanceTimers() {
  for (const timer of maintenanceState.timers) {
    clearTimeout(timer);
  }
  maintenanceState.timers = [];
  firedWarnings.clear();
}

/**
 * Schedule the countdown warning notifications.
 * Calculates when to send 5min, 3min, and 1min warnings based on the
 * maintenance start time.
 * @param {number} startsInMinutes - Minutes until maintenance starts
 */
function scheduleCountdown(startsInMinutes) {
  clearMaintenanceTimers();
  const now = Date.now();
  const startsAtMs = now + (startsInMinutes * 60 * 1000);

  const warningIntervals = [...maintenanceState.warningIntervals].sort((a, b) => b - a); // descending

  for (const interval of warningIntervals) {
    const warningTimeMs = startsAtMs - (interval * 60 * 1000);
    const delayMs = warningTimeMs - now;

    if (delayMs <= 0) {
      // Warning time already passed - send immediately
      sendMaintenanceWarning(interval);
      continue;
    }

    const timer = setTimeout(() => {
      sendMaintenanceWarning(interval);
    }, delayMs);

    maintenanceState.timers.push(timer);

    logger.debug('MAINTENANCE', 'Countdown warning scheduled', {
      warningInterval: interval,
      startsInMinutes,
      delayMs,
      firesAt: new Date(warningTimeMs).toISOString(),
    });
  }

  // Also schedule a final notification at maintenance start time
  const startDelayMs = startsAtMs - now;
  if (startDelayMs > 0) {
    const startTimer = setTimeout(() => {
      sendMaintenanceStartNotification();
    }, startDelayMs);
    maintenanceState.timers.push(startTimer);
  }

  logger.info('MAINTENANCE', 'Countdown scheduled', {
    startsInMinutes,
    warningIntervals,
    totalTimers: maintenanceState.timers.length,
  });
}

/**
 * Send a maintenance warning notification at a specific interval.
 * @param {number} minutesBefore - Minutes before maintenance starts
 */
function sendMaintenanceWarning(minutesBefore) {
  if (firedWarnings.has(minutesBefore)) {
    logger.debug('MAINTENANCE', 'Warning already fired, skipping', { minutesBefore });
    return;
  }
  firedWarnings.add(minutesBefore);

  const startsIn = minutesBefore; // At warning time, maintenance starts in this many minutes
  const result = broadcastMaintenance(startsIn);

  maintenanceState.lastWarningSent = new Date().toISOString();

  logger.info('MAINTENANCE', 'Warning notification sent', {
    minutesBefore,
    startsInMinutes: startsIn,
    delivered: result.delivered,
    totalLiveConnections: getTotalLiveConnections(),
  });

  // Persist state after sending warning
  persistMaintenanceState().catch((err) => {
    logger.error('MAINTENANCE', 'Failed to persist state after warning', { error: err.message });
  });
}

/**
 * Send the final maintenance start notification (StartsInMinutes: 0).
 */
function sendMaintenanceStartNotification() {
  const result = broadcastMaintenance(0);

  logger.info('MAINTENANCE', 'Maintenance start notification sent', {
    startsInMinutes: 0,
    delivered: result.delivered,
    totalLiveConnections: getTotalLiveConnections(),
  });

  // Mark maintenance as started (not cancelled, but the time has arrived)
  maintenanceState.lastWarningSent = new Date().toISOString();
  persistMaintenanceState().catch((err) => {
    logger.error('MAINTENANCE', 'Failed to persist state after start notification', { error: err.message });
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start a scheduled maintenance.
 * Sends countdown warnings at configured intervals (5, 3, 1 minutes).
 * Prevents duplicate countdowns if maintenance is already scheduled.
 * @param {number} minutes - Minutes until maintenance starts
 * @param {Object} options - Additional options
 * @returns {{ success: boolean, scheduledAt: string, startsAt: string, startsInMinutes: number, message: string }}
 */
function startMaintenance(minutes, options = {}) {
  if (typeof minutes !== 'number' || minutes < 1) {
    return {
      success: false,
      error: 'minutes must be a positive integer',
    };
  }

  if (maintenanceState.isActive && !maintenanceState.cancelled) {
    return {
      success: false,
      error: 'Maintenance is already scheduled',
      scheduledAt: maintenanceState.scheduledAt,
      startsAt: maintenanceState.startsAt,
      startsInMinutes: maintenanceState.startsInMinutes,
    };
  }

  const now = new Date();
  const scheduledAt = now.toISOString();
  const startsAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();

  // Reset state
  maintenanceState = {
    isActive: true,
    scheduledAt,
    startsAt,
    startsInMinutes: minutes,
    warningIntervals: options.warningIntervals || [5, 3, 1],
    timers: [],
    lastWarningSent: null,
    cancelled: false,
  };
  firedWarnings.clear();

  // Schedule the countdown
  scheduleCountdown(minutes);

  // Persist to database
  persistMaintenanceState().catch((err) => {
    logger.error('MAINTENANCE', 'Failed to persist maintenance state', { error: err.message });
  });

  logger.info('MAINTENANCE', 'Maintenance scheduled', {
    startsInMinutes: minutes,
    scheduledAt,
    startsAt,
    warningIntervals: maintenanceState.warningIntervals,
  });

  return {
    success: true,
    scheduledAt,
    startsAt,
    startsInMinutes: minutes,
    message: `Server maintenance scheduled in ${minutes} minute(s). Warnings will be sent at ${maintenanceState.warningIntervals.join(', ')} minutes before.`,
  };
}

/**
 * Cancel a scheduled maintenance.
 * Clears all timers and prevents further notifications.
 * @returns {{ success: boolean, cancelled: boolean, message: string }}
 */
function cancelMaintenance() {
  if (!maintenanceState.isActive || maintenanceState.cancelled) {
    return {
      success: false,
      error: 'No active maintenance to cancel',
      isActive: maintenanceState.isActive,
      cancelled: maintenanceState.cancelled,
    };
  }

  clearMaintenanceTimers();

  maintenanceState.isActive = false;
  maintenanceState.cancelled = true;
  maintenanceState.lastWarningSent = new Date().toISOString();

  persistMaintenanceState().catch((err) => {
    logger.error('MAINTENANCE', 'Failed to persist cancellation', { error: err.message });
  });

  logger.info('MAINTENANCE', 'Maintenance cancelled', {
    scheduledAt: maintenanceState.scheduledAt,
    startsAt: maintenanceState.startsAt,
  });

  return {
    success: true,
    cancelled: true,
    message: 'Server maintenance cancelled.',
  };
}

/**
 * Reschedule an existing maintenance to a new time.
 * @param {number} minutes - New minutes until maintenance starts
 * @returns {{ success: boolean, startsAt: string, startsInMinutes: number, message: string } | { success: false, error: string }}
 */
function rescheduleMaintenance(minutes) {
  if (typeof minutes !== 'number' || minutes < 1) {
    return {
      success: false,
      error: 'minutes must be a positive integer',
    };
  }

  if (!maintenanceState.isActive || maintenanceState.cancelled) {
    return {
      success: false,
      error: 'No active maintenance to reschedule',
    };
  }

  const now = new Date();
  const startsAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();

  maintenanceState.startsAt = startsAt;
  maintenanceState.startsInMinutes = minutes;
  maintenanceState.lastWarningSent = null;
  firedWarnings.clear();

  // Reschedule countdown
  scheduleCountdown(minutes);

  persistMaintenanceState().catch((err) => {
    logger.error('MAINTENANCE', 'Failed to persist reschedule', { error: err.message });
  });

  logger.info('MAINTENANCE', 'Maintenance rescheduled', {
    startsInMinutes: minutes,
    startsAt,
  });

  return {
    success: true,
    startsAt,
    startsInMinutes: minutes,
    message: `Server maintenance rescheduled to ${minutes} minute(s) from now.`,
  };
}

/**
 * Get the current maintenance status.
 * @returns {{ isActive: boolean, scheduledAt: string|null, startsAt: string|null, startsInMinutes: number|null, cancelled: boolean, warningIntervals: number[], lastWarningSent: string|null, liveConnections: number }}
 */
function getMaintenanceStatus() {
  let remainingMinutes = null;
  if (maintenanceState.isActive && maintenanceState.startsAt && !maintenanceState.cancelled) {
    const startsAtMs = new Date(maintenanceState.startsAt).getTime();
    const nowMs = Date.now();
    if (startsAtMs > nowMs) {
      remainingMinutes = Math.ceil((startsAtMs - nowMs) / (1000 * 60));
    }
  }

  return {
    isActive: maintenanceState.isActive,
    scheduledAt: maintenanceState.scheduledAt,
    startsAt: maintenanceState.startsAt,
    startsInMinutes: remainingMinutes !== null ? remainingMinutes : maintenanceState.startsInMinutes,
    originalStartsInMinutes: maintenanceState.startsInMinutes,
    cancelled: maintenanceState.cancelled,
    warningIntervals: maintenanceState.warningIntervals,
    lastWarningSent: maintenanceState.lastWarningSent,
    liveConnections: getTotalLiveConnections(),
    timersPending: maintenanceState.timers.length,
  };
}

/**
 * Check if maintenance is currently active (not cancelled, start time not passed).
 * @returns {boolean}
 */
function isMaintenanceActive() {
  if (!maintenanceState.isActive || maintenanceState.cancelled) return false;
  if (maintenanceState.startsAt) {
    const startsAtMs = new Date(maintenanceState.startsAt).getTime();
    if (Date.now() >= startsAtMs) return false;
  }
  return true;
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the maintenance system (call on server startup).
 * Loads persisted state from database and restarts any pending countdown.
 */
async function initialize() {
  await loadMaintenanceState();
  logger.info('MAINTENANCE', 'Maintenance system initialized', {
    isActive: maintenanceState.isActive,
    cancelled: maintenanceState.cancelled,
  });
}

/**
 * Shutdown the maintenance system (call on server shutdown).
 * Clears all timers and persists final state.
 */
function shutdown() {
  logger.info('MAINTENANCE', 'Shutting down maintenance system', {
    isActive: maintenanceState.isActive,
    activeTimers: maintenanceState.timers.length,
  });

  clearMaintenanceTimers();
  persistMaintenanceState().catch((err) => {
    logger.error('MAINTENANCE', 'Failed to persist state on shutdown', { error: err.message });
  });
}

module.exports = {
  // Notification type
  NOTIFICATION_TYPE_SERVER_MAINTENANCE: 25,

  // Public API
  startMaintenance,
  cancelMaintenance,
  rescheduleMaintenance,
  getMaintenanceStatus,
  isMaintenanceActive,

  // Lifecycle
  initialize,
  shutdown,

  // Internal (exported for testing)
  sendMaintenanceWarning,
  sendMaintenanceStartNotification,
  scheduleCountdown,
  clearMaintenanceTimers,
  persistMaintenanceState,
  loadMaintenanceState,
};
