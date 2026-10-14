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
15 3 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh backup >> /home/deploy/garmin-hub/backup.log 2>&1
```

Backups are custom-format `pg_dump` files under `deploy/droplet/backups` and
files older than 14 days are removed. Copy backups off the droplet and test a
restore periodically.

Each host job writes its latest result atomically under
`deploy/droplet/job-status`. The app sees that directory at
`/run/garmin-hub-status` and the backups directory at
`/var/lib/garmin-hub/backups`; both mounts are read-only. The key-gated
`GET /api/status` endpoint combines these files with `ingest_state`, today's
daily coach note, and the newest dump. `GET /api/health` also verifies the read
database pool, so a database outage makes the container health check fail.

The Mac offsite pull records its result through the narrow direct command:

```sh
deploy/droplet/jobs.sh mark offsite ok "snapshot verified"
deploy/droplet/jobs.sh mark offsite fail "pull failed"
```

Do not use `mark` for ingest, daily, or backup. Those commands own their own
status. A skipped daily invocation outside the 10:00 London hour leaves the
previous status untouched.

### Restore from a Mac snapshot

Mac snapshots live under `~/Backups/garmin-hub/<timestamp>`. Choose a verified
snapshot and copy its dump to the checkout, then follow the normal restore
sequence below with that dump. In summary:

```sh
snapshot="$HOME/Backups/garmin-hub/<timestamp>"
scp "$snapshot/deploy/droplet/backups/<backup>.dump" \
  deploy@178.128.168.63:/home/deploy/garmin-hub/restore.dump
docker cp restore.dump garmin-hub-postgres:/tmp/restore.dump
docker exec garmin-hub-postgres pg_restore -U postgres -d garminhub \
  --data-only --disable-triggers /tmp/restore.dump
```

Restore `deploy/droplet/.env` with mode 600 without printing it. Restore
`ingest/.garth` into the named token volume using the Garmin token cache steps
above, then ensure the cache remains owned by uid 65532. Remove temporary
copies from the droplet after the app and ingest have been verified.

To restore, stop the app, preserve a fresh dump, recreate the database, apply
the canonical schema, remove its one seeded row, then restore data only:

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
