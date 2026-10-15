#!/bin/bash
set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
real_sha256sum=$(command -v sha256sum)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/garmin-jobs-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/status" "$tmp/backups"

cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [ "${DOCKER_FAIL:-0}" = 1 ]; then
  echo "stubbed job failure" >&2
  exit 9
fi
case "$*" in
  */api/coach/*) curl "$@" ;;
  *pg_dump*) printf 'PGDMPstub database dump\n' ;;
  *pg_restore*)
    cat >/dev/null
    if [ "${DOCKER_LIST_FAIL:-0}" = 1 ]; then echo "stubbed archive rejection" >&2; exit 7; fi
    ;;
  *) echo "stubbed job success" ;;
esac
STUB
cat > "$tmp/bin/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$CURL_LOG"
echo '{"ok":true}'
STUB
cat > "$tmp/bin/date" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "+%H" ]; then
  printf '%s\n' "${FAKE_HOUR:-10}"
elif [ "${1:-}" = "+%u" ]; then
  printf '%s\n' "${FAKE_WEEKDAY:-7}"
elif [ "${1:-}" = "-u" ] && [ "${2:-}" = "+%Y%m%dT%H%M%SZ" ] && [ -n "${FAKE_STAMP:-}" ]; then
  printf '%s\n' "$FAKE_STAMP"
else
  /bin/date "$@"
fi
STUB
cat > "$tmp/bin/sha256sum" <<'STUB'
#!/bin/sh
[ "${SHA256_FAIL:-0}" = 1 ] && exit 11
"$REAL_SHA256SUM" "$@"
STUB
cat > "$tmp/bin/mv" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$MV_LOG"
/bin/mv "$@"
STUB
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/date" "$tmp/bin/sha256sum" "$tmp/bin/mv"
: > "$tmp/docker.log"
: > "$tmp/curl.log"
: > "$tmp/mv.log"

run_job() {
  PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" GARMIN_HUB_ROOT="$repo" \
    MV_LOG="$tmp/mv.log" CURL_LOG="$tmp/curl.log" REAL_SHA256SUM="$real_sha256sum" \
    GARMIN_HUB_STATUS_DIR="$tmp/status" GARMIN_HUB_BACKUP_DIR="$tmp/backups" \
    "$repo/deploy/droplet/jobs.sh" "$@"
}

run_job ingest >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="ingest"||!s.ok)process.exit(1)' "$tmp/status/ingest.json"
node -e 'const s=require(process.argv[1]); if(s.job!=="debrief"||!s.ok)process.exit(1)' "$tmp/status/debrief.json"
grep -q '/api/coach/debriefs/pending' "$tmp/docker.log"
grep -q '/api/coach/debriefs/pending' "$tmp/curl.log"

FAKE_HOUR=10 run_job daily >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="daily"||!s.ok)process.exit(1)' "$tmp/status/daily.json"

set +e
DOCKER_FAIL=1 FAKE_STAMP=20261014T030000Z run_job backup >"$tmp/failure.log" 2>&1
code=$?
set -e
[ "$code" -eq 9 ]
node -e 'const s=require(process.argv[1]); if(s.job!=="backup"||s.ok||!/stubbed job failure/.test(s.message))process.exit(1)' "$tmp/status/backup.json"

FAKE_STAMP=20261014T031500Z run_job backup >/dev/null
dump="$tmp/backups/garminhub-20261014T031500Z.dump"
[ -s "$dump" ]
[ -s "$dump.sha256" ]
grep -q 'pg_restore --list' "$tmp/docker.log"
expected=$(sha256sum "$dump" | awk '{print $1}')
[ "$(awk 'NR == 1 {print $1}' "$dump.sha256")" = "$expected" ]
sidecar_line=$(grep -n 'garminhub-20261014T031500Z.dump.sha256' "$tmp/mv.log" | tail -1 | cut -d: -f1)
dump_line=$(grep -n 'garminhub-20261014T031500Z.dump$' "$tmp/mv.log" | tail -1 | cut -d: -f1)
[ "$sidecar_line" -lt "$dump_line" ]

set +e
SHA256_FAIL=1 FAKE_STAMP=20261014T032000Z run_job backup >"$tmp/hash-failure.log" 2>&1
code=$?
set -e
[ "$code" -eq 11 ]
[ ! -e "$tmp/backups/garminhub-20261014T032000Z.dump" ]
[ ! -e "$tmp/backups/garminhub-20261014T032000Z.dump.sha256" ]

set +e
DOCKER_LIST_FAIL=1 FAKE_STAMP=20261014T033000Z run_job backup >"$tmp/list-failure.log" 2>&1
code=$?
set -e
[ "$code" -eq 7 ]
[ ! -e "$tmp/backups/garminhub-20261014T033000Z.dump" ]
[ ! -e "$tmp/backups/garminhub-20261014T033000Z.dump.sha256" ]
node -e 'const s=require(process.argv[1]); if(s.ok||!/archive rejection/.test(s.message))process.exit(1)' "$tmp/status/backup.json"

printf '{"job":"daily","ok":true,"finished_at":"2000-01-01T00:00:00Z","message":"old"}\n' > "$tmp/status/daily.json"
FAKE_HOUR=09 run_job daily >/dev/null
grep -q '2000-01-01' "$tmp/status/daily.json"

FAKE_WEEKDAY=7 FAKE_HOUR=19 run_job weekly >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="weekly"||!s.ok)process.exit(1)' "$tmp/status/weekly.json"
grep -q '/api/coach/weekly' "$tmp/docker.log"
grep -q '/api/coach/weekly' "$tmp/curl.log"

printf '{"job":"weekly","ok":true,"finished_at":"2000-01-01T00:00:00Z","message":"old"}\n' > "$tmp/status/weekly.json"
FAKE_WEEKDAY=6 FAKE_HOUR=19 run_job weekly >/dev/null
grep -q '2000-01-01' "$tmp/status/weekly.json"
FAKE_WEEKDAY=7 FAKE_HOUR=18 run_job weekly >/dev/null
grep -q '2000-01-01' "$tmp/status/weekly.json"

run_job mark offsite ok pulled >/dev/null
node -e 'const s=require(process.argv[1]); if(s.job!=="offsite"||!s.ok||s.message!=="pulled")process.exit(1)' "$tmp/status/offsite.json"

control=$'line\n\t\033[31m"bad"\\value'
run_job mark offsite fail "$control" >/dev/null
node -e 'const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8"); const s=JSON.parse(raw); if(/[\x00-\x1f]/.test(s.message)||s.message!==`line[31m"bad"\\value`)process.exit(1)' "$tmp/status/offsite.json"
echo "jobs.sh status tests passed"
