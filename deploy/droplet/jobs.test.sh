#!/bin/bash
set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/garmin-jobs-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/status"

cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
if [ "${DOCKER_FAIL:-0}" = 1 ]; then
  echo "stubbed job failure" >&2
  exit 9
fi
case "$*" in *pg_dump*) printf 'database dump\n' ;; *) echo "stubbed job success" ;; esac
STUB
cat > "$tmp/bin/date" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "+%H" ]; then printf '%s\n' "${FAKE_HOUR:-10}"; else /bin/date "$@"; fi
STUB
chmod +x "$tmp/bin/docker" "$tmp/bin/date"

run_job() {
  PATH="$tmp/bin:$PATH" GARMIN_HUB_ROOT="$repo" GARMIN_HUB_STATUS_DIR="$tmp/status" "$repo/deploy/droplet/jobs.sh" "$@"
}

run_job ingest >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="ingest"||!s.ok)process.exit(1)' "$tmp/status/ingest.json"

FAKE_HOUR=10 run_job daily >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="daily"||!s.ok)process.exit(1)' "$tmp/status/daily.json"

set +e
DOCKER_FAIL=1 run_job backup >"$tmp/failure.log" 2>&1
code=$?
set -e
[ "$code" -eq 9 ]
node -e 'const s=require(process.argv[1]); if(s.job!=="backup"||s.ok||!/stubbed job failure/.test(s.message))process.exit(1)' "$tmp/status/backup.json"

printf '{"job":"daily","ok":true,"finished_at":"2000-01-01T00:00:00Z","message":"old"}\n' > "$tmp/status/daily.json"
FAKE_HOUR=09 run_job daily >/dev/null
grep -q '2000-01-01' "$tmp/status/daily.json"

run_job mark offsite ok pulled >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="offsite"||!s.ok||s.message!=="pulled")process.exit(1)' "$tmp/status/offsite.json"
echo "jobs.sh status tests passed"
