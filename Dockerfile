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
USER node                                  # never run as root

# File-based healthcheck (§E): no HTTP listener exists, so a port probe is
# meaningless. The bot touches HEARTBEAT_FILE on each Twitch keepalive; if it
# goes stale the process is a "connected but socket dead" zombie a restart fixes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const fs=require('fs');const f=process.env.HEARTBEAT_FILE;const age=Date.now()-Number(fs.readFileSync(f,'utf8'));process.exit(age<120000?0:1)"

# no EXPOSE — the bot listens on nothing
CMD ["node", "index.js"]
