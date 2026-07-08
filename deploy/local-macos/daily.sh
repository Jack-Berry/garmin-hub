#!/bin/bash
# Garmin Hub — daily ingest + insight, run by com.garminhub.daily at 10:00.
# Ingest first; only generate the insight if ingest succeeds. All output is
# appended to ~/garmin-hub-cron.log so a silent failure (e.g. expired garth
# token needing MFA) is visible after the fact.

REPO="/Users/jackberry/Code/Projects/garmin-hub"
PYTHON="/usr/local/bin/python3.13"
LOG="$HOME/garmin-hub-cron.log"
API="http://localhost:3001"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "" >> "$LOG"
echo "========== $(ts) daily run START ==========" >> "$LOG"

# 1. Ingest. stdin from /dev/null so that, if the garth token has expired, the
#    interactive MFA prompt gets EOF and fails fast instead of hanging forever.
echo "--- [$(ts)] ingest ---" >> "$LOG"
"$PYTHON" "$REPO/ingest/ingest.py" < /dev/null >> "$LOG" 2>&1
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "--- [$(ts)] INGEST FAILED (exit $RC) — skipping insight." >> "$LOG"
  echo "    If it failed on login, the Garmin token likely expired: run" >> "$LOG"
  echo "    '$PYTHON $REPO/ingest/ingest.py' manually once to re-auth (MFA)." >> "$LOG"
  echo "========== $(ts) daily run END (failed) ==========" >> "$LOG"
  exit "$RC"
fi

# 2. Daily insight — POST to the always-on API (spends Claude credit, stored in
#    coach_notes, surfaces in the dashboard carousel). The API requires the
#    shared secret; read it from server/.env. --fail-with-body makes an HTTP
#    error (e.g. a 500 from the coach) fail the step while still logging the
#    error body, and the failure propagates to the script's exit code.
API_SECRET=$(grep -m1 '^API_SECRET=' "$REPO/server/.env" | cut -d= -f2-)
echo "--- [$(ts)] daily insight ---" >> "$LOG"
curl -sS --fail-with-body --max-time 180 -X POST "$API/api/coach/daily" \
  -H 'Content-Type: application/json' -H "X-Api-Key: $API_SECRET" -d '{}' >> "$LOG" 2>&1
CURL_RC=$?
echo "" >> "$LOG"
if [ "$CURL_RC" -ne 0 ]; then
  echo "--- [$(ts)] INSIGHT CALL FAILED (curl exit $CURL_RC) — HTTP error or API down on 3001?" >> "$LOG"
  echo "========== $(ts) daily run END (insight failed) ==========" >> "$LOG"
  exit 1
fi

echo "========== $(ts) daily run END ==========" >> "$LOG"
