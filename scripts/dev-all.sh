#!/usr/bin/env bash
#
# dev-all — launch the whole local stack in one terminal:
#   1. the Firebase database emulator  (data 127.0.0.1:9000, UI http://localhost:4001)
#   2. the website via Jekyll          (http://localhost:4000 — add ?dev to use the emulator)
#   3. the interactive bot chat console (type ! commands, see the bot reply)
#
# The emulator is owned by `firebase emulators:exec`, which keeps it up for the
# life of the console and tears it down on exit; Jekyll runs in the background and
# is stopped when you /quit the console (or Ctrl-C). Data is EPHEMERAL — a fresh,
# empty DB each run (seed it with chat commands or the console's /scenario).
#
#   npm run dev:all           # or:  bash scripts/dev-all.sh
#   SITE_DIR=/path/to/site npm run dev:all      # if the website isn't at ~/git/nikkibreanne.github.io
#
# Or run the automated end-to-end command suite against a fresh emulator DB (no
# website, no console) — a thorough regression check that every command still works:
#   npm run dev:all -- test    # (or: bash scripts/dev-all.sh test)  ==  npm run test:e2e
#
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${SITE_DIR:-$HOME/git/nikkibreanne.github.io}"
JEKYLL_LOG="${TMPDIR:-/tmp}/kennybot-dev-jekyll.log"

# Make the locally-installed firebase-tools resolvable even when run directly.
PATH="$BOT_DIR/node_modules/.bin:$PATH"
# Ensure bundler is reachable (user gem bin isn't always on PATH).
if ! command -v bundle >/dev/null 2>&1; then
  for d in "$HOME/.local/share/gem/ruby/"*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
fi

# ── E2E mode (`dev:all test`): run the automated command suite against a fresh
#    emulator DB and exit — no website, no interactive console. ────────────────
if [ "${1:-}" = "test" ] || [ "${1:-}" = "--e2e" ]; then
  echo "▶ E2E: driving every command through the dispatcher against a fresh emulator DB…"
  cd "$BOT_DIR"
  exec firebase emulators:exec --only database --project okrafans "node --test test/e2e/commands.e2e.test.js"
fi

SITE_PID=""
cleanup() {
  echo
  echo "▶ shutting down…"
  # SIGINT (not TERM): Jekyll traps it gracefully, like Ctrl-C — no stack trace.
  [ -n "$SITE_PID" ] && kill -INT "$SITE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

# ── website (background) ────────────────────────────────────────────────────
if [ -d "$SITE_DIR" ] && command -v bundle >/dev/null 2>&1; then
  echo "▶ website → http://localhost:4000  (logs: $JEKYLL_LOG)"
  ( cd "$SITE_DIR" && exec bundle exec jekyll serve ) >"$JEKYLL_LOG" 2>&1 &
  SITE_PID=$!
elif [ ! -d "$SITE_DIR" ]; then
  echo "⚠ website skipped — no site repo at $SITE_DIR (set SITE_DIR=… to point at it)."
else
  echo "⚠ website skipped — 'bundle' not found (install bundler, or launch Jekyll yourself)."
fi

cat <<'EOF'
▶ emulator DB → 127.0.0.1:9000  (the console + website ?dev both talk to it)
▶ open any page with ?dev to read the local emulator, e.g. http://localhost:4000/?dev
▶ in the console: ! runs chat commands · /as <name> [sub] [mod] switches identity · /help · /quit
EOF
echo

# ── emulator + interactive chat console (foreground) ────────────────────────
# emulators:exec owns the emulator; when the console exits, the emulator is torn
# down and the EXIT trap stops Jekyll.
cd "$BOT_DIR"
firebase emulators:exec --only database --project okrafans "node scripts/dev-console.js"
