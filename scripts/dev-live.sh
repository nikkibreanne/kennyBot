#!/usr/bin/env bash
#
# dev-live — run the REAL bot against a live Twitch channel for local testing,
# backed by a throwaway Firebase emulator DB. Safe against production:
#   • emulator DB  → no writes to prod game state
#   • no single-instance-lease fight with the faraday bot (separate, empty DB)
#   • separate token store (.tokens-dev) that BOOTSTRAPS from .env's
#     TWITCH_BOT_REFRESH_TOKEN — so re-issued scopes (e.g. clips:edit) take effect
#     without touching the prod token file. Re-issued the token? `rm -rf .tokens-dev`.
#
#   npm run dev:live                 # channel = $DEV_CHANNEL or scasplte2
#   npm run dev:live -- yourchannel  # or pass a channel
#
# Then: go live, wait ~45s for the Helix live-poll, and try !clip / !start in chat.
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BOT_DIR"

CHANNEL="${1:-${DEV_CHANNEL:-scasplte2}}"
export TWITCH_CHANNEL="$CHANNEL"
export TWITCH_BROADCASTER_REFRESH_TOKEN=""            # broadcaster EventSub is prod-only → Helix poll here
export TOKEN_STORE_DIR="${TOKEN_STORE_DIR:-./.tokens-dev}"

echo "▶ local bot → #$CHANNEL   (emulator DB — ephemeral; Ctrl-C to stop)"
echo "▶ token store: $TOKEN_STORE_DIR   (seeded from .env; rm -rf it to re-bootstrap new scopes)"
echo "▶ go live, wait ~45s for the live-poll, then try !clip / !start in chat"
echo

exec ./node_modules/.bin/firebase emulators:exec --only database --project okrafans "node index.js"
