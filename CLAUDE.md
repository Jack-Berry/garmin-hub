# Garmin Hub — Project Context

## What this is

A personal, single-user web app that ingests my Garmin running data and provides a stats dashboard plus an AI coaching layer. The AI is primarily an analyst/advisor — I use Runna (which pushes structured workouts into Garmin) for periodised training blocks, and the hub reads both Runna's planned workouts and my actual runs to give planned-vs-actual coaching insight. But the coach is no longer analysis-only: a **planning mode** (Stage 8) lets it compose and push **individual** pace-target sessions to Garmin (tempos, intervals, race pacers via Engo 3 glasses). Single sessions only, never periodised multi-week blocks — those stay Runna's job.

## Architecture

- **Ingest:** Python + `garminconnect` (0.3.6) + `psycopg` (3). Pulls data, upserts into Postgres. Run by cron.
- **Database:** PostgreSQL (database `garminhub`; locally the Homebrew PG 14 service). `db/schema.pg.sql` is the canonical schema.
- **API:** Node + Express + `pg`, fully async. Two pools mirror a deliberate read/write split (see API section). Serves JSON to the frontend and handles AI-coach calls.
- **Frontend:** React (JavaScript, not TypeScript) + Tailwind + Recharts. Fetch state flows through `useFetch` + the shared `StateWrap` wrapper — every section must render visible loading/error states, never silently fall through to empty data (the hero once rendered a confident fake "rest week" while the API was down).
- **AI layer:** Node calls the Anthropic Claude API (Opus, daily). Uses a separate API key in `.env`.
- **Host:** TBD — moving toward a proper hosted single-user deployment; provider not yet chosen. Until then, the local macOS launchd setup (see Build & deploy) is the running instance.

## Data flow

`cron → ingest.py → Postgres ← Express API ← React dashboard`, with the API also calling the Claude API for coaching.

## Repo layout

```
garmin-hub/
  ingest/   Python ingest + Garmin client + .env + .garth/ token cache
  server/   Express API, db access (pg pools), Claude client
  web/      React + Tailwind frontend
  db/       schema.pg.sql (canonical), setup_local.sh, README (roles + env vars)
  attic/    retired SQLite-era artifacts (see attic/README.md) — nothing here runs
  CLAUDE.md
```

## Database

PostgreSQL, eight tables (`db/schema.pg.sql` is canonical). Design principle: typed columns for everything with coaching value, plus a `raw_json` **jsonb** column per Garmin-sourced table as a fidelity safety net. Query/chart against typed columns; `raw_json` is the fallback for anything not promoted to a column (and is queryable with jsonb operators). (Our own tables — `coach_notes`, `profile` — have no `raw_json`.)

Migrated from SQLite (July 2026) — key facts:

