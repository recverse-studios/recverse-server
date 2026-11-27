# RecVerse Server

Monolithic Node.js server implementation for Rec Room private server, compatible with the February 2023 client build.

## Architecture

```
recverse-server/
├── server.js                 # Main entry point
├── package.json              # Dependencies
├── verse-config.js           # Configuration management
├── verse-logger.js           # Centralized logging
├── verse-db.js               # SQLite database with migrations
├── verse-utils.js            # Shared utilities
├── verse-auth-middleware.js  # JWT authentication & account management
├── verse-ns.js               # Service discovery (Name Server)
├── verse-accounts.js         # Account management & profiles
├── verse-auth.js             # OAuth2 authentication & tokens
├── verse-api.js              # Main game API endpoints
├── verse-rooms.js            # Room & subroom management
├── verse-match.js            # Matchmaking & presence
├── verse-chat.js             # Chat system
├── verse-econ.js             # Economy & storefront
├── database/                 # SQLite database files
├── migrations/               # Database migrations
├── tests/                    # Test files
└── .reference/               # RecFlare reference (cloned)
```

## Services Implemented

| Service | Path | Status |
|---------|------|--------|
| Name Server (NS) | `/` | ✅ Full |
| Accounts | `/accounts` | ✅ Full |
| Auth | `/auth` | ✅ Full |
| API | `/api` | ✅ Full |
| Rooms | `/rooms` | ✅ Full |
| Matchmaking | `/match` | ✅ Full |
| Chat | `/chat` | ✅ Full |
| Economy | `/econ` | ✅ Full |
| CDN | `/cdn` | 🔧 Stub |
| Images | `/img` | 🔧 Stub |
| Notifications | `/notify` | 🔧 Stub |
| Leaderboard | `/leaderboard` | 🔧 Stub |
| ... | ... | 🔧 Stub |

## Requirements

- Node.js 20+
- SQLite3 (bundled via better-sqlite3)

## Installation

```bash
cd recverse-server
npm install
```

## Configuration

Environment variables (or `.env` file):

