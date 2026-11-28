# RecVerse Server - Cloudflare Workers

Monolithic Node.js/Cloudflare Workers server for Rec Room private server (February 2023 build).
Runs on **Cloudflare Workers** with **Layerbase PostgreSQL** via Hyperdrive.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Rec Room      │────▶│  Cloudflare      │────▶│   Hyperdrive    │
│   Client        │     │   Workers        │     │   (PostgreSQL)  │
│   (Feb 2023)    │     │   Runtime        │     │   (Layerbase)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Architecture Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Cloudflare Workers | Serverless execution |
| Router | Hono.js | Express-compatible routing |
| Database | PostgreSQL via Hyperdrive | Persistent storage via Layerbase |
| Auth | JWT + bcryptjs | Authentication |
| Rate Limiting | Cloudflare KV | Request rate limiting |
| WebSockets | Not supported | Use separate service |

## Files

```
recverse-server/
├── wrangler.jsonc          # Workers configuration
├── package.json            # Dependencies
├── .dev.vars.example       # Example environment variables
├── src/
│   ├── index.js            # Workers entry point (fetch handler)
│   ├── config.js           # Configuration from env bindings
│   ├── db/
│   │   └── hyperdrive.js   # Database layer (Hyperdrive/PostgreSQL)
│   ├── auth/
│   │   ├── jwt.js          & JWT token generation/verification
│   │   └── middleware.js   & Auth middleware
│   └── routes/
│       ├── accounts.js     & Account management
│       ├── auth.js         & OAuth2 authentication
│       ├── api.js          & Game API (images, cheers, etc.)
│       ├── rooms.js        & Room management
│       ├── match.js        & Matchmaking
│       ├── chat.js         & Chat system
│       ├── econ.js         & Economy
│       ├── ns.js           & Name Server (discovery)
│       └── admin.js        & Admin commands
├── migrations/
│   └── 001_core_tables.sql # PostgreSQL schema
├── tests/
│   └── index.test.js       & Workers tests
├── Dockerfile              # Docker build (alternative)
├── docker-compose.yml      # Local Docker Compose
├── .dockerignore           & Docker ignore
├── .gitignore              & Git ignore
├── README.md               & This file
├── POSTGRESQL.md           & PostgreSQL setup guide
├── IMPLEMENTATION_STATUS.md& Implementation status
└── SERVER_SERVICES.md      & Service documentation
```

## Requirements

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account with Workers enabled
- PostgreSQL database (Layerbase or any provider)
- Cloudflare Hyperdrive (for database connection pooling)

## Installation

```bash
cd recverse-server
npm install
```

## Configuration

### 1. Copy environment variables

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your values:

```env
# Database (required)
DATABASE_URL=postgresql://user:password@host:5432/database?sslmode=require

# JWT (required - change in production!)
JWT_SECRET=your-super-secret-key-change-this

# Server
SERVER_DOMAIN=your-worker.workers.dev
SERVER_PROTOCOL=https
```

### 2. Configure Hyperdrive (for Layerbase PostgreSQL)

Create a Hyperdrive database in Cloudflare dashboard:

```bash
# Create Hyperdrive config
wrangler hyperdrive create recverse-db \
  --connection-string="postgresql://user:password@host:5432/database?sslmode=require"
```

Then add the Hyperdrive binding to `wrangler.jsonc`:

```json
{
  "hyperdrive": [
    {
      "binding": "DB",
      "hyperdrive_id": "<your-hyperdrive-id>"
    }
  ]
}
```

## Development

### Local Development

```bash
# Start local development server
npx wrangler dev

# Server will be available at http://localhost:8787
```

### Deploy to Cloudflare Workers

```bash
# Deploy to Cloudflare Workers
npx wrangler deploy

# Set secrets (do this once)
npx wrangler secret put JWT_SECRET
npx wrangler secret put DATABASE_URL
```

## API Endpoints

### Service Discovery
- `GET /` - Service endpoint map
- `GET /health` - Health check

### Authentication (`/auth`)
- `POST /auth/connect/token` - OAuth2 token
- `GET /auth/eac/challenge` - EAC challenge

### Accounts (`/accounts`)
- `POST /account/create` - Create account
- `GET /account/me` - Get account
- `PUT /account/me/displayname` - Update display name
- `PUT /account/me/username` - Update username

### API (`/api`)
- `GET /api/versioncheck/v4` - Version check
- `GET /api/images/v5/player/:id` - Player images
- `POST /api/PlayerCheer/v1/create` - Send cheer

### Rooms (`/rooms`)
- `GET /rooms/:id` - Get room
- `POST /rooms` - Create room
- `PUT /rooms/:id` - Update room

### Matchmaking (`/match`)
- `POST /match/matchmake/room/:roomId/:subRoomId` - Matchmake
- `GET /match/presence/:accountId` - Get presence

### Chat (`/chat`)
- `POST /chat/send` - Send message
- `GET /chat/history` - Get chat history

### Economy (`/econ`)
- `GET /econ/api/storefronts/v4/balance/:type` - Get balance
- `GET /econ/customAvatarItems/v1/owned` - Owned items

### Admin (`/admin`)
- `POST /admin/maintenance/start` - Start maintenance
- `POST /admin/maintenance/cancel` - Cancel maintenance
- `GET /admin/maintenance/status` - Maintenance status
- `POST /admin/broadcast` - Broadcast message

## Database Schema

The server uses the following tables (auto-created via migrations):

- `accounts` - User accounts
- `refresh_tokens` - OAuth refresh tokens
- `platform_links` - Platform identity links
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
- `notifications` - Player notifications
- `player_settings` - Player settings
- `reports` - Moderation reports
- `bans` - Account bans
- `audit_logs` - Audit trail
- `leaderboard_scores` - Leaderboard entries
- `saved_images` - Player images
- `clubs` - Clubs/groups
- `club_members` - Club membership

## Client Compatibility

The Rec Room February 2023 client expects:

| Endpoint | Method | Status |
|----------|--------|--------|
| `/` | GET | ✅ Service discovery |
| `/health` | GET | ✅ Health check |
| `/auth/connect/token` | POST | ✅ OAuth2 token |
| `/account/create` | POST | ✅ Account creation |
| `/account/me` | GET | ✅ Get account |
| `/api/versioncheck/v4` | GET | ✅ Version check |
| `/rooms/:id` | GET | ✅ Get room |

## Known Limitations

1. **WebSockets**: Not supported in standard Workers. Photon networking and real-time chat require a separate WebSocket service (use Cloudflare Durable Objects or external WebSocket server).

2. **Rate Limiting**: Currently uses in-memory storage. For production, use Cloudflare KV for distributed rate limiting.

3. **File Uploads**: Image uploads require external storage (R2, S3, etc.). Images are stored as metadata only.

4. **File System**: No file system access in Workers. Logging is console-only.

5. **SQLite**: Original SQLite support removed. PostgreSQL via Hyperdrive is required.

## Deployment Instructions

### Deploy to Cloudflare Workers

```bash
# 1. Install Wrangler
npm install -g wrangler

# 2. Login to Cloudflare
wrangler login

# 3. Set secrets (do this once)
wrangler secret put JWT_SECRET
wrangler secret put DATABASE_URL

# 4. Deploy
wrangler deploy
```

### Deploy via Docker (Alternative)

```bash
docker build -t recverse-server .
docker run -p 3000:3000 -e DATABASE_URL="..." -e JWT_SECRET="..." recverse-server
```

## License

MIT
