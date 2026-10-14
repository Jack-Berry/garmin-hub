#!/bin/bash
# Install the Garmin Hub local always-on test deployment (macOS launchd).
# Idempotent: safe to re-run (rebuilds, recopies, reloads).
set -e

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

REPO="/Users/jackberry/Code/Projects/garmin-hub"
DEPLOY="$REPO/deploy/local-macos"
LA="$HOME/Library/LaunchAgents"
LABELS="api web daily ingest"

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

mkdir -p "$LA" "$HOME/Library/Logs"

# Hosted Mac cutover: the bundle talks to the droplet, so only the local web
# preview agent belongs on this Mac. Do not print the value because this file
# also carries the API secret in normal installations.
API_BASE="$(awk -F= '/^VITE_API_BASE=/{sub(/^[^=]*=/, ""); print; exit}' "$REPO/web/.env.local" 2>/dev/null || true)"
case "$API_BASE" in
  ""|http://localhost|http://localhost:*|https://localhost|https://localhost:*|http://127.0.0.1|http://127.0.0.1:*|https://127.0.0.1|https://127.0.0.1:*) HOSTED=0 ;;
  *) HOSTED=1 ;;
esac

if [ "$HOSTED" -eq 1 ]; then
  echo "Hosted mode: building the web bundle and restarting only com.garminhub.web."
  run_cmd bash -c "cd '$REPO/web' && npm run build"
  run_cmd cp "$DEPLOY/com.garminhub.web.plist" "$LA/"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ launchctl unload $LA/com.garminhub.web.plist (ignored if absent)"
  else
    launchctl unload "$LA/com.garminhub.web.plist" 2>/dev/null || true
  fi
  run_cmd launchctl load -w "$LA/com.garminhub.web.plist"
  echo "Hosted mode leaves api, ingest and daily untouched."
  exit 0
fi

echo "Local mode: installing and reloading api, web, daily and ingest."

echo "[1/4] Stopping any manually-started dev servers (node server.js / vite preview)…"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ pkill manual dev servers"
else
  pkill -f "node server.js" 2>/dev/null || true
  pkill -f "vite/bin/vite.js preview" 2>/dev/null || true
  pkill -f "node_modules/.bin/vite" 2>/dev/null || true
  sleep 1
fi

echo "[2/4] Building the frontend (npm run build)…"
# web/.env.local selects the API without a source edit. Use
# VITE_API_BASE=http://localhost:3001 for local API mode, or
# VITE_API_BASE=https://hub.berrydev.co.uk for the hosted backend.
run_cmd bash -c "cd '$REPO/web' && npm run build"

echo "[3/4] Installing plists into $LA …"
run_cmd cp "$DEPLOY/com.garminhub.api.plist" "$LA/"
run_cmd cp "$DEPLOY/com.garminhub.web.plist" "$LA/"
run_cmd cp "$DEPLOY/com.garminhub.daily.plist" "$LA/"
run_cmd cp "$DEPLOY/com.garminhub.ingest.plist" "$LA/"

echo "[4/4] (Re)loading launchd services…"
for l in $LABELS; do
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ launchctl unload/load com.garminhub.$l"
  else
    launchctl unload    "$LA/com.garminhub.$l.plist" 2>/dev/null || true
    launchctl load -w   "$LA/com.garminhub.$l.plist"
  fi
  echo "    loaded com.garminhub.$l"
done

echo
echo "Done. API → http://localhost:3001   Dashboard → http://localhost:4173"
echo "Check status:  launchctl list | grep garminhub"
