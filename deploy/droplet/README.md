# Droplet deployment

The production checkout lives at `/home/deploy/garmin-hub`. Compose project
`garmin-hub` runs the Node and Python application plus Postgres 17. Postgres is
private to the compose project. The app has no host port and is reachable only
by `edge-caddy` on `connect-remote_default`.

## First deploy

1. Point `hub.berrydev.co.uk` at the droplet. Add `Caddyfile.snippet` to the
   edge Caddy configuration, validate it, and reload Caddy using droplet-edge's
   guide.
2. Put the repository at `/home/deploy/garmin-hub`, then create its environment:

   ```sh
   cd /home/deploy/garmin-hub/deploy/droplet
   cp .env.example .env
   secret=$(openssl rand -hex 32)
   sed -i "s|^API_SECRET=.*|API_SECRET=$secret|" .env
   unset secret
   # Set the remaining values. Use openssl rand -hex 32 for all DB passwords.
   chmod 600 .env
   ```

   Create an Apple Push Notification service key for team `ZZ2RVM493V`, copy
   it to `deploy/droplet/secrets/AuthKey.p8`, and set `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_TOPIC`, and `APNS_HOST` in `.env`. Keep the key at
   mode 600. The Compose app mounts it read-only at `/run/secrets/AuthKey.p8`.
   If the key or configuration is absent, notification events remain in the
   outbox and `/api/status` reports notifications disabled.

3. Start the project from the repository root. The first Postgres start creates
   `garminhub_ro`, `garminhub_rw`, and the canonical schema.

   ```sh
   cd /home/deploy/garmin-hub
   docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
     -f deploy/droplet/compose.yml up -d --build
   docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
     -f deploy/droplet/compose.yml ps
   ```

4. Verify the gate. The first request must return 401 and the second 200:

   ```sh
   curl -o /dev/null -sS -w '%{http_code}\n' https://hub.berrydev.co.uk/
   set -a; . deploy/droplet/.env; set +a
   curl -o /dev/null -sS -w '%{http_code}\n' \
     -H "X-Api-Key: $API_SECRET" https://hub.berrydev.co.uk/api/health
   unset API_SECRET
   ```

## Garmin token cache

The named volume `garmin-hub-garth-cache` is mounted at the configured
`TOKENSTORE`. Copy the existing cache to a temporary `.garth` directory beside
the droplet checkout, then import it without printing its contents:

```sh
docker run --rm -v garmin-hub-garth-cache:/dest -v "$PWD/.garth:/source:ro" \
  alpine:3.21 sh -c 'cp -a /source/. /dest/ && chown -R 65532:65532 /dest'
rm -rf .garth
```

The temporary copy contains credentials. Transfer it securely, remove it after
the import, and never commit it.

## Re-authorising Garmin

Cron has no interactive terminal, so an expired Garmin session fails quickly
and marks the dashboard update status as failed. Re-authorise on the Mac, where
MFA can be entered, then copy the refreshed cache to the droplet:

1. From the repository root on the Mac, run
   `/usr/local/bin/python3.13 ingest/ingest.py` in a terminal and complete any
   Garmin MFA prompt. A successful login refreshes `ingest/.garth` through the
   garminconnect library.
2. Securely copy the `ingest/.garth` directory to a temporary `.garth`
   directory beside the droplet checkout. Do not print, inspect, or commit its
   contents.
3. Run the volume import command in the Garmin token cache section above.
4. Remove the temporary droplet copy, then let the next cron run verify the
   session. The dashboard status should return to healthy after that run.

## Move local data

The hosted schema comes only from `db/schema.pg.sql`. Dump data from the Mac,
copy the dump to the droplet, and restore it after the first compose start:

```sh
pg_dump -h localhost -d garminhub --data-only -Fc \
  -f garminhub-data.dump
scp garminhub-data.dump deploy@178.128.168.63:/home/deploy/garmin-hub/
```

```sh
cd /home/deploy/garmin-hub
docker exec garmin-hub-postgres psql -U postgres -d garminhub \
  -c 'TRUNCATE profile'
docker cp garminhub-data.dump garmin-hub-postgres:/tmp/data.dump
docker exec garmin-hub-postgres pg_restore -U postgres -d garminhub \
  --data-only --disable-triggers /tmp/data.dump
docker exec garmin-hub-postgres rm /tmp/data.dump
rm garminhub-data.dump
```

