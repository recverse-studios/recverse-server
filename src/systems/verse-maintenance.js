/**
 * RecVerse Maintenance System
 * Server maintenance scheduling and countdown notifications
 */

import { dbGet, dbRun, isDbInitialized } from '../../verse-db.js';
import logger from '../../verse-logger.js';
import { broadcastMaintenance } from './verse-broadcast.js';

// In-memory maintenance state
let maintenanceState = {
  isActive: false,
  scheduledAt: null,
  startsAt: null,
  startsInMinutes: null,
  warningIntervals: [5, 3, 1], // minutes before maintenance
  timers: [], // active timers
  lastWarningSent: null,
  cancelled: false,
};

/**
 * Initialize maintenance system - load persisted state from database
 */
export async function initialize() {
  if (!isDbInitialized()) {
    logger.warn('MAINTENANCE', 'Database not initialized, skipping maintenance state load');
    return;
  }

  try {
    const state = await dbGet('SELECT * FROM server_maintenance WHERE id = 1');
    if (state) {
      maintenanceState = {
        isActive: !!state.is_active,
        scheduledAt: state.scheduled_at,
        startsAt: state.starts_at,
        startsInMinutes: state.starts_in_minutes,
        warningIntervals: state.warning_intervals ? JSON.parse(state.warning_intervals) : [5, 3, 1],
        timers: [],
        lastWarningSent: state.last_warning_sent,
        cancelled: !!state.cancelled,
      };

      // If maintenance was active and hasn't been cancelled, restart the countdown
      if (maintenanceState.isActive && maintenanceState.startsAt && !maintenanceState.cancelled) {
        const startsAtMs = new Date(maintenanceState.startsAt).getTime();
        const nowMs = Date.now();
        if (startsAtMs > Date.now()) {
          const remainingMinutes = Math.ceil((startsAtMs - Date.now()) / (1000 * 60));
          maintenanceState.startsInMinutes = remainingMinutes;
          scheduleCountdown(remainingMinutes);
        } else {
          // Maintenance time has passed
          maintenanceState.isActive = false;
          maintenanceState.cancelled = true;
          await persistState();
        }
      }
    }
    logger.info('MAINTENANCE', 'Maintenance system initialized', { 
      isActive: maintenanceState.isActive,
      startsInMinutes: maintenanceState.startsInMinutes 
    });
  } catch (err) {
    logger.error('MAINTENANCE', 'Failed to load maintenance state', { error: err.message });
  }
}

/**
 * Persist maintenance state to database
 */
async function persistState() {
  if (!isDbInitialized()) return;
  
  await dbRun(`
    INSERT INTO server_maintenance (
      id, is_active, scheduled_at, starts_at, starts_in_minutes,
      warning_intervals, last_warning_sent, cancelled, updated_at
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      is_active = excluded.is_active,
      scheduled_at = excluded.scheduled_at,
      starts_at = excluded.starts_at,
      starts_in_minutes = excluded.starts_in_minutes,
      warning_intervals = excluded.warning_intervals,
      last_warning_sent = excluded.last_warning_sent,
      cancelled = excluded.cancelled,
      updated_at = excluded.updated_at
  `, [
    maintenanceState.isActive ? 1 : 0,
    maintenanceState.scheduledAt,
    maintenanceState.startsAt,
    maintenanceState.startsInMinutes,
    JSON.stringify(maintenanceState.warningIntervals),
    maintenanceState.lastWarningSent,
    maintenanceState.cancelled ? 1 : 0,
  ]);
}

/**
 * Schedule the maintenance countdown with warning notifications
 */
function scheduleCountdown(startsInMinutes) {
  // Clear existing timers
  clearMaintenanceTimers();

  const warningIntervals = [...maintenanceState.warningIntervals].sort((a, b) => b - a); // descending
  const now = Date.now();
  const startsAtMs = now + (startsInMinutes * 60 * 1000);

  for (const interval of warningIntervals) {
    const warningAtMs = startsAtMs - (interval * 60 * 1000);
    const delay = warningAtMs - Date.now();

    if (delay > 0) {
      const timer = setTimeout(() => {
        sendMaintenanceWarning(interval);
      }, delay);
      maintenanceState.timers.push(timer);
    } else if (delay <= 0 && delay > -60000) {
      // Warning time has just passed, send immediately
      sendMaintenanceWarning(interval);
    }
  }

  // Schedule the actual maintenance start
  const startTimer = setTimeout(() => {
    sendMaintenanceStartNotification();
  }, startsInMinutes * 60 * 1000);
  maintenanceState.timers.push(startTimer);

  logger.info('MAINTENANCE', 'Maintenance countdown scheduled', {
    startsInMinutes,
    startsAt: new Date(startsAtMs).toISOString(),
    warningIntervals: maintenanceState.warningIntervals,
  });
}

/**
 * Clear all maintenance timers
 */
