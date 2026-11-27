/**
 * RecVerse Server - Notification Broadcast System
 * src/systems/verse-broadcast.js
 *
 * Native notification delivery system inspired by RecFlare's NotificationsHub.
 * Implements the SignalR JSON Hub Protocol over WebSocket for real-time
 * notification delivery to Rec Room clients.
 *
 * Protocol details (validated against RecFlare source):
 *   - Record Separator: 0x1e (\x1e) terminating every protocol message
 *   - Handshake: client sends {"protocol":"json","version":1}\x1e, server replies {}\x1e
 *   - Notification frame: {"type":1,"target":"Notification","arguments":[serialized]}\x1e
 *   - Serialized notification: {"Id":"<type>","Msg":{...payload}}
 *   - Notification type Id is always emitted as a string
 *
 * RecFlare reference commit: inspected apps/notify/src/ notificaiton-types.ts,
 * notification-payloads.ts, notifications-hub.ts, notify.app.ts
 */

const { Server: WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../../verse-config');
const logger = require('../../verse-logger');
const { validateAndGetAccountId } = require('../../verse-auth-middleware');

// ============================================================================
// SignalR JSON Hub Protocol constants
// ============================================================================

/** SignalR record separator (0x1e) that terminates every protocol message. */
const RS = '\u001e';

/** SignalR message type: Invocation (client -> server) */
const MSG_TYPE_INVOCATION = 1;
/** SignalR message type: Completion (server -> client) */
const MSG_TYPE_COMPLETION = 3;
/** SignalR message type: Ping */
const MSG_TYPE_PING = 6;
/** SignalR message type: Close */
const MSG_TYPE_CLOSE = 7;

/** SignalR hub target for notifications */
const HUB_TARGET_NOTIFICATION = 'Notification';
/** SignalR hub target for OnConnect (sent after handshake) */
const HUB_TARGET_ON_CONNECT = 'OnConnect';

/** Notification type: ServerMaintenance (validated against RecFlare) */
const NOTIFICATION_TYPE_SERVER_MAINTENANCE = 25;

// ============================================================================
// Connection registry: playerId -> Set<WebSocket>
// ============================================================================

/** Map of playerId to their active WebSocket connections. */
const playerConnections = new Map();

/** Map of WebSocket to its associated playerId (for cleanup on close). */
const socketPlayerId = new WeakMap();

/** Set of WebSockets that have completed the SignalR handshake. */
const handshakenSockets = new Set();

// ============================================================================
// Delivery statistics
// ============================================================================

const deliveryStats = {
  totalSent: 0,
  totalDelivered: 0,
  totalFailed: 0,
  totalQueued: 0,
  byType: new Map(),
};

// ============================================================================
// SignalR protocol helpers
// ============================================================================

/**
 * Build a SignalR invocation frame.
 * @param {string} target - Hub method target (e.g. "Notification")
 * @param {unknown[]} args - Invocation arguments
 * @returns {string} Complete framed message with RS terminator
 */
function buildInvocation(target, args) {
  return JSON.stringify({ type: MSG_TYPE_INVOCATION, target, arguments: args }) + RS;
}

/**
 * Build a SignalR completion frame.
 * @param {string} invocationId - The invocation id to complete
 * @param {unknown} result - Completion result
 * @returns {string} Complete framed message with RS terminator
 */
function buildCompletion(invocationId, result) {
  return JSON.stringify({ type: MSG_TYPE_COMPLETION, invocationId, result }) + RS;
}

/**
 * Build the serialized notification payload: { Id: "<type>", Msg: {...data} }
 * Null/undefined values are dropped from Msg, matching RecFlare behavior.
 * Id is always a string (client dispatches on string Id).
 * @param {string|number} notificationType - The notification type Id
 * @param {Record<string, unknown>} data - The Msg payload
 * @returns {string} JSON string of { Id, Msg }
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
 * Send a raw framed message over a WebSocket.
 * @param {WebSocket} ws - The WebSocket to send to
 * @param {string} framedMessage - Complete framed message with RS
 * @returns {boolean} True if send was attempted successfully
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

// ============================================================================
// Authentication: extract playerId from JWT token
// ============================================================================

/**
 * Extract and validate the player account ID from a JWT token string.
 * Returns the numeric account ID or null if invalid/missing.
 */
function extractPlayerIdFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
    if (!payload || !payload.sub) return null;
    const accountId = parseInt(payload.sub, 10);
    return Number.isInteger(accountId) && accountId > 0 ? accountId : null;
  } catch (err) {
    return null;
  }
}

