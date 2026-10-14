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
    ingest
    $compose exec -T app sh -c \
      'curl -sS --fail-with-body --max-time 180 -X POST http://127.0.0.1:3001/api/coach/daily -H "Content-Type: application/json" -H "X-Api-Key: $API_SECRET" -d "{}"'
    ;;
  backup)
    mkdir -p deploy/droplet/backups
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    $compose exec -T postgres pg_dump -U postgres -d garminhub -Fc \
      > "deploy/droplet/backups/garminhub-$stamp.dump"
    find deploy/droplet/backups -type f -name 'garminhub-*.dump' -mtime +14 -delete
    ;;
  *)
    echo "usage: $0 ingest|daily|backup" >&2
    exit 2
    ;;
esac
