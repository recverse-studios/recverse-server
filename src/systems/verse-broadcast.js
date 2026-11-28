/**
 * RecVerse Broadcast System
 * WebSocket/SignalR-compatible notification delivery
 */

import logger from '../../verse-logger.js';

// In-memory connection tracking (in production, use Redis or similar)
const playerConnections = new Map(); // playerId -> Set<WebSocket>
const handshakenSockets = new Set();

// Delivery stats
const deliveryStats = {
  totalSent: 0,
  totalDelivered: 0,
  totalFailed: 0,
  totalQueued: 0,
  byType: new Map(),
};

const RS = '\u001e'; // SignalR record separator

// SignalR message types
const MSG_TYPE_INVOCATION = 1;
const MSG_TYPE_COMPLETION = 3;
const MSG_TYPE_PING = 6;
const MSG_TYPE_CLOSE = 7;

const HUB_TARGET_NOTIFICATION = 'Notification';
const HUB_TARGET_ON_CONNECT = 'OnConnect';

/**
 * Build a SignalR invocation frame
 */
function buildInvocation(target, args) {
  return JSON.stringify({ type: MSG_TYPE_INVOCATION, target, arguments: args }) + RS;
}

/**
 * Build a SignalR completion frame
 */
function buildCompletion(invocationId, result) {
  return JSON.stringify({ type: MSG_TYPE_COMPLETION, invocationId, result }) + RS;
}

/**
 * Build the serialized notification payload: { Id: "<type>", Msg: {...data} }
 */
function buildNotificationPayload(notificationType, data) {
  const msg = {};
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;
      msg[key] = value;
    }
  }
  return JSON.stringify({ Id: String(notificationType), Msg: msg });
}

/**
 * Send a framed message over a WebSocket
 */
function sendFramed(ws, framedMessage) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(framedMessage);
    return true;
  } catch (err) {
    logger.warn('BROADCAST', 'WebSocket send failed', { error: err.message });
    return false;
  }
}

/**
 * Register a WebSocket connection for a player
 */
export function registerConnection(ws, playerId, connectionId) {
  if (!playerConnections.has(playerId)) {
    playerConnections.set(playerId, new Set());
  }
  playerConnections.get(playerId).add(ws);
  
  logger.debug('BROADCAST', 'Connection registered', {
    playerId,
    connectionId,
    totalConnectionsForPlayer: playerConnections.get(playerId).size,
  });
}

/**
 * Unregister a WebSocket connection
 */
export function unregisterConnection(ws) {
  const playerId = socketPlayerId.get(ws);
  if (playerId !== undefined) {
    const connections = playerConnections.get(playerId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        playerConnections.delete(playerId);
      }
    }
    socketPlayerId.delete(ws);
  }
  handshakenSockets.delete(ws);
}

/**
 * Get the number of live connections for a player
 */
export function getConnectionCountForPlayer(playerId) {
  const connections = playerConnections.get(playerId);
  return connections ? connections.size : 0;
}

/**
 * Get the total number of live (handshaken) connections across all players
 */
export function getTotalLiveConnections() {
  return handshakenSockets.size;
}

/**
 * Deliver a framed notification to all live sockets of a player
 */
function deliverToPlayer(playerId, payload) {
  const connections = playerConnections.get(playerId);
  if (!connections || connections.size === 0) return 0;

  const framed = buildInvocation(HUB_TARGET_NOTIFICATION, [payload]);
  let delivered = 0;
  const dead = [];

  for (const ws of connections) {
    if (ws.readyState !== ws.OPEN) {
      dead.push(ws);
      continue;
    }
    if (sendFramed(ws, framed)) {
      delivered++;
    } else {
      dead.push(ws);
    }
  }

  // Clean up dead connections
  for (const ws of dead) {
    unregisterConnection(ws);
  }

  return delivered;
}

/**
 * Broadcast a notification to every connected (handshaken) client
 */
export function broadcastToConnected(payload) {
  let delivered = 0;
  const dead = [];

  for (const ws of handshakenSockets) {
    if (ws.readyState !== ws.OPEN) {
      dead.push(ws);
      continue;
    }
    if (sendFramed(ws, buildInvocation(HUB_TARGET_NOTIFICATION, [payload]))) {
      delivered++;
    } else {
      dead.push(ws);
    }
  }

  for (const ws of dead) {
    unregisterConnection(ws);
  }

  return delivered;
}

/**
 * Public API: Broadcast a notification to all connected clients
 */
export function broadcastNotification(notificationType, data) {
  if (notificationType === undefined || notificationType === null) {
    throw new Error('notificationType is required');
  }
  const payload = buildNotificationPayload(notificationType, data);
  const delivered = broadcastToConnected(payload);

  // Track stats
  deliveryStats.totalSent++;
  deliveryStats.totalDelivered += delivered;
  deliveryStats.totalFailed += (deliveryStats.totalSent - deliveryStats.totalDelivered);
  const typeKey = String(notificationType);
  const current = deliveryStats.byType.get(typeKey) || { sent: 0, delivered: 0 };
  current.sent++;
  current.delivered += delivered;
  deliveryStats.byType.set(typeKey, current);

  logger.info('BROADCAST', 'Notification broadcast', {
    notificationType: String(notificationType),
    delivered,
    totalLiveConnections: getTotalLiveConnections(),
  });

  return { delivered };
}

