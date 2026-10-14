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
the import, and never commit it. If the cache expires, run an interactive ingest
once in the container so MFA can refresh the volume.

## Move local data

The hosted schema comes only from `db/schema.pg.sql`. Dump data from the Mac,
copy the dump to the droplet, and restore it after the first compose start:

```sh
pg_dump -h localhost -U postgres -d garminhub --data-only -Fc \
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

Install these entries with `crontab -e` as `deploy`. The daily job runs ingest
first and skips the brief if ingest fails. All HTTP errors fail the brief step.

```cron
CRON_TZ=Europe/London
17 1-23/2 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh ingest >> /home/deploy/garmin-hub/ingest.log 2>&1
0 10 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh daily >> /home/deploy/garmin-hub/daily.log 2>&1
15 3 * * * /home/deploy/garmin-hub/deploy/droplet/jobs.sh backup >> /home/deploy/garmin-hub/backup.log 2>&1
```

Backups are custom-format `pg_dump` files under `deploy/droplet/backups` and
files older than 14 days are removed. Copy backups off the droplet and test a
restore periodically.

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

Run `bash deploy/local-macos/install.sh`, then unload the local jobs again since
the installer reloads all agents:

```sh
launchctl unload "$HOME/Library/LaunchAgents/com.garminhub.api.plist"
launchctl unload "$HOME/Library/LaunchAgents/com.garminhub.ingest.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.garminhub.daily.plist"
```

To return to fully local development, set `VITE_API_BASE=http://localhost:3001`
and the local `VITE_API_SECRET`, run `install.sh`, and keep all local agents
loaded. No source edit is needed in either direction.
