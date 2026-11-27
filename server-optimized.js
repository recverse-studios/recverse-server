/**
 * RecVerse Server - Optimized Performance Build
 * Versão otimizada para teste de carga máxima
 * 
 * Melhorias vs server.js original:
 * 1. Clustering (1 worker por core de CPU)
 * 2. HTTP keep-alive (conexões persistentes)
 * 3. Remoção de middlewares pesados (helmet, morgan, rate-limit)
 * 4. Cache em memória para endpoints estáticos (/health, /api/versioncheck/v4)
 * 5. SQLite WAL mode otimizado com busy timeout
 * 6. JSON response otimizado
 * 7. Logging mínimo para reduzir I/O
 */

const cluster = require('cluster');
const os = require('os');
const http = require('http');
const express = require('express');
const cors = require('cors');

const config = require('./verse-config');
const logger = require('./verse-logger');
const { initDatabase, closeDb, getDb, dbGet } = require('./verse-db');
const { buildEndpoints } = require('./verse-utils');

const numCPUs = os.cpus().length;
const PORT = config.server.port;
const HOST = config.server.host;

// ============================================================================
// Cache em memória para endpoints estáticos (alta frequência, baixa mudança)
// ============================================================================
const staticCache = new Map();

function setCache(key, value, ttlMs = 60000) {
  staticCache.set(key, { value, expires: Date.now() + ttlMs });
}

function getCache(key) {
  const entry = staticCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    staticCache.delete(key);
    return null;
  }
  return entry.value;
}

// Pré-carrega respostas estáticas
const HEALTH_RESPONSE = JSON.stringify({
  status: 'ok',
  service: 'recverse-server',
  version: '1.0.0-optimized',
  gameVersion: config.game.version,
  timestamp: new Date().toISOString(),
});

const VERSIONCHECK_RESPONSE = JSON.stringify({
  status: 'ok',
  gameVersion: config.game.version,
  supportedVersions: config.game.supportedVersions,
  rolloutVersions: config.game.rolloutVersions,
  timestamp: new Date().toISOString(),
});

// ============================================================================
// Worker process
// ============================================================================
if (cluster.isPrimary) {
  console.log(`[Primary] Iniciando ${numCPUs} workers (cores de CPU)`);
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[Primary] Worker ${worker.process.pid} finalizado. Substituindo...`);
    cluster.fork();
  });

  cluster.on('online', (worker) => {
    console.log(`[Primary] Worker ${worker.process.pid} online`);
  });
} else {
  // ============================================================================
  // Worker
  // ============================================================================
  const app = express();

  app.set('trust proxy', false);

  // Middleware mínimo - apenas CORS e JSON parsing
  app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request ID simples (sem crypto.randomUUID pesado - usa counter)
  let requestCounter = 0;
  app.use((req, res, next) => {
    req.id = ++requestCounter;
    res.setHeader('X-Request-ID', req.id);
    res.setHeader('Connection', 'keep-alive');
    next();
  });

  // ============================================================================
  // Endpoints otimizados com cache
  // ============================================================================
  app.get('/health', (req, res) => {
    const cached = getCache('health');
    if (cached) {
      res.set('Content-Type', 'application/json');
      return res.send(cached);
    }
    res.set('Content-Type', 'application/json');
    res.send(HEALTH_RESPONSE);
    setCache('health', HEALTH_RESPONSE, 5000);
  });

  app.get('/api/versioncheck/v4', (req, res) => {
    const cached = getCache('versioncheck');
    if (cached) {
      res.set('Content-Type', 'application/json');
      return res.send(cached);
    }
    res.set('Content-Type', 'application/json');
    res.send(VERSIONCHECK_RESPONSE);
    setCache('versioncheck', VERSIONCHECK_RESPONSE, 5000);
  });

  // ============================================================================
  // Importar e montar routers (mesmos do server.js original)
  // ============================================================================
  const nsRouter = require('./verse-ns');
  const accountsRouter = require('./verse-accounts');
  const authRouter = require('./verse-auth');
  const apiRouter = require('./verse-api');
  const roomsRouter = require('./verse-rooms');
  const matchRouter = require('./verse-match');
  const chatRouter = require('./verse-chat');
  const econRouter = require('./verse-econ');

  app.use('/', nsRouter);
  app.use('/accounts', accountsRouter);
  app.use('/auth', authRouter);
  app.use('/api', apiRouter);
  app.use('/rooms', roomsRouter);
  app.use('/match', matchRouter);
  app.use('/chat', chatRouter);
  app.use('/econ', econRouter);

  // Stub services
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
      const cached = getCache(`stub-${service}`);
      if (cached) {
        res.set('Content-Type', 'application/json');
        return res.send(cached);
      }
      const body = JSON.stringify({ service, status: 'ok', note: 'stub - not fully implemented' });
      res.set('Content-Type', 'application/json');
      res.send(body);
      setCache(`stub-${service}`, body, 30000);
    });
    app.use(`/${service}`, router);
  }

  // 404 handler (minimal)
  app.use((req, res) => {
    res.status(404).send(JSON.stringify({ error: 'Not found' }));
  });

  // Error handler (minimal)
  app.use((err, req, res, next) => {
    res.status(500).send(JSON.stringify({ error: 'Internal server error' }));
  });

  // ============================================================================
  // Inicializar DB e iniciar HTTP server com keep-alive
  // ============================================================================
  async function start() {
    try {
      await initDatabase();

      const server = http.createServer(app);

      // Keep-alive configurado
      server.keepAliveTimeout = 5000;
      server.headersTimeout = 5500;

      server.listen(PORT, HOST, () => {
        console.log(`[Worker ${process.pid}] Escutando em ${HOST}:${PORT}`);
      });

      // Graceful shutdown
      const shutdown = async (signal) => {
        console.log(`[Worker ${process.pid}] ${signal} recebido, encerrando...`);
        server.close(async () => {
          await closeDb();
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000);
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
      console.error(`[Worker ${process.pid}] Erro ao iniciar:`, error.message);
      process.exit(1);
    }
  }

  start();
}