/**
 * Extract the access token from a WebSocket upgrade request.
 * SignalR clients that cannot set headers on the upgrade put the token
 * in an `access_token` query param (matching RecFlare behavior).
 * @param {import('http').IncomingMessage} req - The upgrade request
 * @returns {string|null} The token string or null
 */
function extractTokenFromRequest(req) {
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      return parts[1];
    }
  }
  // Fall back to access_token query parameter
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('access_token');
    if (token) return token;
  } catch (_) {
    // URL parsing failed, fall through
  }
  return null;
}

// ============================================================================
// Connection management
// ============================================================================

/**
 * Register a WebSocket connection for a player.
 * @param {WebSocket} ws - The WebSocket connection
 * @param {number} playerId - The authenticated player account ID
 * @param {string} connectionId - Unique connection identifier
 */
function registerConnection(ws, playerId, connectionId) {
  if (!playerConnections.has(playerId)) {
    playerConnections.set(playerId, new Set());
  }
  playerConnections.get(playerId).add(ws);
  socketPlayerId.set(ws, playerId);

  logger.debug('BROADCAST', 'Connection registered', {
    playerId,
    connectionId,
    totalConnectionsForPlayer: playerConnections.get(playerId).size,
  });
}

/**
 * Unregister a WebSocket connection.
 * @param {WebSocket} ws - The WebSocket connection
 */
function unregisterConnection(ws) {
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
 * Get the number of live connections for a player.
 * @param {number} playerId
 * @returns {number}
 */
function getConnectionCountForPlayer(playerId) {
  const connections = playerConnections.get(playerId);
  return connections ? connections.size : 0;
}

/**
 * Get the total number of live (handshaken) connections across all players.
 * @returns {number}
 */
function getTotalLiveConnections() {
  return handshakenSockets.size;
}

// ============================================================================
// Notification delivery
// ============================================================================

/**
 * Deliver a framed notification to all live sockets of a player.
 * Returns the number of sockets that received the frame.
 * @param {number} playerId - Target player account ID
 * @param {string} payload - Serialized notification JSON string
 * @returns {number} Number of sockets delivered to
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
    try { ws.close(); } catch (_) { /* ignore */ }
  }

  deliveryStats.totalSent++;
  deliveryStats.totalDelivered += delivered;
  deliveryStats.totalFailed += (connections.size - delivered);

  return delivered;
}

/**
 * Broadcast a notification to every connected (handshaken) client.
 * Returns the total number of sockets that received the frame.
 * @param {string} payload - Serialized notification JSON string
 * @returns {number} Total sockets delivered to
 */