- **Types are real:** all `*_json`/`raw_json` columns are `jsonb` (pg/psycopg return parsed objects — never `JSON.parse` a column value); dates are `timestamp` (`start_time_local`, `lt_detected_date` — local wall-clock, no zone), `date` (`calendar_date` columns, `fetched_at`, `record_date`, `date_range_*`), and `timestamptz` (`created_at`, `updated_at`).
- **String contract preserved:** `server/db.js` overrides the pg type parsers so date/timestamp columns come back as the legacy strings (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`, ISO-Z) — the API's JSON shapes never changed. Don't remove those parsers casually.
- **BIGINT ids (5):** `activities.activity_id`, `laps.activity_id`, `personal_records.activity_id` (activity ids ~23.5B), `planned_workouts.schedule_id` (negative 60-bit ical hashes) and `planned_workouts.workout_id` all overflow or crowd int4.
- **Two DB roles enforce the read/write split at the database layer:** `garminhub_ro` (SELECT only — the API's read pool) and `garminhub_rw` (DML only, no DDL — the API's write pool + the Python ingest). Connection strings: Node reads `DATABASE_URL_RO` / `DATABASE_URL_RW`, Python ingest reads `DATABASE_URL`, and `PG_ADMIN_URL` is the DDL connection for `ingest/init_db.py` (schema re-apply). Local defaults for all of these are in code; see `db/README.md`.
- First-time setup: `bash db/setup_local.sh` (roles + database + schema, idempotent).

- **`activities`** — one row per completed activity (PK `activity_id`). Run metrics, HR + zones, cadence, power + zones, running dynamics, training load/effect, VO2max, full elevation, calories, geo lat/long for weather backfill, fastest splits. Logic-bearing columns:
  - `activity_type` — raw Garmin `activityType.typeKey` (e.g. `running`, `treadmill_running`).
  - `activity_group` — derived coarse bucket for filtering: any `*running*` → `run`, `soccer`/`football` → `football`, any `*walking*` → `walk`, else `other`. Set by ingest.
- **`laps`** — splits per activity (PK `activity_id` + `lap_index`). Per-lap metrics incl. `intensity_type` (active vs recovery) for matching executed intervals to planned ones.
- **`planned_workouts`** — one row per planned workout (PK `schedule_id` — the Garmin calendar item id, or a **negative** SHA1-hash of the event UID for ical rows, so the two id spaces can't collide). Logic-bearing columns:
  - `source` — `garmin` | `runna_ical` | `app`. Garmin sync covers ~2 weeks with rich step JSON; the Runna ical feed fills in the rest of the plan; `app` rows (Stage 9a) are written by the API at pacer-push time via the write pool — ingest never writes or deletes them (stale cleanup is per-source and only ever runs for `garmin`/`runna_ical`).
  - `plan_id` / `rationale` (Stage 9a) — app rows only: the owning adapted-plan id (NULL = one-off single push) and the per-session "why". App rows use the ical-style negative-hash id space and store the pushed spec verbatim in `steps_json`.
  - `is_race_auto` — 0/1, keyword match on title/description for "race"/"parkrun". Owned and overwritten by ingest on every run.
  - `is_race_override` — 0/1 manual override; NULL = none. **Ingest NEVER writes this** — it survives re-ingest.
  - Effective race status = `COALESCE(is_race_override, is_race_auto)`, derived by callers (see the `/api/planned` query).
  - `steps_json` — jsonb. Garmin rows: parsed step/segment structure; ical rows: an array of description-text lines (`parseSteps` in `context.js` passes string arrays through as-is).
- **`recovery`** — one row per `calendar_date` (PK). Consolidates ~7 daily Garmin wellness payloads into one typed row: HRV (+ baseline), resting HR, sleep (stages, score), training readiness (score/level/feedback + factor breakdown), training status, VO2max, all-day stress, body battery.
- **`coach_notes`** — AI coaching output (PK `id`, identity/auto-generated). `note_type` (`daily`/`weekly`/`ondemand`), `content`, `model`, date range. No `raw_json`.
- **`profile`** — single-row (PK `id = 1`, CHECK-enforced) coaching profile. Growable lists stored as jsonb: `shoes_json`, `races_json`, `injuries_json`, `routines_json` (the "other regular activities" — activity/day/intensity, added in 6c), plus `general_notes` — all user-edited via the API's profile endpoints. **Exception:** three lactate-threshold columns — `lt_speed_mps` (LT speed, true m/s), `lt_hr` (LT heart rate, bpm), `lt_detected_date` (source timestamp) — are **ingest-owned** (written by `ingest.py`) and feed the Stage 8 pace system. No `raw_json`.
- **`personal_records`** — Garmin-sourced personal bests (one row per record type). Read-only, refreshed by ingest.
- **`race_predictions`** — Garmin's current predicted race times (5K/10K/half/marathon) per `calendar_date`. Read-only, refreshed by ingest.

### Activity-group filtering (important)

Running displays are runs-only. `activity_group` is the filter:

- **Weekly summary / pace trend** — runs only (`activity_group = 'run'`), so walks and football don't pollute mileage and pace.
- **Walks** — ingested for recovery context but excluded from running displays.
- **Football** — shown, but excluded from pace analysis.

## Ingest

`ingest/ingest.py`. Idempotent (safe to re-run from cron): all writes are upserts (`INSERT … ON CONFLICT(pk) DO UPDATE`), no duplicates. Exits **1** when the run collected any errors (even partial, e.g. one rate-limited date) so cron/`daily.sh`/`/api/ingest/refresh` see the failure — note `daily.sh` skips the brief on any non-zero exit.

- **Run/auth:** runs via `/usr/local/bin/python3.13` (Homebrew Python 3.13 — **NOT** Apple's system 3.9). garth token cache lives in `ingest/.garth/` (gitignored), so MFA is only prompted on first login / token expiry. DB connection: `DATABASE_URL` (rw role; local default in code). Per-pull-section transactions: each section commits on success and **rolls back on error**, so one failed pull can't poison the rest.
- **Activities:** pulls the recent N activities (+ laps per activity). Skips the splits fetch when an activity is unchanged and its laps already exist (cheap idempotency win for the common cron case).
- **Planned workouts:** fetched via `get_scheduled_workouts(year, month)` (calendar-based) over a back/forward window (60 days back / 84 days — 12 weeks — forward, matching the coach's `get_scheduled_workouts` tool reach), then `get_scheduled_workout_by_id(id)` for full step detail. Calendar items have mixed `itemType`; planned workouts are `itemType == "workout"`, keyed by date + `workoutId`, with `id` as the schedule id. **Stale-plan cleanup:** after the fetch, future `planned_workouts` rows no longer on the calendar are deleted (a replaced Runna plan leaves no ghosts) — **scoped per-source** (`source = 'garmin'`, so it can never wipe ical rows) and skipped entirely if any month fetch failed, so a transient error can never mass-delete a valid plan. Past rows are never touched.
- **Runna ical feed (full plan):** Garmin only syncs ~2 weeks of Runna; the ical feed exposes the whole plan. If `profile.runna_ical_url` is set (Settings → "Runna calendar feed"), `ingest_runna_ical` fetches it (`icalendar` lib) and maps events over today → +84 days to `planned_workouts` rows with `source = 'runna_ical'` (distance regexed from the title; description lines minus URL lines stored in `steps_json`). **Dedupe:** runs AFTER the Garmin pull — any date a `garmin` row covers is skipped (richer step JSON wins), and the skipped event is deliberately not marked seen so a previously-ingested ical row for that date gets stale-cleaned away. Ical stale cleanup mirrors the Garmin one: per-source, future-only, skipped when the feed fetch fails; if the URL is unset the pull is a no-op (existing ical rows are left alone).
- **Recovery:** pulls ~7 Garmin wellness endpoints per day over a 30-day window. Skips dates already stored **except** the most recent 3 (same-day/recent metrics like sleep and readiness fill in late). Throttled between fetches; on a 429/rate-limit it backs off and retries the date once.

### Race detection (don't trust Garmin's flag)

Garmin's own `race` boolean is unreliable — it's `false` even for workouts titled "10km Race". So we ignore it and derive race status ourselves: ingest sets `is_race_auto` from a keyword match ("race"/"parkrun") on the title/description, and I can manually correct any workout via `is_race_override` (which ingest never touches). Effective status is `COALESCE(is_race_override, is_race_auto)`.

## API

`server/server.js`. **Auth:** every `/api/*` route sits behind one shared-secret middleware — requests must send `X-Api-Key` matching `API_SECRET` (`server/.env`; the server refuses to start without it) or get a 401. The frontend bakes the same value in at build time from `VITE_API_SECRET` (`web/.env.local`) — **the two must match, and changing the secret means a frontend rebuild**. CORS is pinned to the frontend origins (`:4173`/`:5173`, override via `CORS_ORIGINS`); the server binds `127.0.0.1` only; `daily.sh` reads the secret out of `server/.env` (a plain `grep`/`cut` of the `API_SECRET=` line — keep it unquoted, one line). Quirk: the custom header makes browsers **preflight every request**, and preflights never carry custom headers — so the CORS middleware answers OPTIONS **before** the auth gate; keep that ordering. All DB access is **async** (`pg` pools via `server/db.js`): reads go through the `db` pool (the SELECT-only `garminhub_ro` role — read-only is enforced by Postgres itself), writes through the `writeDb` pool (`garminhub_rw`), scoped so they can never clobber ingest-owned data. The curated column lists (everything but `raw_json`) come from `information_schema.columns` and are **awaited at startup before `app.listen`** — don't move that init after routes can fire. The narrowly-scoped DB writes:

- `POST /api/planned/:schedule_id/race-override` — body `{ override }` where override is `1` (force race), `0` (force not-race), or `null` (revert to auto). Writes **only** `is_race_override`.
- `POST /api/profile` — replaces the single `profile` row (shoes/races/injuries/routines/notes/runna_ical_url). `GET /api/profile` returns parsed arrays.
- `POST /api/coach/daily` — generates the glance brief and inserts a `daily` row into `coach_notes`.

The AI-coach and pacer routes also spawn Python or call Claude (see AI coach / Pacer below); `POST /api/pacer/push` is the only endpoint that writes to **Garmin**. `POST /api/ingest/refresh` spawns `ingest.py` on demand (in-process lock stops concurrent runs).

**Prompt-cache stability (real money):** `buildContext` / `buildPlanningContext` output is injected as a `cache_control`'d system block on every coach call, so it must be **byte-stable across calls** — a per-call timestamp in it busts the cache every request. That's why the context carries a day-granular `today` (the coach needs it to resolve "Saturday" to a date), not an ISO timestamp; never add per-call values (timestamps, randomness) to those payloads. `renderContextDump` stamps its timestamp at render time, outside any cached path.

Read endpoints: `/api/health`, `/api/activities` (+ `/:id` with laps), `/api/planned` (returns derived `is_race`; app-plan date precedence applied, then same-day race duplicates collapsed — see 9a/6g), `/api/recovery`, `/api/summary/weekly` (per-ISO-week mileage/pace, runs-only by default), `/api/training-balance` (Load Focus / training-status / ACWR snapshot parsed from the latest `recovery.raw_json`; drives the Training Balance slide), `/api/personal-records`, `/api/race-predictions`, `/api/coach/context` + `/api/coach/context-dump`, `/api/coach/notes`.

## Known Garmin data shapes (already inspected)

- **Activities:** ~99 fields per run; curated subset promoted to columns, rest in `raw_json`.
- **Laps/splits:** per-lap metrics incl. `intensityType` (active vs recovery).
- **Workout step structure:** segments → steps; repeats are `RepeatGroupDTO` with `numberOfIterations` + child steps. Pace targets use `targetType: "pace.zone"` with `targetValueOne`/`targetValueTwo` as speed in m/s (higher = faster bound).

## Pacer / Engo 3 constraint (CRITICAL for Stage 5)

Generated pacing workouts **MUST** be split into 500m segments. The Engo glasses average pace over the whole step, so a longer step gives too wide a sample and ruins the pacing display. So: distance ÷ 500m = step count (5k → 10 steps, 10k → 20 steps).

- Support **per-segment** pace targets (not one repeated pace) so negative-split strategies are possible.
- Encoding: `targetType: "pace.zone"`, `targetValueOne`/`targetValueTwo` as m/s bounds.
- The existing "Sub 20 5k" planned workout is the canonical template.

## Conventions & preferences

- Keep all files as brief and lean as possible. No over-engineering, no speculative abstraction.
- Agree approach before writing; I QA each stage before moving on.
- Credentials and API keys live in `.env` (gitignored), read via environment variables. Never hardcode secrets.
- Ingest must be idempotent — safe to re-run (upserts, no duplicates) since it runs on a cron.

## Roadmap / stages

Build proceeds in stages; don't build ahead of the current one.

- **Stage 1 — schema + ingest.** ✅ Done.
- **Stage 2 — Express API.** ✅ Done.
- **Stage 3 — dashboard.** ✅ Done.
- **Stage 4 — AI coach.** ✅ Done. An analyst (not a workout generator) that writes daily insight into `coach_notes`, PLUS an interactive chat window with recent training context auto-injected, PLUS a coaching-profile concept (shoes/goals/paces/injuries — editable, injected into prompts).
- **Stage 5 — workout generator.** ✅ Done (pacer slice). Single pacing workouts (the Engo pacers — see Pacer constraint above): conversational param-gathering (`pacer.js`) + deterministic build/push (`pacer_cli.py`), approval-gated preview before the one Garmin write. Explicitly **NOT** replacing Runna's training blocks (load-modelling a full block is too risky to take on).
- **Stage 6 — dashboard redesign.** ✅ Done (6a–6j).
  - **6a — hero zone.** ✅ Done. Unified hero (`sections/Hero.jsx` + `hero/`): a cycling carousel (This Week strip / Pace trend with Easy/Hard split / weekly Load bars) above a persistent key-metric row (VO₂max, resting HR, HRV, week mileage). Replaced the old `WeekSummary` + `PaceTrend` cards. Daily brief (`DailyInsight`) still sits above it. (Superseded in Stage 7: This Week is now a permanent band, not a carousel slide.)
  - **6b — coach brief/report split + week-cell click-through.** ✅ Done.
    - Daily coach insight split into two tiers: a cheap Sonnet **glance brief** (`POST /api/coach/daily`, persisted as a `daily` note, drives the brief carousel) and an on-demand Opus **detailed report** (`POST /api/coach/report`, stateless, expands inline under the brief). The brief stays headline-only; the report holds the depth.
    - This-Week cells now open a per-day insight modal (`POST /api/coach/day/:date`, Sonnet, stateless): completed run → "how it went" analysis (the post-run depth deliberately kept out of the brief); planned-only → execution tips; rest → static line, no model call. Branching + the per-day focus payload live in `context.js` `buildDayFocus`.
    - Coach model split: brief / day-insights / chat on Sonnet (`claude-sonnet-4-6`); detailed report on Opus (`claude-opus-4-8`). All on-demand generation is click-only (no generation on load).
  - **6c — "other regular activities" profile field.** ✅ Done. New profile list (activity / day / intensity) stored in `profile.routines_json` (migration `ingest/migrate_routines.py`), edited in the Settings modal, and fed into the coach context (`context.js`). Rendered in `WeekStrip` as routine cells whose done/expected/rest state resolves at render time (no cron); a routine matches a logged Garmin activity by `activity_group` (e.g. football).
  - **6d — WeekStrip cell redesign + day-modal chat.** ✅ Done. Cells reworked to be activity-focal, then to a typographic treatment (no icons — big bold uppercase Archivo word + small muted distance). Day-modal title fix; the day modal now hosts a mini-chat that reuses `POST /api/coach/chat` with full context (seeded by a framing user turn per day state); metric-row icons switched to Tabler.
  - **6e — Activity-trend slide.** ✅ Done. "Pace trend" renamed to **Activity trend** (`hero/PaceSlide.jsx`); adds a Football Distance / Max-speed toggle (top speed from `max_speed_mps`, shown only when the games carry it).
  - **6f — lower-dashboard restructure.** ✅ Done. Recent activities restyled (football pace shows "—" since distance ÷ match-time is meaningless); Recovery de-duped to a trends band + inline-expand history; the Planned-vs-actual section was **deleted**; `PlannedWorkouts` kept.
  - **6g — same-day race collapse.** ✅ Done. `server/planned.js` `collapseRaceDuplicates` groups same-date + same-distance entries that include a race and collapses them to one row (survivor preference: manual override > Runna auto > pacer > other), surfacing a `pacer_available` "pacer ready" flag. Applied in both `/api/planned` and `buildContext`, so the dashboard and coach see each race once.
  - **6h — lower-dashboard final layout.** ✅ Done. Full-width Recovery band on top, then a two-column row: Recent activities (wide table) beside Upcoming planned (narrow list), collapsing to one column on narrow widths (`App.jsx`).
  - **6i — recovery + activities polish.** ✅ Done. Recovery sparklines expand to a full-history modal on click; Recent activities default to 6 rows ("Show more" paginates); chat icon → Tabler.
  - **6j — lower-section width/container fix.** ✅ Done. Constrained the two-column tracks (`[&>*]:min-w-0`) so the table/badges can't blow the columns past the dashboard's shared max width.
- **Stage 7 — design-system reskin.** ✅ Done. Full visual reskin to the "Training Trend / 1B editorial" system.
  - Design tokens in `web/src/index.css` + `web/tailwind.config.js`: surface ramp, text ramp, a single `--acc` accent var, and semantic colours — all light/dark via a nested `.dark` class (App toggles `.dark` on a wrapper div, not `<html>`). Fonts: **Archivo** (display) / **Hanken Grotesk** (body) / **JetBrains Mono** (data readouts), loaded via a webfont `<link>` in `index.html`.
  - **Accent rule:** the accent colour appears **only** on genuinely live/active/today elements (active state, primary/regenerate action, today's marker, the latest data point); everything else stays monochrome. Applied across every surface incl. the Settings modal.
  - This Week pulled **out** of the carousel into its own permanent section (currently positioned **above** the daily brief), typographic (no icons — bold uppercase Archivo). Carousel is now: Activity trend (pace) / Load (mileage) / **Training Balance**, at a fixed ~264px height.
  - **Training Balance slide** (`web/src/hero/BalanceSlide.jsx`): Load Focus three-bar view (low aerobic / high aerobic / anaerobic vs their optimal ranges), a humanised training-status pill, and the ACWR load ratio — all parsed server-side from `recovery.raw_json` via the new `GET /api/training-balance`. No ingest change; ~4 weeks of history available.
  - **7e — accent theme picker.** ✅ Done. A five-swatch accent picker in Settings (`web/src/accents.js` is the single source of truth; `accent.jsx` context applies `--acc` live, persists to `localStorage`, and exposes the resolved hex so Recharts — which can't read `var()` — follows along). Default accent **lime `#c9f24e`**. A pre-paint `<script>` in `index.html` applies the saved accent's dark value before React mounts (keep its inline hexes in sync with `accents.js`).
- **Stage 8 — coach-scheduled workouts.** ✅ Done (8a–8c). The coach can now compose and push individual pace-target sessions to Garmin through the pacer engine, in a dedicated planning mode. It composes **single** sessions only — it does not build periodised blocks or model cumulative load (still Runna's job).
  - **8a — LT-derived pace system.** ✅ Done. Ingest captures Garmin's lactate-threshold reading into the three `profile.lt_*` columns (see Database). Two pure, separate Node modules turn that into paces (both DB-free — DB access lives only in their `require.main` preview harnesses):
    - `server/zones.js` — current-fitness training zones from `lt_speed_mps` alone. Eight LT-anchored zones (`very_easy` → `rep`; `very_easy` is ceiling-only), each a point pace + derived band. Fully derived from a CONSTANTS block (per-zone ratios + band fractions); `node server/zones.js` prints the live table. Knows nothing about goals.
    - `server/goalpaces.js` — goal / "reach" paces from the profile's `races_json` + Garmin PBs (`personal_records`). Infers distance from the race name, parses the goal ("Sub 20" / "PB" / blank), resolves to a goal pace. `resolveGoalPaces` (bulk) + `goalForDistance` (scoped, on-demand). Knows nothing about LT. No pace is invented for a no-goal race — that fallback is the coach's call.
    - The coach resolves zone names / goal references to concrete pace strings at spec time, scoped to the stated intent (never eagerly).
  - **8b — blocks builder + guard.** ✅ Done. The pacer engine gained a general `blocks` path (archetype vocabulary lives in `WORKOUT_BLUEPRINT.md`):
    - `ingest/workout_builder.py` `build_pacer_blocks(blocks, warmup_m, cooldown_m, name)` — builds a Garmin workout from an explicit ordered list of blocks. A block is `{length_m, segment_m, target, strategy, band_s?}`; **`band_s` is ± half-width** (s/km each side of target, so `band_s: 2` = a 4 s/km window). Rest blocks (`{kind:"rest", rest_s}` time / `{kind:"rest", length_m}` distance) emit a **real Garmin rest step** (stepTypeId 5, no pace target). `strategy: "negative"` ramps slower→faster and empties the tank over the final segments.
    - `ingest/pacer_cli.py` `validate_blocks` — a hard deterministic guard run before any build/push (segment / pace-bound / distance / rest / step-count / band sanity + negative-split floor). Both spec shapes (simple params and explicit blocks) funnel through the SAME `validate_blocks`, so nothing reaches Garmin unvalidated.
    - **Guard bounds are single-sourced** in `ingest/guard_bounds.json` (previously duplicated). Three readers: the enforcer (`pacer_cli.py`), the builder's negative-split shape (`workout_builder.py`), and the advisory copy injected into the planning coach's context (`context.js`) — so the numbers can't drift.
  - **8c — planning mode.** ✅ Done. An in-conversation mode where the coach composes sessions and pushes them one at a time, gated by preview + explicit approval.
    - **API:** `POST /api/coach/plan` (Opus). `planReply` (`coach.js`) drives it with `PLANNING_SYSTEM` (the composer persona: assess-before-propose, the archetype catalogue, the blocks-spec shape, the guard bounds) + `buildPlanningContext` (`context.js`, wraps `buildContext` with `planning.zones` / `planning.goal_paces` / `planning.guard` / `planning.pushed_recently`). Returns `{ reply, spec, done, specError }`. Preview/push still go through `/api/pacer/preview` and `/api/pacer/push` (the latter the only Garmin write); pushes are recorded in an in-memory `recentPushes` list so the coach doesn't double-book a just-pushed session.
    - **Frontend:** `web/src/ChatWidget.jsx` gains a planning mode — accent border while active, and a fresh thread on entry (chat and planning can't share history / system prompt). A returned spec renders an inline preview (`web/src/PacerPreview.jsx`, lifted out of the old pacer modal) with a "Push to Garmin" button; a successful push **auto-advances** to the next agreed session.
    - **Reliability fixes:** phantom-push guard (a bare "all done" with no real push does NOT end planning — only an actual `api.pacerPush` result sets `pushed`); no re-presentation of an already-pushed session; spec-emitted history markers (`[spec emitted: …]` — the app strips fenced specs from history, so the model doesn't believe it never presented one); and a one-shot **repair loop** in `planReply` when a turn tries to present a spec but none extracts (truncation / invalid JSON).
  - **8d — scheduled-workout tool.** ✅ Done. The coach can see the future plan beyond the injected context's 14-day horizon via a `get_scheduled_workouts` Claude tool (chat + planning mode, `coach.js`): on demand it reads `planned_workouts` up to 12 weeks ahead (clamped) and returns a compact one-line-per-workout summary with steps (`scheduledSummary` in `context.js`), labelled "UPCOMING — not yet completed". `createResolvingTools` handles the tool round-trips server-side; the client only sees the final reply. No new table or endpoint — `planned_workouts` + `GET /api/planned?from=&to=` already cover it. Note: Runna only syncs ~2 weeks ahead, so far-future weeks legitimately return empty until Runna publishes them.
- **Stage 9 — adapted-plan generation (replacing Runna).** In progress.
  - **9a — app-plan foundation.** ✅ Done. Schema + read-path precedence + push-time persistence only; no planning-mode or UI changes (those are 9b/9c).
    - `planned_workouts` gains `plan_id`/`rationale` (see Database) and the third `source` value `'app'`.
    - `POST /api/pacer/push` persists every successful push as a `source='app'` row (writeDb pool): ical-convention negative-hash `schedule_id` keyed on Garmin's returned schedule id — computed as **BigInt and bound as a string** so the >2^53 value stays exact in the DB; pushed spec verbatim in `steps_json` (a jsonb object — `parseSteps` returns null for it, step display is a 9b concern); built totals as the distance/duration estimates (`pacer_cli.py` push output now includes them). Optional `plan_id`/`rationale` in the push body; both NULL for one-off single pushes, which are otherwise unchanged. A failed insert AFTER a successful Garmin push returns `persisted:false` rather than a 500 (a retried push would double-book Garmin). The in-memory `recentPushes` guard stays as-is.
    - **Read-path precedence:** `applyAppPlanPrecedence` (`server/planned.js`) — any date >= today (local) carrying an app row drops its `garmin`/`runna_ical` rows (whole-date precedence; past dates untouched). Applied **before** `collapseRaceDuplicates` in `/api/planned`, `buildContext` upcoming, and `scheduledSummary`; `buildDayFocus` prefers the app row via `ORDER BY (source = 'app') DESC NULLS LAST`.
    - Ingest can never delete app rows (`_delete_stale` is `source = %s`-scoped to garmin/runna_ical).

## Build & deploy (local macOS) — READ THIS

Local always-on test deployment via launchd (`deploy/local-macos/`, see its `README.md`). **This trips people up:**

- **Frontend changes don't hot-reload.** The web service runs `vite preview` serving the **production build** (`web/dist`) on `:4173` — not a dev server. To see any frontend change you must rebuild: `bash deploy/local-macos/install.sh` (it stops stray dev servers, runs `npm run build`, and reloads the launchd services).
- **API changes need a service restart.** After editing `server/`, restart the API launchd agent: `launchctl kickstart -k gui/$(id -u)/com.garminhub.api` (it serves on `:3001`, loopback only — nothing on the LAN, e.g. a phone, can reach it).
- **The API secret spans both deploy halves.** `API_SECRET` (`server/.env`) and `VITE_API_SECRET` (`web/.env.local`, gitignored) must hold the same value — the frontend bakes it into the built bundle, so rotating it = edit both files **and** rerun `install.sh` (a stale bundle 401s on everything). If `API_SECRET` is missing the server exits at startup, which under launchd `KeepAlive` looks like a crash-loop in `garmin-hub-api.log` — never a running-but-open API.
- **The daily brief IS generated on a schedule.** `com.garminhub.daily` runs `deploy/local-macos/daily.sh` at **10:00 local** — it ingests, then (on success) POSTs `/api/coach/daily` to generate and persist the day's brief. The dashboard's **Regenerate** button generates the same brief on demand; they are not mutually exclusive. (Ingest can also be triggered mid-day via the Refresh button → `POST /api/ingest/refresh`.) Failure semantics: ingest exiting non-zero (now: any error at all) skips the brief, and the brief call uses `curl --fail-with-body` — an HTTP 500 fails the run (script exits 1) while still logging the error body.

## Known rough edges (consolidate later)

- **Migrations:** `db/schema.pg.sql` is canonical, applied via `CREATE TABLE IF NOT EXISTS` (`db/setup_local.sh` / `ingest/init_db.py`) — so it **cannot alter existing tables**. A schema change to an existing table = an `ALTER TABLE` run against the live DB **plus** the matching edit to `schema.pg.sql` (so fresh setups agree). The SQLite-era one-script-per-change `migrate_*.py` files are retired to `attic/`. Still no formal migration tool; adopt one if schema churn picks up.
- **TODO — ical schedule-id precision.** Ical rows use negative 60-bit hash ids, which exceed JS's 2^53 integer precision — `server/db.js` parses int8 to `Number`, so those ids round in API responses (a race-override on an ical row can 404). Stage 9a app rows share the same id space and round identically on read (write-side is exact: ids are computed as BigInt and bound as strings). Pre-existing since SQLite (better-sqlite3 did the same), documented in `db.js`. Clean fix: string ids over the wire — don't add a second, smaller hash scheme just for app rows.
- **TODO — PG14 EOL (late 2026).** The local Homebrew Postgres is 14.x, which reaches end-of-life in November 2026. Nothing in the schema/code is version-sensitive (works on 14–17) — pick a current major when the hosted deployment lands.
- **TODO — planned-vs-actual splits UI.** The backend plumbing is **done**: `buildDayFocus` (`context.js`) already includes the completed activity's per-lap splits (`laps`) and the planned workout's parsed steps, so the coach can judge an interval/pacer/race session split-by-split. What remains is **frontend**: a per-split planned-vs-actual view for interval/pacer/race days (the data's there, the UI isn't).
- **TODO — repeat groups not built.** The builder flattens every block and emits intervals as a flat rep/rest list; Garmin's real `RepeatGroupDTO` is **not** emitted. **Doc contradiction to resolve before building it:** `WORKOUT_BLUEPRINT.md` (§Decisions) says repeat-groups are a YES; but `PLANNING_SYSTEM` in `coach.js` hard-instructs the coach that there are NO repeat constructs (every rep written out). Reconcile these two before implementing repeats.
- **TODO — race-pacer bookends.** The race pacer (archetype 12) should **not** bake in warmup/cooldown — those are run in-race / separately, not part of the pushed pacer. Warmup/cooldown are currently coach-decided per session with no pacer-specific exception.
- **TODO — coach decisiveness in planning mode.** It still tends to list a run on most days and then trim down. It should propose **fewer, more decisive** sessions up front rather than a full week the athlete has to talk it down from (the assess-before-propose framing exists but is under-applied).
- **TODO — ingest partial-failure strictness.** `ingest.py` exits 1 on *any* error, so a single rate-limited recovery date skips the daily brief (`daily.sh` gates on exit 0) and makes the Refresh button report failure even though everything else ingested fine. If that proves too noisy, split "a whole section failed" from "minor per-item errors".
- **TODO — distance-rest shape not Garmin-attested.** The distance-based rest step (`{kind:"rest", length_m}`) hasn't been confirmed against a real Garmin-captured rest step. The **time** rest mirrors Runna's proven captured shape; the **distance** rest is our own mirror of it and is unverified on-device.
