/**
 * RecVerse Server - Notification & Maintenance System Tests
 * Tests for verse-broadcast.js, verse-maintenance.js, verse-admin.js
 *
 * Run with: npx jest notification-maintenance.test.js --coverage
 */

const http = require('http');
const { Server: WebSocketServer } = require('ws');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Mock the database module before requiring system modules
jest.mock('./verse-db', () => {
  const actual = jest.requireActual('./verse-db');
  const mockDb = {
    run: jest.fn(function(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (cb) cb.call(this, null);
      return this;
    }),
    prepare: jest.fn(() => ({
      run: jest.fn(function() { return this; }),
      get: jest.fn(() => null),
      all: jest.fn(() => []),
    })),
    exec: jest.fn(),
    pragma: jest.fn(),
    close: jest.fn(),
  };
  return {
    ...actual,
    getDb: jest.fn(() => Promise.resolve(mockDb)),
    closeDb: jest.fn(() => Promise.resolve()),
    dbRun: jest.fn(() => Promise.resolve({})),
    dbGet: jest.fn(() => Promise.resolve(null)),
    dbAll: jest.fn(() => Promise.resolve([])),
  };
});

jest.mock('./verse-auth-middleware', () => {
  const actual = jest.requireActual('./verse-auth-middleware');
  return {
    ...actual,
    writeAuditLog: jest.fn(),
  };
});

jest.mock('./verse-logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  http: jest.fn(),
  db: jest.fn(),
  startup: jest.fn(),
  shutdown: jest.fn(),
}));

jest.mock('./verse-config', () => ({
  server: {
    host: '0.0.0.0',
    port: 3000,
    env: 'test',
    domain: 'localhost',
    protocol: 'http',
    baseUrl: 'http://localhost:3000',
  },
  jwt: {
    secret: 'test-secret',
    issuer: 'recverse',
    audience: 'recverse-client',
  },
  database: {
    client: 'sqlite3',
    path: './database/recverse.db',
    migrationsPath: './migrations',
    pgHost: 'localhost',
    pgPort: 5432,
    pgUser: 'postgres',
    pgPassword: '',
    pgDatabase: 'recverse',
    pgSsl: false,
    pgMaxConnections: 20,
  },
}));

// Import modules after mocks
const {
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
  shutdown: shutdownBroadcast,
  RS,
  NOTIFICATION_TYPE_SERVER_MAINTENANCE,
  buildNotificationPayload,
  buildInvocation,
} = require('./src/systems/verse-broadcast');

const {
  startMaintenance,
  cancelMaintenance,
  rescheduleMaintenance,
  getMaintenanceStatus,
  isMaintenanceActive,
  initialize: initializeMaintenance,
  shutdown: shutdownMaintenance,
  NOTIFICATION_TYPE_SERVER_MAINTENANCE: MAINT_TYPE,
} = require('./src/systems/verse-maintenance');

const { router: adminRouter, requireDeveloper, isDeveloper } = require('./src/systems/verse-admin');

// ============================================================================
// Test helpers
// ============================================================================

function makeToken(accountId, roles = ['developer']) {
  return jwt.sign(
    { sub: String(accountId), role: roles, iss: 'recverse', aud: 'recverse-client' },
    'test-secret'
  );
}

function makeAuthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function createTestServer() {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin', adminRouter);
  return http.createServer(app);
}

function connectWebSocket(port, token, path = '/hub/v1') {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${port}${path}?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    let handshakeDone = false;
    let onConnectReceived = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + '\u001e');
    });

    ws.on('message', (data) => {
      const text = data.toString();
      const records = text.split('\u001e').filter(r => r.length > 0);
      for (const record of records) {
        try {
          const msg = JSON.parse(record);
          if (!handshakeDone && msg.type === undefined && Object.keys(msg).length === 0) {
            handshakeDone = true;
          } else if (msg.type === 1 && msg.target === 'OnConnect') {
            onConnectReceived = true;
            resolve({ ws, handshakeDone, onConnectReceived });
          }
        } catch (_) {}
      }
    });

    ws.on('error', reject);
  });
}

