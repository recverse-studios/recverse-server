/**
 * RecVerse Server - Name Server Route (Cloudflare Workers)
 * Service discovery endpoint compatible with February 2023 client
 */

import { Hono } from 'hono';
import { buildEndpoints } from '../config.js';

const router = new Hono();

// GET / - Service discovery endpoint
router.get('/', (c) => {
  const endpoints = buildEndpoints(config.server.domain, c.req.header('x-subdomains') || '');
  return c.json(endpoints);
});

// GET /health - Health check for the name server
router.get('/health', (c) => {
  return c.json({ 
    service: 'ns', 
    status: 'ok',
    version: '1.0.0',
    gameVersion: config.game.version,
  });
});

import config from '../config.js';

export default router;
