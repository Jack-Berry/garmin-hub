#!/bin/sh
set -eu

cd /home/deploy/garmin-hub
compose="docker compose --project-name garmin-hub --env-file deploy/droplet/.env -f deploy/droplet/compose.yml"

ingest() {
  $compose exec -T app python3.13 ingest/ingest.py </dev/null
}

case "${1:-}" in
  ingest)
    ingest
    ;;
  daily)
    [ "$(TZ=Europe/London date +%H)" = "10" ] || exit 0
    ingest
    $compose exec -T app sh -c \
      'curl -sS --fail-with-body --max-time 180 -X POST http://127.0.0.1:3001/api/coach/daily -H "Content-Type: application/json" -H "X-Api-Key: $API_SECRET" -d "{}"'
    ;;
  backup)
    backup_dir=deploy/droplet/backups
    mkdir -p "$backup_dir"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    target="$backup_dir/garminhub-$stamp.dump"
    temporary="$backup_dir/.garminhub-$stamp.dump.tmp"
    trap 'rm -f "$temporary"' 0 HUP INT TERM
    $compose exec -T postgres pg_dump -U postgres -d garminhub -Fc \
      > "$temporary"
    mv "$temporary" "$target"
    trap - 0 HUP INT TERM
    find "$backup_dir" -type f -name 'garminhub-*.dump' -mtime +14 -delete
    ;;
  *)
    echo "usage: $0 ingest|daily|backup" >&2
    exit 2
    ;;
esac
