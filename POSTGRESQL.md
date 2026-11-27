# RecVerse PostgreSQL Configuration

## Opção A: Variáveis individuais (tradicional)

```env
DB_CLIENT=pg
PG_HOST=localhost
PG_PORT=5432
PG_USER=recverse
PG_PASSWORD=sua_senha
PG_DATABASE=recverse
PG_SSL=false
PG_MAX_CONNECTIONS=20
```

## Opção B: Connection string única (recomendado - mais simples)

Use uma única variável `DATABASE_URL` no formato padrão PostgreSQL:

```env
DB_CLIENT=pg
DATABASE_URL=postgresql://recverse:sua_senha@localhost:5432/recverse?ssl=true
```

### Formato da DATABASE_URL

```
postgresql://[usuario]:[senha]@[host]:[porta]/[banco]?[opcoes]
```

| Parte | Descrição | Exemplo |
|-------|-----------|---------|
| `postgresql://` | Protocolo obrigatório | `postgresql://` |
| `usuario` | Usuário do banco | `recverse` |
| `senha` | Senha do usuário | `MinhaSenha123` |
| `host` | Servidor do banco | `localhost` ou `meu-banco.render.com` |
| `porta` | Porta do PostgreSQL | `5432` |
| `banco` | Nome do banco de dados | `recverse` |
| `ssl=true` | Habilitar SSL/TLS | `?ssl=true` |

### Exemplos práticos

**Local (sem SSL):**
```env
DATABASE_URL=postgresql://recverse:senha123@localhost:5432/recverse
```

**Render.com (com SSL):**
```env
DATABASE_URL=postgresql://recverse:senha123@dpg-xxxxx-a.oregon-postgres.render.com:5432/recverse?ssl=true
```

**Neon.tech (com SSL):**
```env
DATABASE_URL=postgresql://recverse:senha123@ep-xxx-xxx.us-east-1.aws.neon.tech:5432/recverse?ssl=true
```

**Supabase (com SSL):**
```env
DATABASE_URL=postgresql://postgres:senha@db.xxx.supabase.co:5432/postgres?ssl=true
```

---

## Prioridade de configuração

Quando `DATABASE_URL` está definida, ela **sobrescreve** todas as variáveis individuais (`PG_HOST`, `PG_USER`, etc.).

Ordem de precedência:
1. `DATABASE_URL` (se começar com `postgresql://`)
2. Variáveis individuais (`PG_HOST`, `PG_USER`, `PG_PASSWORD`, etc.)
3. Valores padrão

---

## Setup do banco (SQL)

```sql
-- Criar usuário e banco
CREATE USER recverse WITH PASSWORD 'sua_senha';
CREATE DATABASE recverse OWNER recverse;
GRANT ALL PRIVILEGES ON DATABASE recverse TO recverse;

-- Conectar ao banco e conceder privilégios
\c recverse
GRANT ALL ON SCHEMA public TO recverse;
```

---

## Migrações

O servidor executa migrações automaticamente no startup. Para rodar manualmente:

```bash
node -e "require('./verse-db').initDatabase()"
```

---

## .env completo (exemplo com PostgreSQL linha única)

```env
# --- Server ---
SERVER_HOST=0.0.0.0
SERVER_PORT=3000
NODE_ENV=development
SERVER_DOMAIN=localhost
SERVER_PROTOCOL=http

# --- Database (PostgreSQL via linha única) ---
DB_CLIENT=pg
DATABASE_URL=postgresql://recverse:sua_senha@localhost:5432/recverse?ssl=false

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