function broadcastToConnected(payload) {
  const framed = buildInvocation(HUB_TARGET_NOTIFICATION, [payload]);
  let delivered = 0;
  const dead = [];

  for (const ws of handshakenSockets) {
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

  for (const ws of dead) {
    unregisterConnection(ws);
    try { ws.close(); } catch (_) { /* ignore */ }
  }

  deliveryStats.totalSent++;
  deliveryStats.totalDelivered += delivered;
  deliveryStats.totalFailed += dead.length;

  return delivered;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Broadcast a notification to all connected clients.
 * @param {string|number} notificationType - The notification type Id
 * @param {Record<string, unknown>} data - The Msg payload
 * @returns {{ delivered: number }} Delivery result
 */
function broadcastNotification(notificationType, data) {
  if (notificationType === undefined || notificationType === null) {
    throw new Error('notificationType is required');
  }
  const payload = buildNotificationPayload(notificationType, data);
  const delivered = broadcastToConnected(payload);

  // Track stats by type
  const typeKey = String(notificationType);
  const current = deliveryStats.byType.get(typeKey) || { sent: 0, delivered: 0 };
  current.sent++;
  current.delivered += delivered;
  deliveryStats.byType.set(typeKey, current);

  logger.info('BROADCAST', 'Notification broadcast', {
    notificationType: typeKey,
    delivered,
    totalLiveConnections: getTotalLiveConnections(),
  });

  return { delivered };
}

/**
 * Send a notification to a specific player.
 * @param {number} playerId - Target player account ID
 * @param {string|number} notificationType - The notification type Id
 * @param {Record<string, unknown>} data - The Msg payload
 * @returns {{ delivered: number, queued: boolean }} Delivery result
 */
function notifyPlayer(playerId, notificationType, data) {
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
 * Broadcast a server maintenance notification (type 25).
 * Payload: { StartsInMinutes: number }
 * @param {number} startsInMinutes - Minutes until maintenance starts
 * @returns {{ delivered: number }} Delivery result
 */
function broadcastMaintenance(startsInMinutes) {
  if (typeof startsInMinutes !== 'number' || startsInMinutes < 0) {
    throw new Error('startsInMinutes must be a non-negative number');
  }
  return broadcastNotification(NOTIFICATION_TYPE_SERVER_MAINTENANCE, {
    StartsInMinutes: startsInMinutes,
  });
}

/**
 * Send a maintenance notification to a specific player (type 25).
 * @param {number} playerId - Target player account ID
 * @param {number} startsInMinutes - Minutes until maintenance starts
 * @returns {{ delivered: number, queued: boolean }} Delivery result
 */
function notifyPlayerMaintenance(playerId, startsInMinutes) {
  if (typeof startsInMinutes !== 'number' || startsInMinutes < 0) {
    throw new Error('startsInMinutes must be a non-negative number');
  }
  return notifyPlayer(playerId, NOTIFICATION_TYPE_SERVER_MAINTENANCE, {
    StartsInMinutes: startsInMinutes,
  });
}

// ============================================================================
// WebSocket server setup
// ============================================================================

/**
 * Initialize the WebSocket server attached to the given HTTP server.
 * Handles SignalR handshake, connection registration, and message framing.
 * @param {import('http').Server} httpServer - The Express HTTP server
 * @param {Object} options - Configuration options
 * @returns {WebSocketServer} The WebSocket server instance
 */
function initializeWebSocketServer(httpServer, options = {}) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: options.path || '/hub/v1',
    clientTracking: true,
  });

  wss.on('connection', (ws, req) => {
    const connectionId = (req.url && req.url.includes('id='))
      ? req.url.match(/[?&]id=([^&]+)/)?.[1] || require('crypto').randomUUID()
      : require('crypto').randomUUID();

    // Extract player ID from JWT token (query param or header)
    const token = extractTokenFromRequest(req);
    const playerId = token ? extractPlayerIdFromToken(token) : null;

    if (playerId === null) {
      logger.warn('BROADCAST', 'Unidentified WebSocket connection rejected', {
        connectionId,
        ip: req.socket.remoteAddress,
      });
      ws.close(1008, 'Unauthorized');
      return;
    }

    logger.info('BROADCAST', 'WebSocket connection accepted', {
      connectionId,
      playerId,
      ip: req.socket.remoteAddress,
    });

    // Register the connection
    registerConnection(ws, playerId, connectionId);

    // Handle incoming messages (SignalR protocol framing)
    ws.on('message', (message) => {
      const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');

      // Split on Record Separator (0x1e)
      const records = text.split(RS);
      for (const record of records) {
        if (record.length === 0) continue;

        // First frame after connect is the SignalR handshake request
        if (!handshakenSockets.has(ws)) {
          try {
            const handshake = JSON.parse(record);
            const protocol = handshake.protocol || 'json';
            if (protocol !== 'json') {
              ws.send(JSON.stringify({ error: `Unsupported protocol '${protocol}'` }) + RS);
              ws.close(1002, 'unsupported protocol');
              return;
            }
            // Handshake success: empty object reply
            ws.send('{}' + RS);
            // Send OnConnect invocation
            ws.send(buildInvocation(HUB_TARGET_ON_CONNECT, []));
            handshakenSockets.add(ws);
          } catch (_) {
            // Not valid JSON, ignore
          }
          continue;
        }

        // Parse SignalR hub message
        let msg;
        try {
          msg = JSON.parse(record);
        } catch (_) {
          continue;
        }

        if (msg.type === MSG_TYPE_PING) {
          ws.send(JSON.stringify({ type: MSG_TYPE_PING }) + RS);
        } else if (msg.type === MSG_TYPE_CLOSE) {
          ws.close(1000, 'Client requested close');
        } else if (msg.type === MSG_TYPE_INVOCATION) {
          // Handle client invocations (SubscribeTo, SubscribeToPlayers, etc.)
          // Log unknown targets for debugging
          logger.debug('BROADCAST', 'Client invocation', {
            connectionId,
            playerId,
            target: msg.target,
          });
          if (msg.invocationId) {
            ws.send(buildCompletion(msg.invocationId, null));
          }
        }
      }
    });

    ws.on('close', () => {
      logger.debug('BROADCAST', 'WebSocket connection closed', {
        connectionId,
        playerId,
      });
      unregisterConnection(ws);
    });

    ws.on('error', (err) => {
      logger.warn('BROADCAST', 'WebSocket error', {
        connectionId,
        playerId,
        error: err.message,
      });
      unregisterConnection(ws);
      try { ws.close(); } catch (_) { /* ignore */ }
    });
  });

  wss.on('error', (err) => {
    logger.error('BROADCAST', 'WebSocket server error', { error: err.message });
  });

  logger.info('BROADCAST', 'WebSocket server initialized', {
    path: options.path || '/hub/v1',
  });

  return wss;
}