Do this before hosted ingest starts. The source dump can be retained off the
droplet as a migration checkpoint.

## Cron and backups

Install these entries with `crontab -e` as `deploy`. This host stays on UTC
because it also runs other projects. Debian cron ignores `CRON_TZ`, so the
daily job is invoked at both possible UTC hours and proceeds only when the
London hour is 10. It runs ingest first and skips the brief if ingest fails.
All HTTP errors fail the brief step.

```cron
17 1-23/2 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh ingest >> /home/deploy/garmin-hub/ingest.log 2>&1
0 9,10 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh daily >> /home/deploy/garmin-hub/daily.log 2>&1
0 18,19 * * 0 /home/deploy/garmin-hub/deploy/droplet/jobs.sh weekly >> /home/deploy/garmin-hub/weekly.log 2>&1
15 3 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh backup >> /home/deploy/garmin-hub/backup.log 2>&1
```

Backups are custom-format `pg_dump` files under `deploy/droplet/backups`. The
backup job lists each new archive with the Postgres 17 container's `pg_restore`
before publishing it, then writes a matching `.sha256` sidecar. Dumps and
sidecars older than 14 days are removed together. Copy backups off the droplet
and test a restore periodically.

Each host job writes its latest result atomically under
`deploy/droplet/job-status`. The app sees that directory at
`/run/garmin-hub-status` and the backups directory at
`/var/lib/garmin-hub/backups`; both mounts are read-only. The key-gated
`GET /api/status` endpoint combines these files with `ingest_state`, today's
daily coach note, and the newest dump. `GET /api/health` also verifies the read
database pool, so a database outage makes the container health check fail.
The ingest job requests capped post-run debriefs only after a successful pull.
The weekly cron is invoked at both possible UTC hours and `jobs.sh` proceeds
only on Sunday at 19:00 Europe/London. Missing debrief or weekly status files
remain unknown until each job has run once.

The Mac offsite pull records its result through the narrow direct command:

```sh
deploy/droplet/jobs.sh mark offsite ok "snapshot complete"
deploy/droplet/jobs.sh mark offsite fail "pull failed"
```

For offsite failure notifications, export `GARMIN_HUB_API_URL` and
`API_SECRET` in the offsite job environment. Other hosted job failures call
the same key-gated notification endpoint from inside the app container.

Do not use `mark` for ingest, daily, or backup. Those commands own their own
status. A skipped daily invocation outside the 10:00 London hour leaves the
previous status untouched.

### Restore from a Mac snapshot

Mac snapshots live under `~/Backups/garmin-hub/<timestamp>`. Choose a snapshot
whose pull completed successfully. First copy its dump and private files to
temporary paths on the droplet without printing their contents:

```sh
snapshot="$HOME/Backups/garmin-hub/<timestamp>"
scp "$snapshot/deploy/droplet/backups/<backup>.dump" \
  deploy@178.128.168.63:/home/deploy/garmin-hub/restore.dump
scp "$snapshot/deploy/droplet/.env" \
  deploy@178.128.168.63:/home/deploy/garmin-hub/.env.restore
rsync -a -e ssh "$snapshot/ingest/.garth/" \
  deploy@178.128.168.63:/home/deploy/garmin-hub/.garth-restore/
```

Then run this complete sequence on the droplet from the repository root. It
stops the app, preserves the current database, recreates the database, applies
the canonical schema, restores the snapshot, restores `.env` and `.garth` with
private modes, then starts and verifies the app:

