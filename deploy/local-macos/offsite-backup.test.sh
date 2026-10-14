#!/bin/bash
set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/garmin-offsite-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.ssh" "$tmp/home/Backups/garmin-hub/old"
touch -t 202001010000 "$tmp/home/Backups/garmin-hub/old"
touch "$tmp/home/.ssh/id_ed25519" "$tmp/home/.ssh/known_hosts"

cat > "$tmp/bin/rsync" <<'STUB'
#!/bin/bash
set -e
[ "${RSYNC_FAIL:-0}" = 0 ] || { echo "stub rsync failed" >&2; exit 23; }
for arg in "$@"; do [ "$arg" = "--dry-run" ] && exit 0; done
src=${@: -2:1}
dest=${@: -1}
case "$src" in
  *backups/) mkdir -p "$dest"; printf dump > "${dest%/}/garminhub-test.dump" ;;
  *.env) mkdir -p "$(dirname "$dest")"; printf 'private\n' > "$dest" ;;
  *.garth/) mkdir -p "$dest"; printf token > "${dest%/}/token.json" ;;
esac
STUB
cat > "$tmp/bin/ssh" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SSH_LOG"
STUB
cat > "$tmp/bin/pg_restore" <<'STUB'
#!/bin/sh
[ "$1" = "--list" ] && [ -s "$2" ]
STUB
chmod +x "$tmp/bin/rsync" "$tmp/bin/ssh" "$tmp/bin/pg_restore"

common=(env PATH="$tmp/bin:$PATH" HOME="$tmp/home" SSH_LOG="$tmp/ssh.log" GARMIN_HUB_BACKUP_ROOT="$tmp/home/Backups/garmin-hub")
"${common[@]}" "$repo/deploy/local-macos/offsite-backup.sh" --dry-run > "$tmp/dry.log"
grep -q 'Dry run complete' "$tmp/dry.log"
[ ! -s "$tmp/ssh.log" ]
cat "$tmp/dry.log"

GARMIN_HUB_SNAPSHOT_STAMP=2026-10-14T043000 "${common[@]}" "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/run.log"
snapshot="$tmp/home/Backups/garmin-hub/2026-10-14T043000"
[ "$(stat -f %Lp "$snapshot" 2>/dev/null || stat -c %a "$snapshot")" = 700 ]
[ "$(stat -f %Lp "$snapshot/deploy/droplet/.env" 2>/dev/null || stat -c %a "$snapshot/deploy/droplet/.env")" = 600 ]
grep -q 'mark offsite ok' "$tmp/ssh.log"
[ ! -d "$tmp/home/Backups/garmin-hub/old" ]

: > "$tmp/ssh.log"
set +e
RSYNC_FAIL=1 GARMIN_HUB_SNAPSHOT_STAMP=2026-10-15T043000 "${common[@]}" "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/fail.log" 2>&1
code=$?
set -e
[ "$code" -eq 23 ]
grep -q 'mark offsite fail' "$tmp/ssh.log"
[ ! -d "$tmp/home/Backups/garmin-hub/2026-10-15T043000" ]
echo "offsite backup tests passed"