// ============================================================================
// Stats and inspection
// ============================================================================

/**
 * Get delivery statistics.
 * @returns {Object} Delivery stats snapshot
 */
function getDeliveryStats() {
  return {
    totalSent: deliveryStats.totalSent,
    totalDelivered: deliveryStats.totalDelivered,
    totalFailed: deliveryStats.totalFailed,
    totalQueued: deliveryStats.totalQueued,
    byType: Object.fromEntries(deliveryStats.byType),
  };
}

/**
 * Inspect the hub's routing state (for debugging delivery).
 * @returns {{ connections: Array, totalPlayers: number, totalConnections: number }}
 */
function inspectHub() {
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

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Close all WebSocket connections and clear the registry.
 * Called during server shutdown.
 */
function shutdown() {
  logger.info('BROADCAST', 'Shutting down broadcast system', {
    totalPlayers: playerConnections.size,
    totalConnections: getTotalLiveConnections(),
  });

  for (const ws of handshakenSockets) {
    try { ws.close(1001, 'Server shutting down'); } catch (_) { /* ignore */ }
  }

  playerConnections.clear();
  socketPlayerId.delete;
  handshakenSockets.clear();

  // Reset stats
  deliveryStats.totalSent = 0;
  deliveryStats.totalDelivered = 0;
  deliveryStats.totalFailed = 0;
  deliveryStats.totalQueued = 0;
  deliveryStats.byType.clear();
}

module.exports = {
  // Protocol constants
  RS,
  NOTIFICATION_TYPE_SERVER_MAINTENANCE,
  HUB_TARGET_NOTIFICATION,

  // Protocol helpers (exported for testing)
  buildNotificationPayload,
  buildInvocation,

  // Public API
  broadcastNotification,
  notifyPlayer,
  broadcastMaintenance,
  notifyPlayerMaintenance,

  // Connection management
  initializeWebSocketServer,
  registerConnection,
  unregisterConnection,
  getConnectionCountForPlayer,
  getTotalLiveConnections,

  // Stats and inspection
  getDeliveryStats,
  inspectHub,

  // Lifecycle
  shutdown,
};
