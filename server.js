/**
 * RecVerse Server
 * Monolithic Node.js server for Rec Room private server (February 2023 build)
 * With integrated notification, broadcast, maintenance, and subdomain routing systems.
 */

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./verse-config');
const logger = require('./verse-logger');
const { initDatabase, closeDb } = require('./verse-db');
const { buildEndpoints } = require('./verse-utils');

// Import service routers
const nsRouter = require('./verse-ns');
const accountsRouter = require('./verse-accounts');
const authRouter = require('./verse-auth');
const apiRouter = require('./verse-api');
const roomsRouter = require('./verse-rooms');
const matchRouter = require('./verse-match');
const chatRouter = require('./verse-chat');
const econRouter = require('./verse-econ');

// Import system modules
const {
  initializeWebSocketServer,
  shutdown: shutdownBroadcast,
  getTotalLiveConnections,
} = require('./src/systems/verse-broadcast');
const {
  initialize: initializeMaintenance,
  shutdown: shutdownMaintenance,
} = require('./src/systems/verse-maintenance');
const { router: adminRouter } = require('./src/systems/verse-admin');
const { subdomainRoutingMiddleware, registerSubdomain } = require('./src/systems/verse-subdomain');
const cdnRouter = require('./src/systems/verse-cdn');

// Create Express app
const app = express();

// Trust proxy for correct IP detection behind load balancers
app.set('trust proxy', false);

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: config.cors.origin,
  credentials: true,
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

// Register subdomain routes (so auth.*, accounts.*, api.*, etc. work without 404)
registerSubdomain('auth', authRouter);
registerSubdomain('accounts', accountsRouter);
registerSubdomain('api', apiRouter);
registerSubdomain('rooms', roomsRouter);
registerSubdomain('match', matchRouter);
registerSubdomain('chat', chatRouter);
registerSubdomain('econ', econRouter);
registerSubdomain('admin', adminRouter);

// CDN subdomains - serve images (avatars, banners, room images, etc.)
registerSubdomain('cdn', cdnRouter);
registerSubdomain('img', cdnRouter);

// Stub services as subdomains too
const stubServices = [
  'notify', 'leaderboard', 'roomcomments',
  'playersettings', 'studio', 'commerce', 'datacollection',
  'discovery', 'ai', 'bugreporting', 'cards', 'clubs',
  'cms', 'data', 'gamelogs', 'geo', 'link', 'lists',
  'moderation', 'platformnotifications', 'roomieintegrations',
  'storage', 'strings', 'strings-cdn', 'thorn', 'videos', 'www',
];

for (const service of stubServices) {
  const stubRouter = express.Router();
  stubRouter.get('/health', (req, res) => {
    res.json({ service, status: 'ok', note: 'stub - not fully implemented' });
  });
  registerSubdomain(service, stubRouter);
}

// Apply subdomain routing middleware BEFORE path-based routes
app.use(subdomainRoutingMiddleware);

// Apply rate limiting to path-based routes (for direct access without subdomain)
app.use('/auth/connect/token', authLimiter);
app.use('/account/create', authLimiter);
app.use('/account/recoverpassword', authLimiter);
app.use(limiter);

// Request ID middleware
app.use((req, res, next) => {
  req.id = require('crypto').randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Health check (no auth, no rate limit)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'recverse-server',
    version: '1.0.0',
    gameVersion: config.game.version,
    timestamp: new Date().toISOString(),
    liveConnections: getTotalLiveConnections(),
  });
});

// Service Discovery (Name Server) - MUST be first for root path
app.use('/', nsRouter);

// Mount service routers (path-based, for direct access without subdomain)
app.use('/accounts', accountsRouter);
app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use('/rooms', roomsRouter);
app.use('/match', matchRouter);
app.use('/chat', chatRouter);
app.use('/econ', econRouter);

// Admin routes (maintenance + broadcast)
app.use('/admin', adminRouter);

// Additional service stubs (path-based, for direct access without subdomain)
for (const service of stubServices) {
  const stubRouter = express.Router();
  stubRouter.get('/health', (req, res) => {
    res.json({ service, status: 'ok', note: 'stub - not fully implemented' });
  });
  app.use(`/${service}`, stubRouter);
}

// 404 handler
app.use((req, res) => {
  logger.warn('HTTP', '404 Not Found', { path: req.path, method: req.method, ip: req.ip, host: req.headers.host });
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('HTTP', 'Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.id,
    host: req.headers.host,
  });
  
  // Don't leak error details in production
  const message = config.server.env === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: message });
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('STARTUP', 'Unhandled Rejection at:', { promise, reason: reason?.message || reason });
});

// Initialize database, WebSocket server, maintenance, and start HTTP server
async function start() {
  let server = null;
  try {
    logger.startup('Starting RecVerse Server...');
    
    // Determine port (support both SERVER_PORT and PORT env vars for Northflank compatibility)
    const port = parseInt(process.env.PORT || config.server.port || '3000', 10);
    const host = config.server.host || '0.0.0.0';
    
    logger.startup(`Configuring server on ${host}:${port}`);
    
    // Initialize database
    await initDatabase();
    logger.startup('Database initialized');
    
    // Initialize maintenance system (loads persisted state, restarts pending countdown)
    await initializeMaintenance();
    logger.startup('Maintenance system initialized');
    
    // Create HTTP server explicitly so we can attach WebSocket server
    server = http.createServer(app);
    
    // Handle server errors
    server.on('error', (err) => {
      logger.error('HTTP', 'Server error', { error: err.message, code: err.code });
      if (err.code === 'EADDRINUSE') {
        logger.error('HTTP', `Port ${port} is already in use`);
        process.exit(1);
      }
    });
    
    // Initialize WebSocket/SignalR server for notification delivery
    initializeWebSocketServer(server, { path: '/hub/v1' });
    logger.startup('WebSocket/SignalR server initialized at /hub/v1');
    
    // Start HTTP server (WebSocket server is attached to the same instance)
    await new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        logger.startup(`Server listening on ${host}:${port}`);
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
        
        logger.startup(`  WebSocket/SignalR: ws://${host}:${port}/hub/v1`);
        logger.startup(`  Admin API: http://${host}:${port}/admin`);
        logger.startup(`  Subdomain routing: auth.*, accounts.*, api.*, rooms.*, match.*, chat.*, econ.*, cdn.*, img.*`);
        
        resolve();
      });
    });
    
    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.shutdown(`${signal} received, shutting down...`);
      
      // Shutdown broadcast system (close all WebSocket connections)
      shutdownBroadcast();
      
      // Shutdown maintenance system (clear timers, persist state)
      shutdownMaintenance();
      
      if (server) {
        server.close(async () => {
          logger.shutdown('HTTP server closed');
          await closeDb();
          process.exit(0);
        });
      } else {
        await closeDb();
        process.exit(0);
      }
      
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

module.exports = app;
