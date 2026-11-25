# API + tableau de bord des équipes Pause. Image unique servie derrière le proxy de Coolify.

# ---- Construction ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

COPY . .
RUN npx prisma generate \
 && npm run build \
 && cd web && npm run build

# ---- Exécution ----
FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY prisma ./prisma
COPY prisma.config.ts ./

# Installateurs Windows envoyés depuis /admin (volume persistant, voir docker-compose.yml)
ENV DOWNLOADS_DIR=/app/downloads
RUN mkdir -p /app/downloads && chown node:node /app/downloads

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Applique les migrations en attente, puis démarre le serveur
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