function clearMaintenanceTimers() {
  for (const timer of maintenanceState.timers) {
    clearTimeout(timer);
  }
  maintenanceState.timers = [];
}

/**
 * Send a maintenance warning notification
 */
function sendMaintenanceWarning(minutesBefore) {
  if (maintenanceState.cancelled) return;
  if (maintenanceState.lastWarningSent === minutesBefore) return; // Prevent duplicate

  const result = broadcastMaintenance(minutesBefore);
  
  maintenanceState.lastWarningSent = minutesBefore;
  // Persist the last warning sent time
  if (isDbInitialized()) {
    dbRun('UPDATE server_maintenance SET last_warning_sent = ?, updated_at = datetime("now") WHERE id = 1', [minutesBefore]);
  }

  logger.info('MAINTENANCE', 'Maintenance warning sent', {
    minutesBefore,
    delivered: result.delivered,
  });
}

/**
 * Send the final maintenance start notification
 */
function sendMaintenanceStartNotification() {
  if (maintenanceState.cancelled) return;

  const result = broadcastMaintenance(0);
  
  maintenanceState.isActive = true;
  maintenanceState.startsInMinutes = 0;
  
  if (isDbInitialized()) {
    dbRun('UPDATE server_maintenance SET is_active = 1, starts_in_minutes = 0, updated_at = datetime("now") WHERE id = 1');
  }

  logger.info('MAINTENANCE', 'Maintenance started', {
    delivered: result.delivered,
  });
}

/**
 * Start a scheduled maintenance
 */
export function startMaintenance(minutes, options = {}) {
  if (typeof minutes !== 'number' || minutes < 1) {
    return { success: false, error: 'minutes must be a positive integer' };
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
  const warningIntervals = options.warningIntervals || [5, 3, 1];

  maintenanceState = {
    isActive: true,
    scheduledAt,
    startsAt,
    startsInMinutes: minutes,
    warningIntervals,
    timers: [],
    lastWarningSent: null,
    cancelled: false,
  };

  scheduleCountdown(minutes);
  persistState();

  logger.info('MAINTENANCE', 'Maintenance scheduled', {
    startsInMinutes: minutes,
    startsAt,
    warningIntervals,
  });

  return {
    success: true,
    scheduledAt,
    startsAt,
    startsInMinutes: minutes,
    message: `Server maintenance scheduled in ${minutes} minute(s). Warnings will be sent at ${warningIntervals.join(', ')} minutes before.`,
  };
}

/**
 * Cancel scheduled maintenance
 */
export function cancelMaintenance() {
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
  maintenanceState.lastWarningSent = null;

  persistState();

  logger.info('MAINTENANCE', 'Maintenance cancelled');
  return {
    success: true,
    cancelled: true,
    message: 'Server maintenance cancelled.',
  };
}

/**
 * Reschedule an existing maintenance to a new time
 */
export function rescheduleMaintenance(minutes) {
  if (typeof minutes !== 'number' || minutes < 1) {
    return { success: false, error: 'minutes must be a positive integer' };
  }

  if (!maintenanceState.isActive || maintenanceState.cancelled) {
    return { success: false, error: 'No active maintenance to reschedule' };
  }

  const now = new Date();
  const startsAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();

  clearMaintenanceTimers();
  maintenanceState.startsAt = startsAt;
  maintenanceState.startsInMinutes = minutes;
  maintenanceState.lastWarningSent = null;

  scheduleCountdown(minutes);
  persistState();

  logger.info('MAINTENANCE', 'Maintenance rescheduled', { minutes, startsAt });
  return {
    success: true,
    startsAt,
    startsInMinutes: minutes,
    message: `Server maintenance rescheduled to ${minutes} minute(s) from now.`,
  };
}

/**
 * Get current maintenance status
 */
export function getMaintenanceStatus() {
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
    liveConnections: 0, // Would be populated by broadcast system
    timersPending: maintenanceState.timers.length,
  };
}

/**
 * Check if maintenance is currently active (not cancelled, start time passed)
 */
export function isMaintenanceActive() {
  if (!maintenanceState.isActive || maintenanceState.cancelled) return false;
  if (maintenanceState.startsAt) {
    const startsAtMs = new Date(maintenanceState.startsAt).getTime();
    return Date.now() >= startsAtMs;
  }
  return false;
}

// Internal helpers
function persistState() {
  // Persist to database asynchronously
  if (isDbInitialized()) {
    persistState().catch(err => {
      logger.error('MAINTENANCE', 'Failed to persist maintenance state', { error: err.message });
    });
  }
}

export {
  initialize,
  startMaintenance,
  cancelMaintenance,
  rescheduleMaintenance,
  getMaintenanceStatus,
  isMaintenanceActive,
  sendMaintenanceWarning,
  sendMaintenanceStartNotification,
  scheduleCountdown,
  clearMaintenanceTimers,
  persistState,
};