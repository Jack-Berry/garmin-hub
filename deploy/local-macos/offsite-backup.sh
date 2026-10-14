#!/bin/bash
set -Eeuo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

REMOTE=${GARMIN_HUB_REMOTE:-deploy@178.128.168.63}
REMOTE_ROOT=${GARMIN_HUB_REMOTE_ROOT:-/home/deploy/garmin-hub}
BACKUP_ROOT=${GARMIN_HUB_BACKUP_ROOT:-$HOME/Backups/garmin-hub}
SSH_KEY=${GARMIN_HUB_SSH_KEY:-$HOME/.ssh/id_ed25519}
KNOWN_HOSTS=${GARMIN_HUB_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}
APP_CONTAINER=${GARMIN_HUB_APP_CONTAINER:-garmin-hub}
GARTH_DIR=${GARMIN_HUB_GARTH_DIR:-/var/lib/garmin-hub/garth}
STAMP=${GARMIN_HUB_SNAPSHOT_STAMP:-$(date +%Y-%m-%dT%H%M%S)}
[[ "$STAMP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}$ ]] || { echo "Invalid snapshot timestamp" >&2; exit 2; }
SNAPSHOT="$BACKUP_ROOT/$STAMP"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"
dry_root=
verified=0

say() { printf '%s\n' "$*"; }

mark_remote() {
  result=$1
  message=$2
  printf -v remote_command '%q ' "$REMOTE_ROOT/deploy/droplet/jobs.sh" mark offsite "$result" "$message"
  "${SSH[@]}" "$REMOTE" "${remote_command% }"
}

failed() {
  code=$?
  # Bash 3.2 can report 0 here after an unbound-variable abort. Every success
  # path disarms this trap first, so reaching it always means failure.
  [ "$code" -ne 0 ] || code=1
  trap - EXIT
  [ -z "$dry_root" ] || rm -rf "$dry_root"
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "$verified" -eq 0 ] && [ -d "$SNAPSHOT" ]; then rm -rf "$SNAPSHOT"; fi
    mark_remote fail "offsite pull failed with exit $code" || true
  fi
  exit "$code"
}
trap failed EXIT

list_snapshots() {
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while IFS= read -r candidate; do
    name=${candidate##*/}
    if [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}$ ]]; then printf '%s\n' "$candidate"; fi
  done
}

previous=$(list_snapshots | sort | tail -1 || true)
rsync_args=(-a -e "$RSYNC_SSH")
if [ "$DRY_RUN" -eq 1 ]; then
  rsync_args+=(--dry-run --itemize-changes)
  dry_root=$(mktemp -d "${TMPDIR:-/tmp}/garmin-hub-offsite.XXXXXX")
  SNAPSHOT="$dry_root/snapshot"
  mkdir -p "$SNAPSHOT/deploy/droplet" "$SNAPSHOT/ingest/.garth"
  say "Dry run: snapshot $SNAPSHOT"
  say "Dry run: pull backups, deployment environment and Garmin token cache"
else
  umask 077
  mkdir -p "$SNAPSHOT/deploy/droplet" "$SNAPSHOT/ingest/.garth"
fi

backup_links=()
env_links=()
if [ -n "$previous" ]; then
  backup_links=(--link-dest="$previous/deploy/droplet/backups")
  env_links=(--link-dest="$previous/deploy/droplet")
fi
rsync "${rsync_args[@]}" ${backup_links[@]+"${backup_links[@]}"} \
  "$REMOTE:$REMOTE_ROOT/deploy/droplet/backups/" "$SNAPSHOT/deploy/droplet/backups/"
rsync "${rsync_args[@]}" ${env_links[@]+"${env_links[@]}"} \
  "$REMOTE:$REMOTE_ROOT/deploy/droplet/.env" "$SNAPSHOT/deploy/droplet/.env"
# The Garmin token cache lives in a Docker volume, not the checkout, so stream
# it out of the running app container.
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$SNAPSHOT/ingest/.garth"
  "${SSH[@]}" "$REMOTE" "docker exec $APP_CONTAINER tar -C $GARTH_DIR -cf - ." \
    | tar -xf - -C "$SNAPSHOT/ingest/.garth"
  [ -n "$(ls -A "$SNAPSHOT/ingest/.garth")" ] || { say "Garmin token cache is empty" >&2; exit 1; }
fi

if [ "$DRY_RUN" -eq 1 ]; then
  trap - EXIT
  rm -rf "$dry_root"
  say "Dry run complete. No snapshot or remote status was changed."
  exit 0
fi

find "$SNAPSHOT" -type d -exec chmod 700 {} +
find "$SNAPSHOT" -type f -exec chmod 600 {} +
newest=$(find "$SNAPSHOT/deploy/droplet/backups" -type f -name 'garminhub-*.dump' -size +0c -print | sort | tail -1)
[ -n "$newest" ] || { say "No non-empty database dump found" >&2; exit 1; }
sidecar="$newest.sha256"
[ -f "$sidecar" ] || { say "Checksum sidecar is missing" >&2; exit 1; }
[ "$(LC_ALL=C head -c 5 "$newest")" = PGDMP ] || { say "Newest dump has an invalid header" >&2; exit 1; }
expected=$(awk 'NR == 1 { print $1 }' "$sidecar")
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { say "Checksum sidecar is invalid" >&2; exit 1; }
actual=$(shasum -a 256 "$newest" | awk '{ print $1 }')
[ "$actual" = "$expected" ] || { say "Newest dump checksum does not match" >&2; exit 1; }
say "Newest dump header and checksum match."

verified=1
trap - EXIT
newest_snapshot=$(list_snapshots | sort | tail -1)
while IFS= read -r candidate; do
  [ "$candidate" = "$newest_snapshot" ] && continue
  name=${candidate##*/}
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}$ ]] || continue
  rm -rf "$candidate"
done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +30 -print)

if ! mark_remote ok "snapshot $STAMP complete"; then
  say "Warning: snapshot is complete but remote status could not be updated." >&2
fi
say "Offsite snapshot complete: $SNAPSHOT"
