#!/bin/bash
set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/garmin-offsite-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.ssh" \
  "$tmp/home/Backups/garmin-hub/2020-01-01T043000" \
  "$tmp/home/Backups/garmin-hub/keep-non-snapshot"
touch -t 202001010000 "$tmp/home/Backups/garmin-hub/2020-01-01T043000" \
  "$tmp/home/Backups/garmin-hub/keep-non-snapshot"
touch "$tmp/home/.ssh/id_ed25519" "$tmp/home/.ssh/known_hosts"

cat > "$tmp/bin/rsync" <<'STUB'
#!/bin/bash
set -e
[ "${RSYNC_FAIL:-0}" = 0 ] || { echo "stub rsync failed" >&2; exit 23; }
for arg in "$@"; do [ "$arg" = "--dry-run" ] && exit 0; done
src=${@: -2:1}
dest=${@: -1}
case "$src" in
  *backups/)
    mkdir -p "$dest"
    if [ "${BAD_HEADER:-0}" = 1 ]; then printf 'BAD!!dump' > "${dest%/}/garminhub-test.dump"
    else printf 'PGDMPdump' > "${dest%/}/garminhub-test.dump"; fi
    hash=$(shasum -a 256 "${dest%/}/garminhub-test.dump" | awk '{print $1}')
    [ "${BAD_HASH:-0}" = 0 ] || hash=0000000000000000000000000000000000000000000000000000000000000000
    printf '%s  garminhub-test.dump\n' "$hash" > "${dest%/}/garminhub-test.dump.sha256"
    ;;
  *.env) mkdir -p "$(dirname "$dest")"; printf 'private\n' > "$dest" ;;
esac
STUB
cat > "$tmp/bin/ssh" <<'STUB'
#!/bin/bash
remote_command=${@: -1}
eval "set -- $remote_command"
if [ "$1" = docker ]; then
  mkdir -p "$SSH_LOG.garth" && printf token > "$SSH_LOG.garth/garmin_tokens.json"
  exec tar -C "$SSH_LOG.garth" -cf - .
fi
{
  for arg in "$@"; do printf '[%s]' "$arg"; done
  printf '\n'
} >> "$SSH_LOG"
if [ "${SSH_FAIL_OK:-0}" = 1 ] && [ "${4:-}" = ok ]; then exit 44; fi
STUB
chmod +x "$tmp/bin/rsync" "$tmp/bin/ssh"

common=(env PATH="$tmp/bin:$PATH" HOME="$tmp/home" SSH_LOG="$tmp/ssh.log" GARMIN_HUB_BACKUP_ROOT="$tmp/home/Backups/garmin-hub")
"${common[@]}" "$repo/deploy/local-macos/offsite-backup.sh" --dry-run > "$tmp/dry.log"
grep -q 'Dry run complete' "$tmp/dry.log"
[ ! -s "$tmp/ssh.log" ]
cat "$tmp/dry.log"

# First run: no earlier snapshot, so the --link-dest lists are empty. This
# must work under the system /bin/bash 3.2 that launchd uses.
GARMIN_HUB_SNAPSHOT_STAMP=2026-10-13T043000 env PATH="$tmp/bin:$PATH" HOME="$tmp/home" SSH_LOG="$tmp/ssh.log" \
  GARMIN_HUB_BACKUP_ROOT="$tmp/first" /bin/bash "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/first.log"
[ -f "$tmp/first/2026-10-13T043000/deploy/droplet/.env" ]
[ -f "$tmp/first/2026-10-13T043000/ingest/.garth/garmin_tokens.json" ]
grep -Fq '[mark][offsite][ok][snapshot 2026-10-13T043000 complete]' "$tmp/ssh.log"
: > "$tmp/ssh.log"

GARMIN_HUB_SNAPSHOT_STAMP=2026-10-14T043000 "${common[@]}" "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/run.log"
snapshot="$tmp/home/Backups/garmin-hub/2026-10-14T043000"
[ "$(stat -f %Lp "$snapshot" 2>/dev/null || stat -c %a "$snapshot")" = 700 ]
[ "$(stat -f %Lp "$snapshot/deploy/droplet/.env" 2>/dev/null || stat -c %a "$snapshot/deploy/droplet/.env")" = 600 ]
grep -Fq '[/home/deploy/garmin-hub/deploy/droplet/jobs.sh][mark][offsite][ok][snapshot 2026-10-14T043000 complete]' "$tmp/ssh.log"
grep -q 'header and checksum match' "$tmp/run.log"
[ ! -d "$tmp/home/Backups/garmin-hub/2020-01-01T043000" ]
[ -d "$tmp/home/Backups/garmin-hub/keep-non-snapshot" ]

: > "$tmp/ssh.log"
set +e
RSYNC_FAIL=1 GARMIN_HUB_SNAPSHOT_STAMP=2026-10-15T043000 "${common[@]}" "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/fail.log" 2>&1
code=$?
set -e
[ "$code" -eq 23 ]
grep -Fq '[/home/deploy/garmin-hub/deploy/droplet/jobs.sh][mark][offsite][fail][offsite pull failed with exit 23]' "$tmp/ssh.log"
[ ! -d "$tmp/home/Backups/garmin-hub/2026-10-15T043000" ]

: > "$tmp/ssh.log"
SSH_FAIL_OK=1 GARMIN_HUB_SNAPSHOT_STAMP=2026-10-16T043000 "${common[@]}" \
  "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/mark-warning.log" 2>&1
[ -d "$tmp/home/Backups/garmin-hub/2026-10-16T043000" ]
grep -q 'Warning: snapshot is complete' "$tmp/mark-warning.log"
grep -Fq '[/home/deploy/garmin-hub/deploy/droplet/jobs.sh][mark][offsite][ok][snapshot 2026-10-16T043000 complete]' "$tmp/ssh.log"
! grep -q '\[fail\]' "$tmp/ssh.log"

for mode in BAD_HEADER BAD_HASH; do
  : > "$tmp/ssh.log"
  stamp=2026-10-17T043000
  [ "$mode" = BAD_HASH ] && stamp=2026-10-18T043000
  set +e
  env "$mode=1" GARMIN_HUB_SNAPSHOT_STAMP="$stamp" "${common[@]}" \
    "$repo/deploy/local-macos/offsite-backup.sh" > "$tmp/$mode.log" 2>&1
  code=$?
  set -e
  [ "$code" -eq 1 ]
  [ ! -d "$tmp/home/Backups/garmin-hub/$stamp" ]
  grep -q '\[fail\]' "$tmp/ssh.log"
done
echo "offsite backup tests passed"
