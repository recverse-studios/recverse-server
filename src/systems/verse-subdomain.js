/**
 * RecVerse Server - Subdomain Routing
 * src/systems/verse-subdomain.js
 *
 * Middleware que roteia requisições baseado no subdomínio do host.
 * Exemplo: auth.recverse.northflank.app -> authRouter
 *          accounts.recverse.northflank.app -> accountsRouter
 *
 * Isso evita 404 quando o cliente acessa serviços por subdomínio
 * (conforme retornado pelo Name Server / service discovery).
 */

const logger = require('../../verse-logger');
const config = require('../../verse-config');

// Mapeamento de subdomínio -> router
const SUBDOMAIN_ROUTES = {};

/**
 * Registra um router para um subdomínio específico.
 * @param {string} subdomain - O subdomínio (ex: 'auth', 'accounts', 'api')
 * @param {import('express').Router} router - O router Express
 */
function registerSubdomain(subdomain, router) {
  SUBDOMAIN_ROUTES[subdomain.toLowerCase()] = router;
  logger.debug('SUBDOMAIN', `Registered subdomain: ${subdomain}`);
}

/**
 * Middleware de roteamento por subdomínio.
 * Detecta o subdomínio do Host header e encaminha para o router correto.
 * If no matching subdomain, passes to the next middleware.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function subdomainRoutingMiddleware(req, res, next) {
  const host = req.headers.host || '';
  const domain = config.server.domain || 'localhost';

  // Remove porta se presente
  const hostname = host.split(':')[0];

  // If it's exactly the base domain or localhost, no subdomain
  if (hostname === domain || hostname === 'localhost' || hostname === '127.0.0.1') {
    return next();
  }

  // Extrair subdomínio: primeira parte antes do primeiro ponto
  // Exemplo: auth.recverse.northflank.app -> subdomain = 'auth'
  // Exemplo: auth.localhost:3000 -> subdomain = 'auth'
  // Exemplo: accounts.localhost:3000 -> subdomain = 'accounts'
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    subdomain = parts[0];
  }

  if (!subdomain) {
    return next();
  }

  const router = SUBDOMAIN_ROUTES[subdomain];
  if (router) {
    logger.debug('SUBDOMAIN', `Routing ${subdomain} -> ${req.method} ${req.path}`);
    // Executa o router do subdomínio
    return router(req, res, next);
  }

  // Subdomain not registered - continue to next middleware (404 handler)
  next();
}

module.exports = {
  subdomainRoutingMiddleware,
  registerSubdomain,
  SUBDOMAIN_ROUTES,
};
