# ============================================================
# RecVerse Server - Dockerfile
# Deploy: Northflank
# Node.js + Express + PostgreSQL
# ============================================================

FROM node:20-alpine

# Instalar dependências do sistema para native modules (sqlite3, pg)
RUN apk add --no-cache python3 make g++

# Diretório de trabalho
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copiar código fonte
COPY . .

# Expor porta
EXPOSE 3000

# Variável de ambiente padrão (pode ser sobrescrita no Northflank)
ENV NODE_ENV=production
ENV SERVER_PORT=3000
ENV SERVER_HOST=0.0.0.0

# Comando de inicialização
CMD ["node", "server.js"]
