#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo"

test -d server/node_modules || (cd server && npm ci)
test -d web/node_modules || (cd web && npm ci)

echo "== Node syntax =="
find server -maxdepth 1 -name '*.js' -print | sort | while IFS= read -r file; do
  node --check "$file"
done

echo "== Focused server tests =="
node --test server/*.test.js

echo "== Coach trap eval dry run =="
node server/eval/coach-traps.mjs --dry-run

echo "== Secret-free web build =="
(cd web && HUB_HOSTED_BUILD=1 VITE_API_BASE= env -u VITE_API_SECRET npm run build)
if rg -n -i 'sk-ant-|api[_-]?secret[=:][A-Za-z0-9_-]{12,}|vite_api_secret[=:][A-Za-z0-9_-]{12,}' web/dist; then
  echo "web/dist contains an API secret-like value" >&2
  exit 1
fi
echo "web/dist secret scan passed"

echo "== Python syntax =="
find ingest -maxdepth 1 -name '*.py' -print | sort | \
  xargs /usr/local/bin/python3.13 -m py_compile

echo "== Garmin non-TTY login check =="
(cd ingest && /usr/local/bin/python3.13 -m unittest test_login.py)

echo "== Compose config =="
if command -v docker >/dev/null 2>&1; then
  API_SECRET=check ANTHROPIC_API_KEY=check GARMIN_EMAIL=check GARMIN_PASSWORD=check \
  POSTGRES_ADMIN_PASSWORD=check GARMINHUB_RO_PASSWORD=check GARMINHUB_RW_PASSWORD=check \
    docker compose -f deploy/droplet/compose.yml config >/dev/null
  echo "docker compose config passed"
else
  echo "SKIP: Docker is not installed"
fi

echo "== iOS Simulator build =="
(cd ios && xcodegen generate)
xcodebuild -project ios/GarminHub.xcodeproj -scheme GarminHub \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/garmin-hub-derived-data CODE_SIGNING_ALLOWED=NO \
  -quiet build

echo "full check passed"
