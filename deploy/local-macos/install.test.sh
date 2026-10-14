#!/bin/bash
set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/garmin-install-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/web" "$tmp/bin"
printf 'VITE_API_BASE=https://hub.example.test\n' > "$tmp/repo/web/.env.local"
printf '#!/bin/sh\nprintf "stub launchctl %%s\\n" "$*"\n' > "$tmp/bin/launchctl"
chmod +x "$tmp/bin/launchctl"
PATH="$tmp/bin:$PATH" HOME="$tmp/home" GARMIN_HUB_REPO="$tmp/repo" bash "$repo/deploy/local-macos/install.sh" --dry-run > "$tmp/output"
grep -q 'launchctl unload/load com.garminhub.web' "$tmp/output"
grep -q 'launchctl unload/load com.garminhub.offsite' "$tmp/output"
! grep -q 'launchctl unload/load com.garminhub.api' "$tmp/output"
! grep -q 'launchctl unload/load com.garminhub.ingest' "$tmp/output"
! grep -q 'launchctl unload/load com.garminhub.daily' "$tmp/output"
cat "$tmp/output"
echo "install dry run test passed"
