# syntax=docker/dockerfile:1

# Bauen: Frontend mit allen Entwicklungsabhängigkeiten
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Nur Laufzeit-Abhängigkeiten (reines JavaScript, daher auf der Bau-Plattform möglich)
FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /src
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Laufzeit: Node-Backend liefert API und gebautes Frontend aus
FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/zappotex/bonys-agents-mission-control" \
      org.opencontainers.image.description="Bony's Agents Mission Control" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./
COPY server ./server
COPY config ./config
COPY profiles ./profiles
RUN mkdir -p /app/data/profiles && chown -R node:node /app/data

ENV NODE_ENV=production \
    MISSION_CONTROL_API_HOST=0.0.0.0 \
    MISSION_CONTROL_API_PORT=8787 \
    MISSION_CONTROL_DATA_DIR=/app/data

USER node
VOLUME /app/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1

CMD ["node", "server/server.mjs"]
