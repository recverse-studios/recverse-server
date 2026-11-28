/**
 * RecVerse Server Configuration - Cloudflare Workers Version
 * Centralized configuration management with environment variable support
 * Uses Workers bindings (env) instead of process.env
 */

const config = {
  // Server
  server: {
    host: '0.0.0.0',
    port: 3000,
    env: 'production',
    domain: 'localhost',
    protocol: 'https',
  },

  // Database (Hyperdrive / PostgreSQL via Layerbase)
  database: {
    client: 'pg',
    // Hyperdrive binding name in wrangler.jsonc
    hyperdriveBinding: 'DB',
  },

  // JWT Authentication
  jwt: {
    secret: 'recverse-dev-secret-change-in-production',
    accessTokenTtl: 3600, // 1 hour
    refreshTokenTtl: 604800, // 7 days
    issuer: 'recverse',
    audience: 'recverse-client',
  },

  // Rate limiting
  rateLimit: {
    windowMs: 900000, // 15 minutes
    maxRequests: 100,
    authMaxRequests: 10,
  },

  // CORS
  cors: {
    origin: '*',
    credentials: true,
  },

  // Game version (February 2023 build)
  game: {
    version: '20230201',
    supportedVersions: ['20230201', '20230414', '20230616', '20231207'],
    rolloutVersions: [],
  },

  // Account limits
  accountLimits: {
    maxPerPlatformId: 3,
    maxPerIp: 3,
    maxPerDeviceId: 3,
    passwordSignupEnabled: false,
  },

  // Email (placeholder - integrate with actual email service)
  email: {
    enabled: false,
    host: '',
    port: 587,
    user: '',
    pass: '',
    from: 'noreply@recverse.local',
    sender: 'RecVerse <noreply@recverse.local>',
  },

  // Steam
  steam: {
    enabled: false,
    apiKey: '',
  },

  // Meta/Oculus
  meta: {
    enabled: false,
    appSecret: '',
  },

  // Discord
  discord: {
    enabled: false,
    clientId: '',
    clientSecret: '',
    rolloutRoleIds: [],
  },

  // Photon
  photon: {
    realtimeAppId: '',
    voiceAppId: '',
    chatAppId: '',
    nameServer: '',
    nameServerPort: 0,
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
    level: 'info',
    console: true,
  },

  // Features
  features: {
    enableImageSigning: true,
    enableTelemetry: false,
    enableEAC: true,
    enableServiceDiscovery: true,
  },
};

/**
 * Initialize config from Workers environment bindings
 * Called with the env object from the fetch handler
 */
export function initConfig(env) {
  if (env.SERVER_HOST) config.server.host = env.SERVER_HOST;
  if (env.SERVER_PORT) config.server.port = parseInt(env.SERVER_PORT, 10);
  if (env.NODE_ENV) config.server.env = env.NODE_ENV;
  if (env.SERVER_DOMAIN) config.server.domain = env.SERVER_DOMAIN;
  if (env.SERVER_PROTOCOL) config.server.protocol = env.SERVER_PROTOCOL;
  
  if (env.JWT_SECRET) config.jwt.secret = env.JWT_SECRET;
  if (env.JWT_ACCESS_TTL) config.jwt.accessTokenTtl = parseInt(env.JWT_ACCESS_TTL, 10);
  if (env.JWT_REFRESH_TTL) config.jwt.refreshTokenTtl = parseInt(env.JWT_REFRESH_TTL, 10);
  
  if (env.RATE_LIMIT_WINDOW) config.rateLimit.windowMs = parseInt(env.RATE_LIMIT_WINDOW, 10);
  if (env.RATE_LIMIT_MAX) config.rateLimit.maxRequests = parseInt(env.RATE_LIMIT_MAX, 10);
  if (env.RATE_LIMIT_AUTH_MAX) config.rateLimit.authMaxRequests = parseInt(env.RATE_LIMIT_AUTH_MAX, 10);
  
  if (env.CORS_ORIGIN) config.cors.origin = env.CORS_ORIGIN;
  
  if (env.GAME_VERSION) config.game.version = env.GAME_VERSION;
  if (env.SUPPORTED_GAME_VERSIONS) {
    config.game.supportedVersions = env.SUPPORTED_GAME_VERSIONS.split(',').map(v => v.trim());
  }
  if (env.ROLLOUT_GAME_VERSIONS) {
    config.game.rolloutVersions = env.ROLLOUT_GAME_VERSIONS.split(',').filter(Boolean).map(v => v.trim());
  }
  
  if (env.MAX_ACCOUNTS_PER_PLATFORM_ID) config.accountLimits.maxPerPlatformId = parseInt(env.MAX_ACCOUNTS_PER_PLATFORM_ID, 10);
  if (env.MAX_ACCOUNTS_PER_IP) config.accountLimits.maxPerIp = parseInt(env.MAX_ACCOUNTS_PER_IP, 10);
  if (env.MAX_ACCOUNTS_PER_DEVICE_ID) config.accountLimits.maxPerDeviceId = parseInt(env.MAX_ACCOUNTS_PER_DEVICE_ID, 10);
  if (env.PASSWORD_SIGNUP !== undefined) config.accountLimits.passwordSignupEnabled = env.PASSWORD_SIGNUP === 'true';
  
  if (env.ENABLE_IMAGE_SIGNING !== undefined) config.features.enableImageSigning = env.ENABLE_IMAGE_SIGNING !== 'false';
  if (env.ENABLE_TELEMETRY !== undefined) config.features.enableTelemetry = env.ENABLE_TELEMETRY === 'true';
  if (env.ENABLE_EAC !== undefined) config.features.enableEAC = env.ENABLE_EAC !== 'false';
  if (env.ENABLE_SERVICE_DISCOVERY !== undefined) config.features.enableServiceDiscovery = env.ENABLE_SERVICE_DISCOVERY !== 'false';
  
  if (env.LOG_LEVEL) config.logging.level = env.LOG_LEVEL;
  if (env.LOG_CONSOLE !== undefined) config.logging.console = env.LOG_CONSOLE !== 'false';
  
  // Build full URLs
  config.server.baseUrl = `${config.server.protocol}://${config.server.domain}${config.server.port !== 80 && config.server.port !== 443 ? ':' + config.server.port : ''}`;
  
  return config;
}

