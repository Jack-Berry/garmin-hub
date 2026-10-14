# Garmin Hub — local always-on test deployment (macOS / launchd)

Temporary setup to live with the app on this Mac for a few days. **Not** the Pi
deployment. Localhost only — no external access. Paths are hardcoded to
`/Users/jackberry/Code/Projects/garmin-hub`.

## What gets installed

Four launchd user agents in `~/Library/LaunchAgents`:

| Service | Label | What it does |
|---|---|---|
| API | `com.garminhub.api` | `node server.js` on **:3001**. KeepAlive + RunAtLoad. |
| Web | `com.garminhub.web` | `vite preview` serving the prod build (`web/dist`) on **127.0.0.1:4173**. KeepAlive + RunAtLoad. |
| Daily | `com.garminhub.daily` | At **10:00** daily: `ingest.py`, then (on success) `POST /api/coach/daily`. |
| Ingest | `com.garminhub.ingest` | **Every 2 hours**: `daily.sh --no-insight` — ingest only, no Claude spend. Keeps the dashboard current between daily runs. |

`KeepAlive` = auto-restart on crash. `RunAtLoad` = start now and at every login,
so they survive closing the terminal / logging out and back in.

## Install

```bash
bash /Users/jackberry/Code/Projects/garmin-hub/deploy/local-macos/install.sh
```

In local mode this stops any manual `node server.js` / `vite` you have running,
rebuilds the frontend, copies the plists, and loads all four services. Local
mode means `VITE_API_BASE` is empty or points at localhost.

When `VITE_API_BASE` points at a hosted URL, the installer detects hosted mode,
builds the frontend, and installs and restarts `com.garminhub.web` plus
`com.garminhub.offsite`. It does not copy or load the API, ingest, or daily
agents. Use `--dry-run` to
print the actions without running them.

```bash
bash deploy/local-macos/install.sh --dry-run
```

## Hosted offsite backups

`com.garminhub.offsite` runs at 04:30 local time. It pulls the droplet database
dumps, deployment environment, and Garmin token cache over ssh into a dated
snapshot under `~/Backups/garmin-hub`. SSH uses `~/.ssh/id_ed25519` and
`~/.ssh/known_hosts` with strict host checking. Snapshots have directory mode
700 and file mode 600, use hard links to unchanged files in the previous
snapshot, and are retained for 30 days.

The droplet verifies each archive with its matching Postgres 17 `pg_restore`
before publishing it. The Mac pull checks the newest dump's `PGDMP` header and
the pulled SHA-256 sidecar, so it does not depend on the Mac's older
`pg_restore`. It records success or failure in the droplet's offsite job status
and logs through launchd to
`~/Library/Logs/garmin-hub-offsite.log`. Preview the transfer without creating
a snapshot or changing remote status:

```bash
bash deploy/local-macos/offsite-backup.sh --dry-run
```

The local-mode installer leaves the offsite agent unchanged. This preserves the
parked hosted setup while running the local API, ingest, and daily services.

- **API:** http://localhost:3001  (health: http://localhost:3001/api/health)
- **Dashboard:** http://localhost:4173

> The dashboard API comes from gitignored `web/.env.local`. Set
> `VITE_API_BASE=http://localhost:3001` for local mode or
> `VITE_API_BASE=https://hub.berrydev.co.uk` for the hosted backend, plus the
> matching `VITE_API_SECRET`. Re-run `install.sh` after a change.

## Daily job — schedule behaviour

- Fires at **10:00 local**.
- **Asleep at 10:00** → launchd runs it once at the next wake.
- **Powered off through 10:00** → that day is skipped (fine for testing).
- Ingest uses the cached garth token (no MFA normally). If the token expires the
  job fails and **logs it** — it does not silently succeed. Re-auth by running
  `ingest.py` once manually in a terminal (answer the MFA prompt), then the cron
  job works again.

## Status / logs

```bash
# Are the services registered? (3rd column = label; 1st = PID, "-" if not running)
launchctl list | grep garminhub

# Are the ports actually listening?
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:4173 -sTCP:LISTEN

# Server logs
tail -f ~/Library/Logs/garmin-hub-api.log
tail -f ~/Library/Logs/garmin-hub-web.log

# Daily ingest + insight log (this is the one to watch each morning)
tail -f ~/garmin-hub-cron.log
```

## Run the daily job manually (end-to-end test)

```bash
launchctl start com.garminhub.daily      # runs ingest + insight now
launchctl start com.garminhub.ingest     # runs ingest only, now
tail -f ~/garmin-hub-cron.log            # watch it work
```

Or just run the script directly (same thing, foreground):

```bash
bash /Users/jackberry/Code/Projects/garmin-hub/deploy/local-macos/daily.sh
```

## Uninstall (clean teardown before the Pi move)

```bash
bash /Users/jackberry/Code/Projects/garmin-hub/deploy/local-macos/uninstall.sh
```

Removes all four services. Logs are left behind; delete them by hand if you
want (`rm ~/Library/Logs/garmin-hub-*.log ~/garmin-hub-cron.log`).
