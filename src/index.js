/**
 * RecVerse Server - Cloudflare Workers Entry Point
 * 
 * This is the Workers runtime entry point. Instead of Express + http.createServer(),
 * Workers uses the fetch(request, env, ctx) handler pattern.
 * 
 * Architecture:
 *   - Hono.js for HTTP routing (Express-compatible API)
 *   - Cloudflare Hyperdrive for PostgreSQL via Layerbase
 *   - jsonwebtoken + bcryptjs via nodejs_compat
 *   - KV for rate limiting and caching (optional)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

// Import route modules
import accountsRouter from './routes/accounts.js';
import authRouter from './routes/auth.js';
import apiRouter from './routes/api.js';
import roomsRouter from './routes/rooms.js';
import matchRouter from './routes/match.js';
import chatRouter from './routes/chat.js';
import econRouter from './routes/econ.js';
import nsRouter from './routes/ns.js';
import adminRouter from './routes/admin.js';

// Import database and auth modules
import { initDatabase, getDb } from './db/hyperdrive.js';
import { verifyToken, generateToken, hashPassword, verifyPassword } from './auth/jwt.js';
import { authMiddleware, optionalAuth, requireRole, requireStaff } from './auth/middleware.js';

// Import config
import { buildEndpoints, config } from './config.js';

// Create Hono app (Express-compatible router for Workers)
const app = new Hono();

// ============================================================================
// Middleware
// ============================================================================

// CORS - replaces helmet/cors from Express
app.use('*', cors({
  origin: config.cors.origin,
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Request ID middleware (replaces express randomUUID middleware)
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
});

// Request logging (replaces morgan)
app.use('*', logger());

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', async (c) => {
  return c.json({
    status: 'ok',
    service: 'recverse-server',
    version: '1.0.0',
    gameVersion: config.game.version,
    timestamp: new Date().toISOString(),
    runtime: 'cloudflare-workers',
    database: 'hyperdrive-postgresql',
  });
});

// ============================================================================
// Service Discovery (Name Server) - Root path
// ============================================================================

app.get('/', async (c) => {
  const endpoints = buildEndpoints(config.server.domain);
  return c.json(endpoints);
});

// ============================================================================
// Mount Service Routers
// ============================================================================

app.route('/accounts', accountsRouter);
app.route('/auth', authRouter);
app.route('/api', apiRouter);
app.route('/rooms', roomsRouter);
app.route('/match', matchRouter);
app.route('/chat', chatRouter);
app.route('/econ', econRouter);
app.route('/admin', adminRouter);

// Stub services (for service discovery compatibility)
const stubServices = [
  'notify', 'leaderboard', 'roomcomments',
  'playersettings', 'studio', 'commerce', 'datacollection',
  'discovery', 'ai', 'bugreporting', 'cards', 'clubs',
  'cms', 'data', 'gamelogs', 'geo', 'link', 'lists',
  'moderation', 'platformnotifications', 'roomieintegrations',
  'storage', 'strings', 'strings-cdn', 'thorn', 'videos', 'www',
];

for (const service of stubServices) {
  app.get(`/${service}/health`, (c) => {
    return c.json({ service, status: 'ok', note: 'stub - not fully implemented' });
  });
}

// ============================================================================
// 404 Handler
// ============================================================================

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ============================================================================
// Error Handler
// ============================================================================

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ============================================================================
// Workers Fetch Handler
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    // Initialize database connection on first request (lazy initialization)
    // Hyperdrive connection is available via env.DB immediately
    try {
      if (env.DB) {
        // Hyperdrive is available - database is ready via binding
        await initDatabase(env.DB);
      } else {
        // No database binding - return error for DB-dependent routes
        console.warn('No Hyperdrive binding (DB) found. Database-dependent routes will fail.');
      }
    } catch (e) {
      console.error('Database initialization error:', e);
    }

    // Handle the request through Hono
    // env is automatically available in c.env for route handlers
    const response = await app.fetch(request, env, ctx);

    // Add security headers
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    return response;
  },
};

// Export app for testing
export { app };
