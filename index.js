/**
 * RecVerse Server
 * Monolithic Node.js server for Rec Room private server (February 2023 build)
 * Cloudflare Workers compatible via Express integration
 */

import 'dotenv/config';

import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import config from './verse-config.js';
import logger from './verse-logger.js';
import { initDatabase, closeDb } from './verse-db.js';
import { buildEndpoints } from './verse-utils.js';

// Import service routers
import nsRouter from './verse-ns.js';
import accountsRouter from './verse-accounts.js';
import authRouter from './verse-auth.js';
import apiRouter from './verse-api.js';
import roomsRouter from './verse-rooms.js';
import matchRouter from './verse-match.js';
import chatRouter from './verse-chat.js';
import econRouter from './verse-econ.js';

// Import system modules
import {
  initializeWebSocketServer,
  shutdown: shutdownBroadcast,
  getTotalLiveConnections,
} from './src/systems/verse-broadcast.js';
import {
  initialize: initializeMaintenance,
  shutdown: shutdownMaintenance,
} from './src/systems/verse-maintenance.js';
import { router: adminRouter } from './src/systems/verse-admin.js';
import { subdomainRoutingMiddleware, registerSubdomain } from './src/systems/verse-subdomain.js';
import cdnRouter from './src/systems/verse-cdn.js';

// Create Express app
const app = express();

// Trust proxy for correct IP detection behind load balancers
// Set to false since we're not behind a proxy (causes rate limiter warning)
app.set('trust proxy', false);

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: config.cors.origin,
  credentials: config.cors.credentials,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.rateLimit.authMaxRequests,
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use('/auth/connect/token', authLimiter);
app.use('/account/create', authLimiter);
app.use('/account/recoverpassword', authLimiter);
app.use(limiter);

// Request ID middleware
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}

// Health check (no auth, no rate limit)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'recverse-server',
    version: '1.0.0',
    gameVersion: config.game.version,
    timestamp: new Date().toISOString(),
  });
});

// Service Discovery (Name Server) - MUST be first for root path
app.use('/', import('./verse-ns.js').then(m => m.default));

// Mount service routers
import nsRouter from './verse-ns.js';
import accountsRouter from './verse-accounts.js';
import authRouter from './verse-auth.js';
import apiRouter from './verse-api.js';
import roomsRouter from './verse-rooms.js';
import matchRouter from './verse-match.js';
import chatRouter from './verse-chat.js';
import econRouter from './verse-econ.js';

app.use('/accounts', accountsRouter);
app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use('/rooms', roomsRouter);
app.use('/match', matchRouter);
app.use('/chat', chatRouter);
app.use('/econ', econRouter);

// Additional service stubs (to be implemented)
const stubServices = [
  'cdn', 'img', 'notify', 'leaderboard', 'roomcomments',
  'playersettings', 'studio', 'commerce', 'datacollection',
  'discovery', 'ai', 'bugreporting', 'cards', 'clubs',
  'cms', 'data', 'gamelogs', 'geo', 'link', 'lists',
  'moderation', 'platformnotifications', 'roomieintegrations',
  'storage', 'strings', 'strings-cdn', 'thorn', 'videos', 'www',
];

for (const service of stubServices) {
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.json({ service, status: 'ok', note: 'stub - not fully implemented' });
  });
  app.use(`/${service}`, router);
}

// 404 handler
app.use((req, res) => {
  logger.warn('HTTP', '404 Not Found', { path: req.path, method: req.method, ip: req.ip });
  res.status(404).json({ error: 'Not found' });
}

// Error handler
app.use((err, req, res, next) => {
  logger.error('HTTP', 'Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.id,
  });

  // Don't leak error details in production
  const message = config.server.env === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: message });
});

// Initialize database and start server
async function start() {
  try {
    logger.startup('Starting RecVerse Server...');

    // Initialize database
    await import('./verse-db.js').then(m => m.initDatabase());
    logger.startup('Database initialized');

    // Initialize maintenance system
    const { initialize: initializeMaintenance } = await import('./src/systems/verse-maintenance.js');
    await initializeMaintenance();
    logger.startup('Maintenance system initialized');

    // Initialize WebSocket server
    const { initializeWebSocketServer } = await import('./src/systems/verse-broadcast.js');
    const server = http.createServer(app);

    initializeWebSocketServer(server, { path: '/hub/v1' });
    logger.startup('WebSocket/SignalR server initialized at /hub/v1');

    // Start HTTP server
    server.listen(config.server.port, config.server.host, () => {
      logger.startup(`Server listening on ${config.server.host}:${config.server.port}`);
      logger.startup(`Base URL: ${config.server.baseUrl}`);
      logger.startup(`Game version: ${config.game.version}`);
      logger.startup(`Supported versions: ${config.game.supportedVersions.join(', ')}`);
      if (config.game.rolloutVersions.length > 0) {
        logger.startup(`Rollout versions: ${config.game.rolloutVersions.join(', ')}`);
      }

      // Log service endpoints
      const endpoints = buildEndpoints(config.server.domain);
      logger.startup('Service endpoints:');
      for (const [service, url] of Object.entries(endpoints)) {
        logger.startup(`  ${service}: ${url}`);
      }

      logger.startup(`  WebSocket/SignalR: ws://${config.server.host}:${config.server.port}/hub/v1`);
      logger.startup(`  Admin API: http://${config.server.host}:${config.server.port}/admin`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.shutdown(`${signal} received, shutting down...`);
      const { shutdown: shutdownBroadcast } = await import('./src/systems/verse-broadcast.js');
      const { shutdown: shutdownMaintenance } = await import('./src/systems/verse-maintenance.js');

      shutdownBroadcast();
      shutdownMaintenance();

      server.close(async () => {
        logger.shutdown('HTTP server closed');
        const { closeDb } = await import('./verse-db.js');
        await closeDb();
        process.exit(0);
      });

      // Force close after 10 seconds
      setTimeout(() => {
        logger.error('SHUTDOWN', 'Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('STARTUP', 'Failed to start server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

start();

export default app;