/**
 * Build service endpoints for discovery
 */
export function buildEndpoints(domain, subdomains = {}) {
  const SERVICE_SUBDOMAINS = {
    Accounts: 'accounts',
    AI: 'ai',
    API: 'api',
    Auth: 'auth',
    BugReporting: 'bugreporting',
    Cards: 'cards',
    CDN: 'cdn',
    Chat: 'chat',
    Clubs: 'clubs',
    CMS: 'cms',
    Commerce: 'commerce',
    Data: 'data',
    DataCollection: 'datacollection',
    Discovery: 'discovery',
    Econ: 'econ',
    GameLogs: 'gamelogs',
    Geo: 'geo',
    Images: 'img',
    Leaderboard: 'leaderboard',
    Link: 'link',
    Lists: 'lists',
    Matchmaking: 'match',
    Moderation: 'moderation',
    Notifications: 'notify',
    PlatformNotifications: 'platformnotifications',
    PlayerSettings: 'playersettings',
    RoomComments: 'roomcomments',
    RoomieIntegrations: 'roomieintegrations',
    Rooms: 'rooms',
    Storage: 'storage',
    Strings: 'strings',
    StringsCDN: 'strings-cdn',
    Studio: 'studio',
    Thorn: 'thorn',
    Videos: 'videos',
    WWW: 'www',
  };

  const protocol = config.server.protocol;
  const port = config.server.port;
  const portSuffix = (protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443) ? `:${port}` : '';
  const baseDomain = `${domain}${portSuffix}`;

  const overrides = typeof subdomains === 'string' ? JSON.parse(subdomains) : subdomains;

  return Object.fromEntries(
    Object.entries(SERVICE_SUBDOMAINS).map(([label, sub]) => [
      label,
      `${protocol}://${(overrides[sub] !== undefined && overrides[sub] !== null) ? overrides[sub] : sub}.${baseDomain}`,
    ])
  );
}

/**
 * Check if game version is supported
 * @param {string} version - Game version string
 * @returns {boolean} True if supported
 */
export function isSupportedGameVersion(version) {
  const cleanVersion = version.split('.')[0]; // Strip point release
  return config.game.supportedVersions.includes(cleanVersion);
}

/**
 * Check if game version is in rollout
 * @param {string} version - Game version string
 * @returns {boolean} True if in rollout
 */
export function isRolloutGameVersion(version) {
  const cleanVersion = version.split('.')[0]; // Strip point release
  return config.game.rolloutVersions.includes(cleanVersion);
}

/**
 * Get supported game builds
 * @returns {string[]} Array of supported version strings
 */
export function supportedGameBuilds() {
  return config.game.supportedVersions;
}

/**
 * Get rollout game builds
 * @returns {string[]} Array of rollout version strings
 */
export function rolloutGameBuilds() {
  return config.game.rolloutVersions;
}

export default config;
