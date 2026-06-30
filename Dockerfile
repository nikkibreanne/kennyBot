# kennyBot runtime image (IMPLEMENTATION §C). Multi-stage, slim, non-root.
# Outbound-only — the bot listens on nothing, so there is no EXPOSE / -p.
#
# PRODUCTION: pin the base by digest so a rebuild is reproducible and a poisoned
# upstream tag can't silently change your base, e.g.
#   FROM node:20-bookworm-slim@sha256:<digest> AS build
# Bump it deliberately. slim (glibc), NOT alpine — firebase-admin's gRPC native
# bits make glibc the path of least resistance.

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
ENV HEARTBEAT_FILE=/tmp/kennybot.heartbeat
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app .

# Persisted refresh-token store (§F) lives on a writable volume owned by the
# non-root runtime user. /app is root-owned, so create + chown a dedicated /data
# BEFORE dropping privileges, and default the store there. Mount it at runtime
# (-v kennybot-tokens:/data) so refreshed tokens survive restarts.
ENV TOKEN_STORE_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# never run as root (comment on its own line — Dockerfile does NOT strip inline
# trailing comments; `USER node # ...` would make the whole string the username)
USER node

# File-based healthcheck (§E): no HTTP listener exists, so a port probe is
# meaningless. The bot writes a JSON snapshot {ts, version, chatConnected, live}
# to HEARTBEAT_FILE. Unhealthy = stale ts (process hung) OR chatConnected:false
# (chat socket wedged/disconnected and not recovered) — so the orchestrator
# restarts a "process alive but chat dead" zombie instead of trusting it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const fs=require('fs');const h=JSON.parse(fs.readFileSync(process.env.HEARTBEAT_FILE,'utf8'));process.exit(Date.now()-h.ts<120000&&h.chatConnected?0:1)"

# no EXPOSE — the bot listens on nothing
CMD ["node", "index.js"]