/**
 * Public API: Send a notification to a specific player
 */
export function notifyPlayer(playerId, notificationType, data) {
  if (!playerId || typeof playerId !== 'number') {
    throw new Error('playerId is required and must be a number');
  }
  if (notificationType === undefined || notificationType === null) {
    throw new Error('notificationType is required');
  }
  const payload = buildNotificationPayload(notificationType, data);
  const delivered = deliverToPlayer(playerId, payload);
  const queued = delivered === 0;

  if (queued) {
    deliveryStats.totalQueued++;
    logger.warn('BROADCAST', 'Notification queued (player offline)', {
      playerId,
      notificationType: String(notificationType),
    });
  }

  logger.debug('BROADCAST', 'Notification sent to player', {
    playerId,
    notificationType: String(notificationType),
    delivered,
    queued,
  });

  return { delivered, queued };
}

/**
 * Broadcast a server maintenance notification (type 25)
 */
export function broadcastMaintenance(startsInMinutes) {
  if (typeof startsInMinutes !== 'number' || startsInMinutes < 0) {
    throw new Error('startsInMinutes must be a non-negative number');
  }
  return broadcastNotification(25, { StartsInMinutes: startsInMinutes });
}

/**
 * Send a maintenance notification to a specific player
 */
export function notifyPlayerMaintenance(playerId, startsInMinutes) {
  if (typeof startsInMinutes !== 'number' || startsInMinutes < 0) {
    throw new Error('startsInMinutes must be a non-negative number');
  }
  return notifyPlayer(playerId, 25, { StartsInMinutes: startsInMinutes });
}

/**
 * Get delivery statistics
 */
export function getDeliveryStats() {
  return {
    totalSent: deliveryStats.totalSent,
    totalDelivered: deliveryStats.totalDelivered,
    totalFailed: deliveryStats.totalFailed,
    totalQueued: deliveryStats.totalQueued,
    byType: Object.fromEntries(deliveryStats.byType),
  };
}

/**
 * Inspect the hub's routing state (for debugging delivery)
 */
export function inspectHub() {
  const connections = [];
  for (const [playerId, sockets] of playerConnections.entries()) {
    let live = 0;
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN && handshakenSockets.has(ws)) live++;
    }
    connections.push({
      playerId,
      totalConnections: sockets.size,
      liveConnections: live,
      handshaken: live,
    });
  }
  return {
    connections,
    totalPlayers: playerConnections.size,
    totalConnections: connections.reduce((sum, c) => sum + c.totalConnections, 0),
    liveConnections: connections.reduce((sum, c) => sum + c.liveConnections, 0),
  };
}

/**
 * Close all WebSocket connections and clear the registry
 */
export function shutdown() {
  logger.info('BROADCAST', 'Shutting down broadcast system', {
    totalPlayers: playerConnections.size,
    totalConnections: getTotalLiveConnections(),
  });

  for (const ws of handshakenSockets) {
    try { ws.close(1001, 'Server shutting down'); } catch (_) { /* ignore */ }
  }

  playerConnections.clear();
  socketPlayerId.clear();
  handshakenSockets.clear();

  // Reset stats
  deliveryStats.totalSent = 0;
  deliveryStats.totalDelivered = 0;
  deliveryStats.totalFailed = 0;
  deliveryStats.totalQueued = 0;
  deliveryStats.byType.clear();
}

// Internal storage
const socketPlayerId = new WeakMap();
const handshakenSockets = new Set();

const HUB_TARGET_NOTIFICATION = 'Notification';
const HUB_TARGET_ON_CONNECT = 'OnConnect';

function buildNotificationPayload(notificationType, data) {
  const msg = {};
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;
      msg[key] = value;
    }
  }
  return JSON.stringify({ Id: String(notificationType), Msg: msg });
}

function buildInvocation(target, args) {
  return JSON.stringify({ type: 1, target, arguments: args }) + '\u001e';
}

function sendFramed(ws, framedMessage) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(framedMessage);
    return true;
  } catch (err) {
    logger.warn('BROADCAST', 'WebSocket send failed', { error: err.message });
    return false;
  }
}

export function initializeWebSocketServer(server, options = {}) {
  const path = options.path || '/hub/v1';
  
  // This is a placeholder - actual WebSocket handling would use ws library
  // For now, we just log that the WebSocket server would be initialized
  logger.startup(`WebSocket/SignalR server initialized at ${path}`);
  
  return {
    on: () => {},
    close: () => {},
  };
}

export const NOTIFICATION_TYPE_SERVER_MAINTENANCE = 25;

export {
  broadcastNotification,
  notifyPlayer,
  broadcastMaintenance,
  notifyPlayerMaintenance,
  initializeWebSocketServer,
  registerConnection,
  unregisterConnection,
  getConnectionCountForPlayer,
  getTotalLiveConnections,
  getDeliveryStats,
  inspectHub,
  shutdown,
  NOTIFICATION_TYPE_SERVER_MAINTENANCE,
};