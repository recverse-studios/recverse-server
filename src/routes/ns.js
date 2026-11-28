/**
 * RecVerse Service Discovery (Name Server)
 * Implements the service discovery endpoint compatible with February 2023 client
 */

import express from 'express';
import { buildEndpoints } from '../../../verse-utils.js';
import config from '../../../verse-config.js';
import logger from '../../../verse-logger.js';

const router = express.Router();

/**
 * GET / - Service discovery endpoint
 * Returns a map of service labels to their URLs
 * Compatible with Rec Room client February 2023 build
 */
router.get('/', (req, res) => {
  try {
    // Build endpoints using the same logic as RecFlare
    const endpoints = buildEndpoints(config.server.domain, req.headers['x-subdomains'] || '');
    
    logger.ns('Service discovery requested', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json(endpoints);
  } catch (error) {
    logger.error('NS', 'Service discovery failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  });
});

/**
 * GET /health - Health check for the name server
 */
router.get('/health', (req, res) => {
  res.json({ 
    service: 'ns', 
    status: 'ok',
    version: '1.0.0',
    gameVersion: config.game.version,
  });
});

import config from '../../../verse-config.js';

export default router;