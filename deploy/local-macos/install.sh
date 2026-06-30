#!/bin/bash
# Install the Garmin Hub local always-on test deployment (macOS launchd).
# Idempotent: safe to re-run (rebuilds, recopies, reloads).
set -e

REPO="/Users/jackberry/Code/Projects/garmin-hub"
DEPLOY="$REPO/deploy/local-macos"
LA="$HOME/Library/LaunchAgents"
LABELS="api web daily"

mkdir -p "$LA" "$HOME/Library/Logs"

echo "[1/4] Stopping any manually-started dev servers (node server.js / vite preview)…"
pkill -f "node server.js" 2>/dev/null || true
pkill -f "vite/bin/vite.js preview" 2>/dev/null || true
pkill -f "node_modules/.bin/vite" 2>/dev/null || true
sleep 1

echo "[2/4] Building the frontend (npm run build)…"
( cd "$REPO/web" && npm run build )

echo "[3/4] Installing plists into $LA …"
cp "$DEPLOY"/com.garminhub.api.plist   "$LA/"
cp "$DEPLOY"/com.garminhub.web.plist   "$LA/"
cp "$DEPLOY"/com.garminhub.daily.plist "$LA/"

echo "[4/4] (Re)loading launchd services…"
for l in $LABELS; do
  launchctl unload    "$LA/com.garminhub.$l.plist" 2>/dev/null || true
  launchctl load -w   "$LA/com.garminhub.$l.plist"
  echo "    loaded com.garminhub.$l"
done

echo
echo "Done. API → http://localhost:3001   Dashboard → http://localhost:4173"
echo "Check status:  launchctl list | grep garminhub"
