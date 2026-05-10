#!/usr/bin/env bash
# atlas — startup script.
# Validates env, builds TypeScript, runs in iMessage mode.
# Assumes imessage-api-catalina is already running and reachable at $IMESSAGE_API_URL.

set -euo pipefail

# Bootstrap PATH for non-interactive shells (SSH, launchd, etc.)
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
[ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/atlas.log"

log()  { printf '[atlas] %s\n' "$*"; }
warn() { printf '[atlas] WARN: %s\n' "$*" >&2; }
die()  { printf '[atlas] ERROR: %s\n' "$*" >&2; exit 1; }

# Node
command -v node >/dev/null 2>&1 || die "Node.js not found. Install v18+ from https://nodejs.org or via nvm."
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required (found v${NODE_MAJOR})."

# Xcode CLI tools (better-sqlite3 native build)
xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools not installed. Run:  xcode-select --install"

# .env
ENV_FILE="$SCRIPT_DIR/.env"
[ -f "$ENV_FILE" ] || die ".env not found. Run:  cp '$SCRIPT_DIR/.env.example' '$ENV_FILE'  then fill it in."

read_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*$//' || true; }

GEMINI_KEY=$(read_env GEMINI_API_KEY)
[ -n "$GEMINI_KEY" ] && [ "$GEMINI_KEY" != "your_gemini_api_key" ] || die "GEMINI_API_KEY not set in .env"

IMESSAGE_KEY=$(read_env IMESSAGE_API_KEY)
[ -n "$IMESSAGE_KEY" ] && [ "$IMESSAGE_KEY" != "replace-me-with-server-api-key" ] \
  || die "IMESSAGE_API_KEY not set in .env (must match the imessage-api-catalina server's API_KEY)"

IMESSAGE_URL=$(read_env IMESSAGE_API_URL)
IMESSAGE_URL="${IMESSAGE_URL:-http://localhost:8787}"

# Dependencies — production only (skips tsx/esbuild, which has prebuilt
# binaries that fail to load on macOS 11 and earlier).
if [ ! -d "$SCRIPT_DIR/node_modules/better-sqlite3" ]; then
  log "Installing dependencies..."
  npm install --omit=dev --prefix "$SCRIPT_DIR"
fi

# Rebuild native modules if compiled for the wrong CPU architecture
CURRENT_ARCH=$(uname -m)
if ! node -e "var D=require('$SCRIPT_DIR/node_modules/better-sqlite3'); var d=new D(':memory:'); d.close();" 2>/dev/null; then
  log "Rebuilding better-sqlite3 for ${CURRENT_ARCH}..."
  npm rebuild better-sqlite3 --prefix "$SCRIPT_DIR" \
    || die "Rebuild failed. Try:  cd '$SCRIPT_DIR' && npm rebuild better-sqlite3"
fi

mkdir -p "$SCRIPT_DIR/data"

# Sanity check imessage-api-catalina reachability
log "Checking imessage-api-catalina at $IMESSAGE_URL ..."
if ! curl -sf --max-time 3 -H "Authorization: Bearer $IMESSAGE_KEY" "${IMESSAGE_URL}/health" >/dev/null; then
  warn "imessage-api-catalina not reachable at $IMESSAGE_URL — atlas will fail health check on startup."
  warn "Start imessage-api-catalina first, or fix IMESSAGE_API_URL / IMESSAGE_API_KEY in .env."
fi

# Build TypeScript
log "Building..."
"$SCRIPT_DIR/node_modules/.bin/tsc" -p "$SCRIPT_DIR/tsconfig.json" \
  || die "tsc build failed. Inspect the error above."

log "Starting atlas (iMessage mode). Log: $LOG_FILE"
log "Press Ctrl+C to stop. Send '/reboot' over iMessage to pull + restart."
echo ""

cd "$SCRIPT_DIR"

# Supervisor loop. Exit code 42 means "/reboot was requested" — pull latest
# code, reinstall, rebuild, and relaunch. Any other exit code stops the loop.
# ATLAS_REBOOTING is empty on the first run, "1" after a reboot — atlas reads
# this and sends a "back online!" ping to the allowlisted contact.
REBOOT_EXIT_CODE=42
ATLAS_REBOOTING=
while true; do
  set +e
  ATLAS_REBOOTING="$ATLAS_REBOOTING" node dist/index.js --mode=imessage 2>&1 | tee -a "$LOG_FILE"
  EXIT_CODE=${PIPESTATUS[0]}
  set -e

  if [ "$EXIT_CODE" -ne "$REBOOT_EXIT_CODE" ]; then
    log "atlas exited with code $EXIT_CODE — stopping."
    exit "$EXIT_CODE"
  fi

  log "Reboot requested. Pulling latest code..."
  if git -C "$SCRIPT_DIR" fetch --quiet origin; then
    git -C "$SCRIPT_DIR" reset --hard origin/main || warn "git reset failed — continuing with local copy"
  else
    warn "git fetch failed — restarting with current code"
  fi

  log "Reinstalling dependencies..."
  npm install --omit=dev --prefix "$SCRIPT_DIR" || warn "npm install failed — continuing with existing node_modules"

  log "Rebuilding..."
  if ! "$SCRIPT_DIR/node_modules/.bin/tsc" -p "$SCRIPT_DIR/tsconfig.json"; then
    warn "tsc build failed — relaunching with the previous dist/"
  fi

  ATLAS_REBOOTING=1
  log "Restarting atlas..."
  echo ""
done
