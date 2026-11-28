/**
 * RecVerse Server Configuration
 * Centralized configuration management with environment variable support
 */

import 'dotenv/config';

const config = {
  // Server
  server: {
    host: process.env.SERVER_HOST || '0.0.0.0',
    port: parseInt(process.env.SERVER_PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
    domain: process.env.SERVER_DOMAIN || 'localhost',
    protocol: process.env.SERVER_PROTOCOL || 'http',
  },

  // Database
  database: {
    client: process.env.DB_CLIENT || 'sqlite3', // 'sqlite3' or 'pg'
    path: process.env.DB_PATH || './database/recverse.db',
    migrationsPath: './migrations',
    // PostgreSQL settings (used when DB_CLIENT=pg)
    // Can be set individually OR via DATABASE_URL connection string
    pgHost: process.env.PG_HOST || 'localhost',
    pgPort: parseInt(process.env.PG_PORT || '5432', 10),
    pgUser: process.env.PG_USER || 'postgres',
    pgPassword: process.env.PG_PASSWORD || '',
    pgDatabase: process.env.PG_DATABASE || 'recverse',
    pgSsl: process.env.PG_SSL === 'true',
    pgMaxConnections: parseInt(process.env.PG_MAX_CONNECTIONS || '20', 10),
    // Single connection string (overrides individual settings above)
    // Example: postgresql://user:password@localhost:5432/recverse?ssl=true
    databaseUrl: process.env.DATABASE_URL || '',
  },

  // JWT Authentication
  jwt: {
    secret: process.env.JWT_SECRET || 'recverse-dev-secret-change-in-production',
    accessTokenTtl: parseInt(process.env.JWT_ACCESS_TTL || '3600', 10), // 1 hour
    refreshTokenTtl: parseInt(process.env.JWT_REFRESH_TTL || '604800', 10), // 7 days
    issuer: 'recverse',
    audience: 'recverse-client',
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '900000', 10), // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    authMaxRequests: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10', 10),
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },

  // Game version (February 2023 build)
  game: {
    version: process.env.GAME_VERSION || '20230201',
    supportedVersions: (process.env.SUPPORTED_GAME_VERSIONS || '20230201,20230414,20230616,20231207').split(','),
    rolloutVersions: (process.env.ROLLOUT_GAME_VERSIONS || '').split(',').filter(Boolean),
  },

  // Account limits
  accountLimits: {
    maxPerPlatformId: parseInt(process.env.MAX_ACCOUNTS_PER_PLATFORM_ID || '3', 10),
    maxPerIp: parseInt(process.env.MAX_ACCOUNTS_PER_IP || '3', 10),
    maxPerDeviceId: parseInt(process.env.MAX_ACCOUNTS_PER_DEVICE_ID || '3', 10),
    passwordSignupEnabled: process.env.PASSWORD_SIGNUP === 'true',
  },

  // Email (placeholder - integrate with actual email service)
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    host: process.env.EMAIL_HOST || '',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || 'noreply@recverse.local',
    sender: process.env.EMAIL_SENDER || 'RecVerse <noreply@recverse.local>',
  },

  // Steam
  steam: {
    enabled: process.env.STEAM_ENABLED === 'true',
    apiKey: process.env.STEAM_API_KEY || '',
  },

  // Meta/Oculus
  meta: {
    enabled: process.env.META_ENABLED === 'true',
    appSecret: process.env.META_APP_SECRET || '',
  },

  // Discord
  discord: {
    enabled: process.env.DISCORD_ENABLED === 'true',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    rolloutRoleIds: (process.env.DISCORD_ROLLOUT_ROLE_IDS || '').split(',').filter(Boolean),
  },

  // Photon
  photon: {
    realtimeAppId: process.env.PHOTON_REALTIME_APP_ID || '',
    voiceAppId: process.env.PHOTON_VOICE_APP_ID || '',
    chatAppId: process.env.PHOTON_CHAT_APP_ID || '',
    nameServer: process.env.PHOTON_NAME_SERVER || '',
    nameServerPort: parseInt(process.env.PHOTON_NAME_SERVER_PORT || '0', 10),
  },

  // Economy
  econ: {
    currencyTypes: {
      tokens: 2,
      tickets: 1,
      gold: 100,
      silver: 101,
    },
    defaultPlatform: -2, // NonPurchasedNotUsableInP2P
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './verse.log',
    console: process.env.LOG_CONSOLE !== 'false',
  },

  // Features
  features: {
    enableImageSigning: process.env.ENABLE_IMAGE_SIGNING !== 'false',
    enableTelemetry: process.env.ENABLE_TELEMETRY === 'true',
    enableEAC: process.env.ENABLE_EAC !== 'false',
    enableServiceDiscovery: true,
  },
};

// Build full URLs
config.server.baseUrl = `${config.server.protocol}://${config.server.domain}${config.server.port !== 80 && config.server.port !== 443 ? ':' + config.server.port : ''}`;

export default config;