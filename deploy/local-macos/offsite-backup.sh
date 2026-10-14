#!/bin/bash
set -Eeuo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

REMOTE=${GARMIN_HUB_REMOTE:-deploy@178.128.168.63}
REMOTE_ROOT=${GARMIN_HUB_REMOTE_ROOT:-/home/deploy/garmin-hub}
BACKUP_ROOT=${GARMIN_HUB_BACKUP_ROOT:-$HOME/Backups/garmin-hub}
SSH_KEY=${GARMIN_HUB_SSH_KEY:-$HOME/.ssh/id_ed25519}
KNOWN_HOSTS=${GARMIN_HUB_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}
STAMP=${GARMIN_HUB_SNAPSHOT_STAMP:-$(date +%Y-%m-%dT%H%M%S)}
[[ "$STAMP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}$ ]] || { echo "Invalid snapshot timestamp" >&2; exit 2; }
SNAPSHOT="$BACKUP_ROOT/$STAMP"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"
dry_root=

say() { printf '%s\n' "$*"; }

mark_remote() {
  result=$1
  message=$2
  "${SSH[@]}" "$REMOTE" "$REMOTE_ROOT/deploy/droplet/jobs.sh" mark offsite "$result" "$message"
}

failed() {
  code=$?
  trap - EXIT
  [ -z "$dry_root" ] || rm -rf "$dry_root"
  if [ "$DRY_RUN" -eq 0 ]; then
    [ ! -d "$SNAPSHOT" ] || rm -rf "$SNAPSHOT"
    mark_remote fail "offsite pull failed with exit $code" || true
  fi
  exit "$code"
}
trap failed EXIT

previous=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1 || true)
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
garth_links=()
if [ -n "$previous" ]; then
  backup_links=(--link-dest="$previous/deploy/droplet/backups")
  env_links=(--link-dest="$previous/deploy/droplet")
  garth_links=(--link-dest="$previous/ingest/.garth")
fi
rsync "${rsync_args[@]}" "${backup_links[@]}" \
  "$REMOTE:$REMOTE_ROOT/deploy/droplet/backups/" "$SNAPSHOT/deploy/droplet/backups/"
rsync "${rsync_args[@]}" "${env_links[@]}" \
  "$REMOTE:$REMOTE_ROOT/deploy/droplet/.env" "$SNAPSHOT/deploy/droplet/.env"
rsync "${rsync_args[@]}" "${garth_links[@]}" \
  "$REMOTE:$REMOTE_ROOT/ingest/.garth/" "$SNAPSHOT/ingest/.garth/"

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
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$newest" >/dev/null
  say "Verified newest dump with pg_restore."
else
  say "pg_restore is unavailable, so archive verification was skipped."
fi

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
mark_remote ok "snapshot $STAMP verified"
trap - EXIT
say "Offsite snapshot complete: $SNAPSHOT"