```env
# Server
SERVER_HOST=0.0.0.0
SERVER_PORT=3000
SERVER_DOMAIN=localhost
SERVER_PROTOCOL=http

# Database
DB_PATH=./database/recverse.db

# JWT
JWT_SECRET=your-secret-key-change-in-production
JWT_ACCESS_TTL=3600
JWT_REFRESH_TTL=604800

# Game Version
GAME_VERSION=20230201
SUPPORTED_GAME_VERSIONS=20230201,20230414,20230616,20231207
ROLLOUT_GAME_VERSIONS=

# Account Limits
MAX_ACCOUNTS_PER_PLATFORM_ID=3
MAX_ACCOUNTS_PER_IP=3
MAX_ACCOUNTS_PER_DEVICE_ID=3
PASSWORD_SIGNUP=false

# Email (optional)
EMAIL_ENABLED=false
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=user
EMAIL_PASS=pass
EMAIL_FROM=noreply@recverse.local

# Steam (optional)
STEAM_ENABLED=false
STEAM_API_KEY=

# Meta/Oculus (optional)
META_ENABLED=false
META_APP_SECRET=

# Discord (optional)
DISCORD_ENABLED=false
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_ROLLOUT_ROLE_IDS=

# Photon
PHOTON_REALTIME_APP_ID=
PHOTON_VOICE_APP_ID=
PHOTON_CHAT_APP_ID=
PHOTON_NAME_SERVER=
PHOTON_NAME_SERVER_PORT=0

# Logging
LOG_LEVEL=info
LOG_FILE=./verse.log
LOG_CONSOLE=true
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Service Discovery
- `GET /` - Service endpoint map

### Accounts
- `GET /accounts/emojiConfig/whitelistedEmojis`
- `GET /accounts/account/me` - Self account (auth required)
- `GET /accounts/account/search?name=prefix`
- `GET /accounts/account/username/:name`
- `GET /accounts/account/:id`
- `GET /accounts/account/bulk?id=1&id=2`
- `POST /accounts/account/create`
- `PUT /accounts/account/me/displayname`
- `PUT /accounts/account/me/username`
- `POST /accounts/account/me/email`
- `PUT /accounts/account/me/profileimage`
- `PUT /accounts/account/me/bannerimage`
- `PUT /accounts/account/me/emoji`
- `PUT /accounts/account/me/bio`
- `PUT /accounts/account/me/identityflags`
- `PUT /accounts/account/me/personalpronouns`

### Auth
- `POST /auth/connect/token` - OAuth2 token (password, cached_login, refresh_token, identity_assertion, device_code)
- `GET /auth/eac/challenge`
- `GET/POST /auth/cachedlogin/forplatformid/:platform/:id`
- `POST /auth/cachedlogin/forplatformids`
- `POST /auth/connect/deviceauthorization`
- `POST /auth/account/recoverpassword`
- `POST /auth/account/resetpassword`
- `POST /auth/account/changepassword`

### API
- `GET /api/versioncheck/v4`
- `GET /api/images/v5/player/:id`
- `GET /api/images/v4/player/:id`
- `GET /api/images/v3/feed/player/:id`
- `GET /api/images/v4/room/:roomId`
- `POST /api/sanitize/v1/isPure`
- `POST /api/PlayerCheer/v1/create`
- `POST /api/PlayerCheer/v1/SetSelectedCheer`
- `GET /api/PlayerCheer/v1/GetCheerCounts`
- `POST /api/PlayerReporting/v1/moderationBlockDetails`
- `POST /api/PlayerReporting/v3/voteToKick`
- `POST /api/chatreport/createChatReport`
- `POST /api/relationships/v2/sendfriendrequest`
- `POST /api/relationships/v2/acceptfriendrequest`
- `GET /api/customAvatarItems/v1/bulk`
- `GET /api/customAvatarItems/v1/search`
- `GET /api/customAvatarItems/:id`

### Rooms
- `GET /rooms/:id`
- `POST /rooms`
- `PUT /rooms/:id`
- `DELETE /rooms/:id`
- `POST /rooms/:id/clone`
- `GET /rooms/:id/subrooms/:sid/data`
- `POST /rooms/:id/subrooms/:sid/data`
- `POST /rooms/:id/subrooms/:sid/publish_save`
- `GET /rooms/:id/saves`
- `GET /rooms/:id/saves/:saveId`
- `PUT /rooms/:id/loadscreen`
- `PUT /rooms/:id/description`
- `PUT /rooms/:id/subrooms/:sid/accessibility`
- `PUT /rooms/:id/accessibility`

### Matchmaking
- `GET /match/matchmake/room/:roomId/:subRoomId`
- `POST /match/matchmake/room/:roomId/:subRoomId`
- `GET /match/matchmake/quick`
- `POST /match/matchmake/heartbeat`
- `POST /match/matchmake/leave`
- `GET /match/presence/:accountId`
- `POST /match/presence/bulk`
- `GET /match/photon/config`

### Economy
- `GET /econ/api/storefronts/v4/balance/:type`
- `POST /econ/api/storefronts/v4/purchase`
- `POST /econ/api/items/bulkpurchase`
- `GET /econ/api/avatar/v2/gifts`
- `POST /econ/api/avatar/v2/gifts/open`
- `GET /econ/econ/customAvatarItems/v1/owned`
- `GET /econ/econ/inventory`

## Database Schema

The server uses SQLite with the following main tables:
- `accounts` - User accounts
- `refresh_tokens` - OAuth refresh tokens
- `platform_links` - Platform identity links (Steam, Meta, Discord)
- `email_codes` - Email verification codes
- `rate_limits` - Rate limiting counters
- `presence` - Player presence/location
- `rooms` - Room definitions
- `subrooms` - Subroom definitions
- `subroom_saves` - Room save data
- `chat_messages` - Chat history
- `balances` - Currency balances
- `inventory` - Player inventory
- `custom_avatar_items` - Custom avatar items
- `custom_avatar_item_ownership` - Item ownership
- `notifications` - Player notifications
- `player_settings` - Player settings
- `room_comments` - Room comments
- `reports` - Moderation reports
- `bans` - Account bans
- `audit_logs` - Audit trail
- `leaderboard_scores` - Leaderboard entries
- `saved_images` - Player images
- `clubs` - Clubs/groups
- `club_members` - Club membership
- `two_factor` - 2FA settings
- `login_challenges` - Login challenges
- `studio_device_grants` - Studio device auth
- `unity_assets` - Unity asset bundles

## Development

### Adding a New Service

1. Create `verse-<service>.js` in root with Express router
2. Mount in `server.js`: `app.use('/<service>', require('./verse-<service>'))`
3. Add to `SERVICE_SUBDOMAINS` in `verse-ns.js` for service discovery
4. Implement endpoints matching RecFlare API

### Running Tests

```bash
npm test
```

## License

MIT