function waitForNotification(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for notification')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      const text = data.toString();
      const records = text.split('\u001e').filter(r => r.length > 0);
      const notifications = [];
      for (const record of records) {
        try {
          const msg = JSON.parse(record);
          if (msg.type === 1 && msg.target === 'Notification') {
            notifications.push(msg);
          }
        } catch (_) {}
      }
      resolve(notifications);
    });
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('RecVerse Notification & Maintenance System', () => {
  let wsServer;
  let wss;
  let wsPort;

  beforeAll(async () => {
    // Reset maintenance state by cancelling any active maintenance
    cancelMaintenance();
  });

  afterAll(async () => {
    shutdownBroadcast();
    shutdownMaintenance();
    if (wsServer) wsServer.close();
  });

  describe('Notification Serialization', () => {
    test('buildNotificationPayload creates correct {Id, Msg} structure', () => {
      const payload = buildNotificationPayload(25, { StartsInMinutes: 5 });
      const parsed = JSON.parse(payload);
      expect(parsed.Id).toBe('25');
      expect(parsed.Msg.StartsInMinutes).toBe(5);
    });

    test('buildNotificationPayload drops null/undefined values from Msg', () => {
      const payload = buildNotificationPayload(2, { FromPlayerId: 1, Data: null, Type: 100 });
      const parsed = JSON.parse(payload);
      expect(parsed.Msg.FromPlayerId).toBe(1);
      expect(parsed.Msg.Type).toBe(100);
      expect(parsed.Msg.Data).toBeUndefined();
    });

    test('buildNotificationPayload converts numeric Id to string', () => {
      const payload = buildNotificationPayload(25, {});
      const parsed = JSON.parse(payload);
      expect(typeof parsed.Id).toBe('string');
      expect(parsed.Id).toBe('25');
    });

    test('buildNotificationPayload handles string Id types', () => {
      const payload = buildNotificationPayload('AccountUpdate', {});
      const parsed = JSON.parse(payload);
      expect(parsed.Id).toBe('AccountUpdate');
    });

    test('NOTIFICATION_TYPE_SERVER_MAINTENANCE is 25', () => {
      expect(NOTIFICATION_TYPE_SERVER_MAINTENANCE).toBe(25);
    });
  });

  describe('SignalR Invocation Framing', () => {
    test('buildInvocation creates correct SignalR type 1 frame', () => {
      const frame = buildInvocation('Notification', ['test payload']);
      const parsed = JSON.parse(frame.replace('\u001e', ''));
      expect(parsed.type).toBe(1);
      expect(parsed.target).toBe('Notification');
      expect(parsed.arguments).toEqual(['test payload']);
    });

    test('buildInvocation ends with Record Separator', () => {
      const frame = buildInvocation('Notification', ['test']);
      expect(frame.endsWith('\u001e')).toBe(true);
    });

    test('RS constant is 0x1e', () => {
      expect(RS).toBe('\u001e');
      expect(RS.charCodeAt(0)).toBe(0x1e);
    });
  });

  describe('WebSocket Connection Management', () => {
    test('registerConnection and getConnectionCountForPlayer work', () => {
      const mockWs = { readyState: WebSocket.OPEN };
      registerConnection(mockWs, 42, 'conn-1');
      expect(getConnectionCountForPlayer(42)).toBe(1);

      const mockWs2 = { readyState: WebSocket.OPEN };
      registerConnection(mockWs2, 42, 'conn-2');
      expect(getConnectionCountForPlayer(42)).toBe(2);

      unregisterConnection(mockWs);
      expect(getConnectionCountForPlayer(42)).toBe(1);

      unregisterConnection(mockWs2);
      expect(getConnectionCountForPlayer(42)).toBe(0);
    });

    test('getTotalLiveConnections returns 0 with no connections', () => {
      expect(getTotalLiveConnections()).toBe(0);
    });
  });

  describe('Global Notification Delivery (broadcastNotification)', () => {
    test('broadcastNotification with no connections returns 0 delivered', () => {
      const result = broadcastNotification(25, { StartsInMinutes: 1 });
      expect(result.delivered).toBe(0);
    });

    test('broadcastNotification throws without notificationType', () => {
      expect(() => broadcastNotification(undefined, {})).toThrow('notificationType is required');
    });
  });

  describe('Individual Player Notification (notifyPlayer)', () => {
    test('notifyPlayer with no connections returns delivered: 0, queued: true', () => {
      const result = notifyPlayer(999, 25, { StartsInMinutes: 1 });
      expect(result.delivered).toBe(0);
      expect(result.queued).toBe(true);
    });

    test('notifyPlayer throws without playerId', () => {
      expect(() => notifyPlayer(null, 25, {})).toThrow('playerId is required');
    });

    test('notifyPlayer throws without notificationType', () => {
      expect(() => notifyPlayer(1, undefined, {})).toThrow('notificationType is required');
    });
  });

  describe('Maintenance Notification (broadcastMaintenance)', () => {
    test('broadcastMaintenance sends type 25 with StartsInMinutes', () => {
      const result = broadcastMaintenance(5);
      expect(result.delivered).toBe(0); // No connections
    });

    test('broadcastMaintenance throws with negative minutes', () => {
      expect(() => broadcastMaintenance(-1)).toThrow('startsInMinutes must be a non-negative number');
    });

    test('broadcastMaintenance throws with non-number', () => {
      expect(() => broadcastMaintenance('five')).toThrow('startsInMinutes must be a non-negative number');
    });
  });

  describe('Maintenance Controller', () => {
    test('startMaintenance creates valid schedule', () => {
      const result = startMaintenance(10);
      expect(result.success).toBe(true);
      expect(result.startsInMinutes).toBe(10);
      expect(result.scheduledAt).toBeDefined();
      expect(result.startsAt).toBeDefined();
      expect(result.message).toContain('10');
    });

    test('startMaintenance prevents duplicate scheduling', () => {
      const result = startMaintenance(5);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Maintenance is already scheduled');
    });

    test('startMaintenance rejects invalid minutes', () => {
      expect(startMaintenance(0).success).toBe(false);
      expect(startMaintenance(-5).success).toBe(false);
      expect(startMaintenance('abc').success).toBe(false);
    });

    test('getMaintenanceStatus returns correct state', () => {
      const status = getMaintenanceStatus();
      expect(status.isActive).toBe(true);
      expect(status.startsInMinutes).toBe(10);
      expect(status.cancelled).toBe(false);
      expect(Array.isArray(status.warningIntervals)).toBe(true);
    });

    test('isMaintenanceActive returns true while active', () => {
      expect(isMaintenanceActive()).toBe(true);
    });

    test('cancelMaintenance cancels active maintenance', () => {
      const result = cancelMaintenance();
      expect(result.success).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(result.message).toContain('cancelled');
    });

    test('getMaintenanceStatus shows cancelled after cancel', () => {
      const status = getMaintenanceStatus();
      expect(status.cancelled).toBe(true);
    });

    test('isMaintenanceActive returns false after cancel', () => {
      expect(isMaintenanceActive()).toBe(false);
    });

    test('cancelMaintenance on already cancelled returns error', () => {
      const result = cancelMaintenance();
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active maintenance to cancel');
    });

    test('rescheduleMaintenance requires active maintenance', () => {
      const result = rescheduleMaintenance(20);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active maintenance to reschedule');
    });

    test('rescheduleMaintenance after starting new maintenance', () => {
      startMaintenance(15);
      const result = rescheduleMaintenance(30);
      expect(result.success).toBe(true);
      expect(result.startsInMinutes).toBe(30);
      expect(result.message).toContain('30');
      cancelMaintenance();
    });

    test('startMaintenance with custom warning intervals', () => {
      const result = startMaintenance(20, { warningIntervals: [10, 5, 2] });
      expect(result.success).toBe(true);
      const status = getMaintenanceStatus();
      expect(status.warningIntervals).toEqual([10, 5, 2]);
      cancelMaintenance();
    });
  });

  describe('Admin Authorization', () => {
    test('isDeveloper returns true for developer role', () => {
      expect(isDeveloper({ role: ['developer'] })).toBe(true);
      expect(isDeveloper({ role: 'developer' })).toBe(true);
      expect(isDeveloper({ role: ['moderator'] })).toBe(false);
      expect(isDeveloper({})).toBe(false);
      expect(isDeveloper(null)).toBe(false);
    });

    test('requireDeveloper rejects non-developer roles', () => {
      const token = jwt.sign(
        { sub: '2', role: ['moderator'], iss: 'recverse', aud: 'recverse-client' },
        'test-secret'
      );
      const mockReq = { headers: { authorization: `Bearer ${token}` } };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const mockNext = jest.fn();

      requireDeveloper(mockReq, mockRes, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('requireDeveloper allows developer role', () => {
      const token = jwt.sign(
        { sub: '1', role: ['developer'], iss: 'recverse', aud: 'recverse-client' },
        'test-secret'
      );
      const mockReq = { headers: { authorization: `Bearer ${token}` } };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const mockNext = jest.fn();

      requireDeveloper(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.tokenPayload).toBeDefined();
    });
  });

  describe('Admin API Endpoints (via HTTP)', () => {
    const adminToken = jwt.sign(
      { sub: '1', role: ['developer'], iss: 'recverse', aud: 'recverse-client' },
      'test-secret'
    );
    const nonAdminToken = jwt.sign(
      { sub: '2', role: ['moderator'], iss: 'recverse', aud: 'recverse-client' },
      'test-secret'
    );

    test('POST /admin/maintenance/start - developer can start maintenance', async () => {
      cancelMaintenance();

      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const body = JSON.stringify({ minutes: 10 });
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/maintenance/start',
              method: 'POST',
              headers: {
                ...makeAuthHeaders(adminToken),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.write(body);
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.startsInMinutes).toBe(10);
      cancelMaintenance();
    });

    test('POST /admin/maintenance/start - non-developer rejected', async () => {
      cancelMaintenance();

      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const body = JSON.stringify({ minutes: 10 });
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/maintenance/start',
              method: 'POST',
              headers: {
                ...makeAuthHeaders(nonAdminToken),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.write(body);
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('developer');
    });

    test('GET /admin/maintenance/status returns current state', async () => {
      startMaintenance(15);

      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/maintenance/status',
              method: 'GET',
              headers: makeAuthHeaders(adminToken),
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isActive).toBe(true);
      cancelMaintenance();
    });

    test('POST /admin/maintenance/cancel cancels maintenance', async () => {
      startMaintenance(10);

      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/maintenance/cancel',
              method: 'POST',
              headers: makeAuthHeaders(adminToken),
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cancelled).toBe(true);
    });

    test('POST /admin/maintenance/reschedule changes time', async () => {
      startMaintenance(10);

      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const body = JSON.stringify({ minutes: 30 });
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/maintenance/reschedule',
              method: 'POST',
              headers: {
                ...makeAuthHeaders(adminToken),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.write(body);
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.startsInMinutes).toBe(30);
      cancelMaintenance();
    });

    test('POST /admin/broadcast sends notification', async () => {
      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const body = JSON.stringify({ message: 'Test broadcast message' });
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/broadcast',
              method: 'POST',
              headers: {
                ...makeAuthHeaders(adminToken),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.write(body);
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.delivered).toBe(0);
    });

    test('POST /admin/broadcast rejects empty message', async () => {
      const res = await new Promise((resolve, reject) => {
        const testServer = createTestServer();
        testServer.listen(0, async () => {
          const port = testServer.address().port;
          try {
            const body = JSON.stringify({ message: '' });
            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/admin/broadcast',
              method: 'POST',
              headers: {
                ...makeAuthHeaders(adminToken),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            }, (response) => {
              let data = '';
              response.on('data', chunk => data += chunk);
              response.on('end', () => {
                testServer.close();
                resolve({ status: response.statusCode, body: JSON.parse(data) });
              });
            });
            req.write(body);
            req.end();
          } catch (err) {
            testServer.close();
            reject(err);
          }
        });
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('message');
    });
  });

  describe('WebSocket Integration (Integration Test)', () => {
    beforeAll(async () => {
      const express = require('express');
      const app = express();
      app.use(express.json());
      wsServer = http.createServer(app);
      wss = initializeWebSocketServer(wsServer, { path: '/hub/v1' });
      await new Promise((resolve) => wsServer.listen(0, () => {
        wsPort = wsServer.address().port;
        resolve();
      }));
    });

    afterAll(async () => {
      if (wss) wss.close();
      if (wsServer) wsServer.close();
      shutdownBroadcast();
    });

    test('WebSocket handshake completes successfully', async () => {
      const token = makeToken(42, ['developer']);
      const { ws, handshakeDone, onConnectReceived } = await connectWebSocket(
        wsPort, token
      );
      expect(handshakeDone).toBe(true);
      expect(onConnectReceived).toBe(true);
      expect(getConnectionCountForPlayer(42)).toBe(1);
      ws.close();
    });

    test('Broadcast notification reaches connected WebSocket client', async () => {
      const token = makeToken(42, ['developer']);
      const { ws } = await connectWebSocket(wsPort, token);
      await new Promise(r => setTimeout(r, 100));

      broadcastNotification(25, { StartsInMinutes: 5 });

      const notifications = await waitForNotification(ws);
      expect(notifications.length).toBeGreaterThan(0);

      const notif = notifications[0];
      expect(notif.type).toBe(1);
      expect(notif.target).toBe('Notification');
      const payload = JSON.parse(notif.arguments[0]);
      expect(payload.Id).toBe('25');
      expect(payload.Msg.StartsInMinutes).toBe(5);

      ws.close();
    });

    test('notifyPlayer reaches specific player', async () => {
      const token = makeToken(42, ['developer']);
      const { ws } = await connectWebSocket(wsPort, token);
      await new Promise(r => setTimeout(r, 100));

      notifyPlayer(42, 25, { StartsInMinutes: 3 });

      const notifications = await waitForNotification(ws);
      const maintNotifs = notifications.filter(n => {
        try {
          const p = JSON.parse(n.arguments[0]);
          return p.Id === '25';
        } catch (_) { return false; }
      });
      expect(maintNotifs.length).toBeGreaterThan(0);
      ws.close();
    });

    test('notifyPlayer to offline player returns queued: true', () => {
      const result = notifyPlayer(99999, 25, { StartsInMinutes: 1 });
      expect(result.delivered).toBe(0);
      expect(result.queued).toBe(true);
    });

    test('getDeliveryStats tracks broadcast stats', () => {
      const stats = getDeliveryStats();
      expect(stats.totalSent).toBeGreaterThanOrEqual(0);
      expect(stats.totalDelivered).toBeGreaterThanOrEqual(0);
      expect(typeof stats.byType).toBe('object');
    });

    test('inspectHub returns hub state', () => {
      const state = inspectHub();
      expect(state).toHaveProperty('connections');
      expect(state).toHaveProperty('totalPlayers');
      expect(state).toHaveProperty('totalConnections');
      expect(state).toHaveProperty('liveConnections');
      expect(typeof state.totalPlayers).toBe('number');
    });
  });

  describe('Timer Cleanup', () => {
    test('shutdownMaintenance clears all timers', () => {
      startMaintenance(5);
      const before = getMaintenanceStatus();
      expect(before.timersPending).toBeGreaterThan(0);

      shutdownMaintenance();
      const after = getMaintenanceStatus();
      expect(after.timersPending).toBe(0);
    });

    test('shutdownBroadcast does not throw', () => {
      expect(() => shutdownBroadcast()).not.toThrow();
    });
  });

  describe('Client Compatibility', () => {
    test('ServerMaintenance notification matches RecFlare protocol', () => {
      const payload = buildNotificationPayload(25, { StartsInMinutes: 1 });
      const parsed = JSON.parse(payload);
      expect(parsed.Id).toBe('25');
      expect(parsed.Msg.StartsInMinutes).toBe(1);
      expect(typeof parsed.Id).toBe('string');
    });

    test('SignalR notification invocation matches RecFlare wire format', () => {
      const payload = buildNotificationPayload(25, { StartsInMinutes: 1 });
      const frame = buildInvocation('Notification', [payload]);
      const parsed = JSON.parse(frame.replace('\u001e', ''));
      expect(parsed.type).toBe(1);
      expect(parsed.target).toBe('Notification');
      expect(parsed.arguments[0]).toBe(payload);
      expect(frame.endsWith('\u001e')).toBe(true);
    });

    test('Coach/system broadcast pattern uses MessageReceived type 2', () => {
      const payload = buildNotificationPayload(2, {
        FromPlayerId: 1,
        Type: 100,
        Data: 'Server message',
        SentTime: new Date().toISOString(),
      });
      const parsed = JSON.parse(payload);
      expect(parsed.Id).toBe('2');
      expect(parsed.Msg.FromPlayerId).toBe(1);
      expect(parsed.Msg.Type).toBe(100);
      expect(parsed.Msg.Data).toBe('Server message');
      expect(parsed.Msg.SentTime).toBeDefined();
    });
  });
});
