# Garmin Hub — local always-on test deployment (macOS / launchd)

Temporary setup to live with the app on this Mac for a few days. **Not** the Pi
deployment. Localhost only — no external access. Paths are hardcoded to
`/Users/jackberry/Code/Projects/garmin-hub`.

## What gets installed

Three launchd user agents in `~/Library/LaunchAgents`:

| Service | Label | What it does |
|---|---|---|
| API | `com.garminhub.api` | `node server.js` on **:3001**. KeepAlive + RunAtLoad. |
| Web | `com.garminhub.web` | `vite preview` serving the prod build (`web/dist`) on **127.0.0.1:4173**. KeepAlive + RunAtLoad. |
| Daily | `com.garminhub.daily` | At **10:00** daily: `ingest.py`, then (on success) `POST /api/coach/daily`. |

`KeepAlive` = auto-restart on crash. `RunAtLoad` = start now and at every login,
so they survive closing the terminal / logging out and back in.

## Install

```bash
bash /Users/jackberry/Code/Projects/garmin-hub/deploy/local-macos/install.sh
```

This stops any manual `node server.js` / `vite` you have running, rebuilds the
frontend, copies the plists, and loads all three services.

- **API:** http://localhost:3001  (health: http://localhost:3001/api/health)
- **Dashboard:** http://localhost:4173

> The dashboard talks to the API at `localhost:3001` (hardcoded default), so both
> services must be up. If you change frontend code, re-run `install.sh` to rebuild
> `dist` (the served bundle is the build, not live source).

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

Removes all three services. Logs are left behind — delete them by hand if you
want (`rm ~/Library/Logs/garmin-hub-*.log ~/garmin-hub-cron.log`).
