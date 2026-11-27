# RecVerse PostgreSQL Configuration

## Option A: Individual variables (traditional)

```env
DB_CLIENT=pg
PG_HOST=localhost
PG_PORT=5432
PG_USER=recverse
PG_PASSWORD=your_password
PG_DATABASE=recverse
PG_SSL=false
PG_MAX_CONNECTIONS=20
```

## Option B: Single connection string (recommended - simpler)

Use a single `DATABASE_URL` variable in the standard PostgreSQL format:

```env
DB_CLIENT=pg
DATABASE_URL=postgresql://recverse:your_password@localhost:5432/recverse?ssl=true
```

### DATABASE_URL Format

```
postgresql://[user]:[password]@[host]:[port]/[database]?[options]
```

| Part | Description | Example |
|------|-------------|---------|
| `postgresql://` | Required protocol | `postgresql://` |
| `user` | Database user | `recverse` |
| `password` | User password | `MyPassword123` |
| `host` | Database server | `localhost` or `my-db.render.com` |
| `port` | PostgreSQL port | `5432` |
| `database` | Database name | `recverse` |
| `ssl=true` | Enable SSL/TLS | `?ssl=true` |

### Practical Examples

**Local (no SSL):**
```env
DATABASE_URL=postgresql://recverse:password123@localhost:5432/recverse
```

**Render.com (with SSL):**
```env
DATABASE_URL=postgresql://recverse:password123@dpg-xxxxx-a.oregon-postgres.render.com:5432/recverse?ssl=true
```

**Neon.tech (with SSL):**
```env
DATABASE_URL=postgresql://recverse:password123@ep-xxx-xxx.us-east-1.aws.neon.tech:5432/recverse?ssl=true
```

**Supabase (with SSL):**
```env
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres?ssl=true
```

## Configuration Priority

When `DATABASE_URL` is defined, it **overrides** all individual variables (`PG_HOST`, `PG_USER`, `PG_PASSWORD`, etc.).

Priority order:
1. `DATABASE_URL` (if it starts with `postgresql://`)
2. Individual variables (`PG_HOST`, `PG_USER`, `PG_PASSWORD`, etc.)
3. Default values

## Database Setup (SQL)

```sql
-- Create user and database
CREATE USER recverse WITH PASSWORD 'your_password';
CREATE DATABASE recverse OWNER recverse;
GRANT ALL PRIVILEGES ON DATABASE recverse TO recverse;

-- Connect to the database and grant schema privileges
\c recverse
GRANT ALL ON SCHEMA public TO recverse;
```

## Migrations

The server runs migrations automatically on startup. To run manually:

```bash
node -e "require('./verse-db').initDatabase()"
```

## Complete .env (example with single-line PostgreSQL)

```env
# --- Server ---
SERVER_HOST=0.0.0.0
SERVER_PORT=3000
NODE_ENV=development
SERVER_DOMAIN=localhost
SERVER_PROTOCOL=http

# --- Database (PostgreSQL via single line) ---
DB_CLIENT=pg
DATABASE_URL=postgresql://recverse:your_password@localhost:5432/recverse?ssl=false

# --- JWT ---
JWT_SECRET=recverse-dev-secret-change-in-production
JWT_ACCESS_TTL=3600
JWT_REFRESH_TTL=604800

# --- Rate Limit ---
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
RATE_LIMIT_AUTH_MAX=10

# --- CORS ---
CORS_ORIGIN=*

# --- Game ---
GAME_VERSION=20230201
SUPPORTED_GAME_VERSIONS=20230201,20230414,20230616,20231207
ROLLOUT_GAME_VERSIONS=

# --- Accounts ---
MAX_ACCOUNTS_PER_PLATFORM_ID=3
MAX_ACCOUNTS_PER_IP=3
MAX_ACCOUNTS_PER_DEVICE_ID=3
PASSWORD_SIGNUP=false

# --- Email ---
EMAIL_ENABLED=false
EMAIL_HOST=
EMAIL_PORT=587
EMAIL_USER=
EMAIL_PASS=
EMAIL_FROM=noreply@recverse.local
EMAIL_SENDER=RecVerse <noreply@recverse.local>

# --- Steam ---
STEAM_ENABLED=false
STEAM_API_KEY=

# --- Meta ---
META_ENABLED=false
META_APP_SECRET=

# --- Discord ---
DISCORD_ENABLED=false
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_ROLLOUT_ROLE_IDS=

# --- Photon ---
PHOTON_REALTIME_APP_ID=
PHOTON_VOICE_APP_ID=
PHOTON_CHAT_APP_ID=
PHOTON_NAME_SERVER=
PHOTON_NAME_SERVER_PORT=0

# --- Logging ---
LOG_LEVEL=info
LOG_FILE=./verse.log
LOG_CONSOLE=true

# --- Features ---
ENABLE_IMAGE_SIGNING=true
ENABLE_TELEMETRY=false
ENABLE_EAC=true
```
