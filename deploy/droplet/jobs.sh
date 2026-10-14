#!/bin/sh
set -u

cd "${GARMIN_HUB_ROOT:-/home/deploy/garmin-hub}"
compose="docker compose --project-name garmin-hub --env-file deploy/droplet/.env -f deploy/droplet/compose.yml"
status_dir=${GARMIN_HUB_STATUS_DIR:-deploy/droplet/job-status}

json_string() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

mark() {
  job=$1
  result=$2
  message=${3:-}
  mkdir -p "$status_dir" || return 1
  temporary=$(mktemp "$status_dir/.${job}.XXXXXX") || return 1
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  [ "$result" = ok ] && ok=true || ok=false
  printf '{"job":"%s","ok":%s,"finished_at":"%s","message":"%s"}\n' \
    "$(json_string "$job")" "$ok" "$finished_at" "$(json_string "$message")" \
    > "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 644 "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$status_dir/$job.json"
}

run_recorded() {
  job=$1
  shift
  output=$(mktemp "${TMPDIR:-/tmp}/garmin-hub-${job}.XXXXXX") || exit 1
  trap 'rm -f "$output"' 0 HUP INT TERM
  "$@" > "$output" 2>&1
  code=$?
  cat "$output"
  if [ "$code" -eq 0 ]; then
    mark "$job" ok "exit 0" || true
  else
    message=$(awk 'NF { line=$0 } END { print line }' "$output")
    [ -n "$message" ] || message="exit $code"
    mark "$job" fail "$message" || true
  fi
  rm -f "$output"
  trap - 0 HUP INT TERM
  return "$code"
}

run_ingest() {
  $compose exec -T app python3.13 ingest/ingest.py </dev/null
}

run_daily() {
  run_ingest || return $?
  $compose exec -T app sh -c \
    'curl -sS --fail-with-body --max-time 180 -X POST http://127.0.0.1:3001/api/coach/daily -H "Content-Type: application/json" -H "X-Api-Key: $API_SECRET" -d "{}"'
}

run_backup() {
  backup_dir=${GARMIN_HUB_BACKUP_DIR:-deploy/droplet/backups}
  mkdir -p "$backup_dir"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="$backup_dir/garminhub-$stamp.dump"
  temporary="$backup_dir/.garminhub-$stamp.dump.tmp"
  sidecar="$target.sha256"
  sidecar_temporary="$backup_dir/.garminhub-$stamp.dump.sha256.tmp"
  $compose exec -T postgres pg_dump -U postgres -d garminhub -Fc > "$temporary"
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -f "$temporary"
    return "$code"
  fi
  $compose exec -T postgres pg_restore --list < "$temporary" >/dev/null
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -f "$temporary"
    return "$code"
  fi
  hash_line=$(sha256sum "$temporary") || {
    code=$?; rm -f "$temporary" "$sidecar_temporary"; return "$code"
  }
  hash=${hash_line%% *}
  printf '%s  %s\n' "$hash" "$(basename "$target")" > "$sidecar_temporary" || {
    code=$?; rm -f "$temporary" "$sidecar_temporary"; return "$code"
  }
  mv "$sidecar_temporary" "$sidecar" || { code=$?; rm -f "$temporary" "$sidecar_temporary"; return "$code"; }
  mv "$temporary" "$target" || { code=$?; rm -f "$temporary" "$sidecar"; return "$code"; }
  find "$backup_dir" -type f -name 'garminhub-*.dump' -mtime +14 \
    -exec sh -c 'for dump do rm -f "$dump" "$dump.sha256"; done' sh {} +
}

case "${1:-}" in
  ingest)
    run_recorded ingest run_ingest
    ;;
  daily)
    [ "$(TZ=Europe/London date +%H)" = "10" ] || exit 0
    run_recorded daily run_daily
    ;;
  backup)
    run_recorded backup run_backup
    ;;
  mark)
    [ "${2:-}" = offsite ] || { echo "only the offsite status may be marked directly" >&2; exit 2; }
    case "${3:-}" in ok|fail) ;; *) echo "usage: $0 mark offsite ok|fail [message]" >&2; exit 2 ;; esac
    mark offsite "$3" "${4:-manual mark}" || exit 1
    ;;
  *)
    echo "usage: $0 ingest|daily|backup|mark offsite ok|fail [message]" >&2
    exit 2
    ;;
esac
