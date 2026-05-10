#!/usr/bin/env bash
# Atlas iMessage bot — startup script
# Compatible with macOS High Sierra (10.13) and Node.js 16+

set -euo pipefail

# ── Bootstrap PATH for non-interactive shells (SSH, launchd, etc.) ────────────
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# nvm
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
# Homebrew (Apple Silicon)
[ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/atlas.log"
IMESSAGE_API_DIR="$HOME/Desktop/iMessage-API"
IMESSAGE_API_LOG="$HOME/Desktop/imessage-api.log"
IMESSAGE_API_PID_FILE="$SCRIPT_DIR/.imessage-api.pid"

log()  { printf '[atlas] %s\n' "$*"; }
warn() { printf '[atlas] WARN: %s\n' "$*" >&2; }
die()  { printf '[atlas] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Node.js ───────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  die "Node.js not found. Install via https://nodejs.org or nvm (v18+ recommended)."
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 16 ]; then
  die "Node.js 16+ is required (found v${NODE_MAJOR}). Please upgrade."
fi
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js v${NODE_MAJOR} detected — v18+ is recommended for full compatibility."
fi

# ── Xcode CLI tools (needed to compile better-sqlite3) ───────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  die "Xcode Command Line Tools not installed. Run:  xcode-select --install"
fi

# ── .env file ────────────────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  die ".env not found. Run:  cp '$SCRIPT_DIR/.env.example' '$ENV_FILE'  then fill in your keys."
fi

GEMINI_KEY=$(grep -E '^GEMINI_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)
if [ -z "$GEMINI_KEY" ] || [ "$GEMINI_KEY" = "your_gemini_api_key" ]; then
  die "GEMINI_API_KEY is not set in .env"
fi

# Read IMESSAGE_API_KEY from Atlas .env; if missing, borrow it from the API server's .env
IMESSAGE_KEY=$(grep -E '^IMESSAGE_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)
if [ -z "$IMESSAGE_KEY" ] || [ "$IMESSAGE_KEY" = "change-me" ]; then
  IMESSAGE_API_ENV="$IMESSAGE_API_DIR/.env"
  if [ -f "$IMESSAGE_API_ENV" ]; then
    IMESSAGE_KEY=$(grep -E '^API_KEY=' "$IMESSAGE_API_ENV" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)
    if [ -n "$IMESSAGE_KEY" ]; then
      log "Borrowing API key from $IMESSAGE_API_ENV"
      # Persist into Atlas .env so future runs don't need to borrow it
      if grep -qE '^IMESSAGE_API_KEY=' "$ENV_FILE" 2>/dev/null; then
        sed -i '' "s|^IMESSAGE_API_KEY=.*|IMESSAGE_API_KEY=${IMESSAGE_KEY}|" "$ENV_FILE"
      else
        echo "IMESSAGE_API_KEY=${IMESSAGE_KEY}" >> "$ENV_FILE"
      fi
    fi
  fi
fi

if [ -z "$IMESSAGE_KEY" ]; then
  die "IMESSAGE_API_KEY not found. Add  IMESSAGE_API_KEY=<key>  to $ENV_FILE  (must match API_KEY in the iMessage API server's .env)"
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/node_modules/better-sqlite3" ]; then
  log "Installing dependencies (compiling native modules, may take ~1 min)..."
  npm install --prefix "$SCRIPT_DIR"
fi

# ── Rebuild native modules if compiled for the wrong CPU architecture ─────────
# Must instantiate Database (not just require) to force the native binary load
CURRENT_ARCH=$(uname -m)
if ! node -e "
  try {
    var D = require('$SCRIPT_DIR/node_modules/better-sqlite3');
    var db = new D(':memory:'); db.close();
  } catch(e) { process.exit(1); }
" 2>/dev/null; then
  log "better-sqlite3 native binary is wrong architecture — rebuilding for ${CURRENT_ARCH}..."
  npm rebuild better-sqlite3 --prefix "$SCRIPT_DIR" \
    || die "Rebuild failed. Try manually:  cd '$SCRIPT_DIR' && npm rebuild better-sqlite3"
  log "Rebuild complete."
else
  log "better-sqlite3 OK (${CURRENT_ARCH})"
fi

# ── Data directory ────────────────────────────────────────────────────────────
mkdir -p "$SCRIPT_DIR/data"

# ── iMessage API: start it if not already running ────────────────────────────
API_URLS="http://localhost:5000,http://192.168.0.49:5000"
IMESSAGE_API_URL=""

check_api() {
  local url
  for url in $(echo "$API_URLS" | tr ',' '\n'); do
    if curl -sf --max-time 2 "${url}/recent_contacts?num_contacts=1" \
         -H "api-key: ${IMESSAGE_KEY}" >/dev/null 2>&1; then
      IMESSAGE_API_URL="$url"
      return 0
    fi
  done
  return 1
}

if check_api; then
  log "iMessage API already running at: $IMESSAGE_API_URL"
else
  if [ -d "$IMESSAGE_API_DIR" ]; then
    log "Starting iMessage API from $IMESSAGE_API_DIR ..."
    log "iMessage API log: $IMESSAGE_API_LOG"
    (cd "$IMESSAGE_API_DIR" && npm start >> "$IMESSAGE_API_LOG" 2>&1) &
    echo $! > "$IMESSAGE_API_PID_FILE"
    log "Waiting for iMessage API to be ready..."
    sleep 4

    if check_api; then
      log "iMessage API ready at: $IMESSAGE_API_URL"
    else
      warn "iMessage API did not respond after 4 s — Atlas will retry internally."
      warn "Check $IMESSAGE_API_LOG for errors."
    fi
  else
    warn "iMessage API directory not found at $IMESSAGE_API_DIR — Atlas will retry internally."
  fi
fi

# ── Build TypeScript ──────────────────────────────────────────────────────────
log "Building TypeScript..."
if ! "$SCRIPT_DIR/node_modules/.bin/tsc" -p "$SCRIPT_DIR/tsconfig.json"; then
  warn "tsc build failed — trying tsx fallback (requires Node 18+)..."
  echo ""
  exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/src/index.ts" --mode=imessage
fi

# ── Launch ────────────────────────────────────────────────────────────────────
log "Starting Atlas (iMessage mode)..."
log "Allowed contact : +61432089147 / 0432089147"
log "Apple ID        : atlas@thejungle.cloud"
log "Log file        : $LOG_FILE"
log "Press Ctrl+C to stop."
echo ""

cd "$SCRIPT_DIR"
node dist/index.js --mode=imessage 2>&1 | tee -a "$LOG_FILE"