```sh
docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
  -f deploy/droplet/compose.yml stop app
deploy/droplet/jobs.sh backup
docker exec garmin-hub-postgres dropdb -U postgres garminhub
docker exec garmin-hub-postgres createdb -U postgres garminhub
docker exec -i garmin-hub-postgres psql -U postgres -d garminhub \
  < db/schema.pg.sql
docker exec garmin-hub-postgres psql -U postgres -d garminhub \
  -c 'TRUNCATE profile'
docker cp restore.dump garmin-hub-postgres:/tmp/restore.dump
docker exec garmin-hub-postgres pg_restore -U postgres -d garminhub \
  --data-only --disable-triggers /tmp/restore.dump
install -m 600 .env.restore deploy/droplet/.env
docker run --rm -v garmin-hub-garth-cache:/dest \
  -v "$PWD/.garth-restore:/source:ro" alpine:3.21 sh -c \
  'find /dest -mindepth 1 -delete && cp -a /source/. /dest/ && chown -R 65532:65532 /dest && find /dest -type d -exec chmod 700 {} + && find /dest -type f -exec chmod 600 {} +'
docker exec garmin-hub-postgres rm /tmp/restore.dump
rm restore.dump .env.restore
rm -rf .garth-restore
# The restored GARMINHUB_RO_PASSWORD and GARMINHUB_RW_PASSWORD must match the
# passwords already assigned to the live Postgres roles. Align them before app
# starts (safe psql variable quoting keeps password text out of the SQL):
set -a; . deploy/droplet/.env; set +a
docker exec -i garmin-hub-postgres psql -U postgres -d postgres \
  -v ro_password="$GARMINHUB_RO_PASSWORD" \
  -v rw_password="$GARMINHUB_RW_PASSWORD" <<'SQL'
ALTER ROLE garminhub_ro PASSWORD :'ro_password';
ALTER ROLE garminhub_rw PASSWORD :'rw_password';
SQL
unset GARMINHUB_RO_PASSWORD GARMINHUB_RW_PASSWORD
docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
  -f deploy/droplet/compose.yml up -d app
set -a; . deploy/droplet/.env; set +a
curl --fail --silent --show-error -H "X-Api-Key: $API_SECRET" \
  https://hub.berrydev.co.uk/api/health
unset API_SECRET
```

For a database-only restore, stop the app, preserve a fresh dump, recreate the
database, apply the canonical schema, remove its one seeded row, then restore
data only:

```sh
docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
  -f deploy/droplet/compose.yml stop app
deploy/droplet/jobs.sh backup
docker exec garmin-hub-postgres dropdb -U postgres garminhub
docker exec garmin-hub-postgres createdb -U postgres garminhub
docker exec -i garmin-hub-postgres psql -U postgres -d garminhub \
  < db/schema.pg.sql
docker exec garmin-hub-postgres psql -U postgres -d garminhub \
  -c 'TRUNCATE profile'
docker cp deploy/droplet/backups/<backup>.dump garmin-hub-postgres:/tmp/restore.dump
docker exec garmin-hub-postgres pg_restore -U postgres -d garminhub \
  --data-only --disable-triggers /tmp/restore.dump
docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
  -f deploy/droplet/compose.yml start app
```

For a full replacement restore, create a fresh Postgres volume first. Never
delete the current volume until its backup has been copied and verified.

## Update and rollback

Before each update, run `jobs.sh backup`. Pull the selected revision, then:

```sh
docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
  -f deploy/droplet/compose.yml up -d --build
docker compose --project-name garmin-hub --env-file deploy/droplet/.env \
  -f deploy/droplet/compose.yml ps
```

Rollback by checking out the previous known-good commit and running the same
`up -d --build` command. This keeps both named volumes. A database restore is
separate and should only be used when the application rollback needs it.

## Mac cutover and local development

After hosted data, ingest, and cron are verified, unload the local API, ingest,
and daily agents. Keep `com.garminhub.web` loaded so `localhost:4173` remains
the Mac dashboard. In gitignored `web/.env.local`, set:

```dotenv
VITE_API_BASE=https://hub.berrydev.co.uk
VITE_API_SECRET=<same production API secret>
```

Run `bash deploy/local-macos/install.sh`. With a non-local `VITE_API_BASE`, the
installer detects hosted mode and rebuilds/restarts only the web agent. It never
copies or loads the local API, ingest, or daily agents. Move any existing local
plists out of `~/Library/LaunchAgents` to keep them disabled after login. Leave
the web plist
in place:

```sh
parked="$HOME/Library/LaunchAgents/garminhub-hosted-disabled"
mkdir -p "$parked"
for label in api ingest daily; do
  plist="$HOME/Library/LaunchAgents/com.garminhub.$label.plist"
  launchctl unload "$plist" 2>/dev/null || true
  mv "$plist" "$parked/"
done
```

To return to fully local development, set `VITE_API_BASE=http://localhost:3001`
and the local `VITE_API_SECRET`, restore the three parked plists, then run the
installer to rebuild the dashboard and reload all four agents:

```sh
parked="$HOME/Library/LaunchAgents/garminhub-hosted-disabled"
for label in api ingest daily; do
  mv "$parked/com.garminhub.$label.plist" "$HOME/Library/LaunchAgents/"
done
rmdir "$parked"
bash deploy/local-macos/install.sh
```

No source edit is needed in either direction.
