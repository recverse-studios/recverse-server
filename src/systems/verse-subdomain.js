/**
 * RecVerse Subdomain Routing
 * Routes requests based on subdomain (auth.*, accounts.*, api.*, etc.)
 */

import logger from '../../verse-logger.js';

// Subdomain to router mapping
const SUBDOMAIN_ROUTES = {};

/**
 * Register a router for a specific subdomain
 */
export function registerSubdomain(subdomain, router) {
  SUBDOMAIN_ROUTES[subdomain.toLowerCase()] = router;
  logger.debug('SUBDOMAIN', `Registered subdomain: ${subdomain}`);
}

/**
 * Subdomain routing middleware
 * Extracts subdomain from Host header and routes to appropriate router
 */
export function subdomainRoutingMiddleware(req, res, next) {
  const host = req.headers.host || '';
  const domain = process.env.SERVER_DOMAIN || 'localhost';

  // Extract subdomain from host
  // Example: auth.recverse.local -> subdomain = 'auth'
  // Example: auth.localhost:3000 -> subdomain = 'auth'
  const hostname = host.split(':')[0];
  let subdomain = null;

  if (hostname === domain || hostname === 'localhost' || hostname === '127.0.0.1') {
    // No subdomain - direct access
    return next();
  }

  if (hostname.endsWith('.' + domain)) {
    subdomain = hostname.substring(0, hostname.length - domain.length - 1);
  } else if (hostname.includes('.')) {
    // For local development with subdomain.localhost
    const parts = hostname.split('.');
    if (parts.length > 1 && parts[parts.length - 1] === 'localhost') {
      subdomain = parts[0];
    }
  }

  if (!subdomain) {
    return next();
  }

  const router = SUBDOMAIN_ROUTES[subdomain];
  if (router) {
    logger.debug('SUBDOMAIN', `Routing ${subdomain} -> ${req.method} ${req.path}`);
    return router(req, res, next);
  }

  // Subdomain not registered - continue to next middleware (will 404)
  next();
}

export default {
  registerSubdomain,
  subdomainRoutingMiddleware,
  SUBDOMAIN_ROUTES,
};