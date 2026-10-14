# Stage 9f — one planning mode + whole-calendar editing

**Handoff brief for an engineer with no prior context on this conversation.**
Repo: `/Users/jackberry/Code/Projects/garmin-hub` (branch `main`, clean at time of writing). Read `CLAUDE.md` first — it is the authoritative project context, and this work adds a Stage 9f bullet to its roadmap.

House rules that constrain this work:
- **Keep files brief and lean. No over-engineering, no speculative abstraction.** Deviate only with a stated reason.
- **Prompt-cache byte-stability is real money.** `buildContext` / `buildPlanningContext` output is injected as a `cache_control`'d system block on every coach call. Never add per-call values (timestamps, randomness) or unstable ordering to those payloads.
- **No formal migration tool.** `db/schema.pg.sql` is canonical and applied with `CREATE TABLE IF NOT EXISTS`, so it cannot alter existing tables. This plan needs **no DDL** — every column it uses already exists.
- **Ingest must stay idempotent** (upserts, cron-safe) and must never write app-owned data.
- Agree approach before writing; the athlete QAs each stage before moving on.

Environment: Node/Express API on `:3001` (loopback only, `X-Api-Key` = `API_SECRET` from `server/.env`); React frontend served as a **production build** on `:4173` (no hot reload); Python ingest via `/usr/local/bin/python3.13`; Postgres database `garminhub`. Local launchd deploy under `deploy/local-macos/`.

All file:line references were verified against the working tree on 2026-08-11; re-check them before editing, as they drift.

## Context

The athlete asked the planning coach to reshuffle this week (today's 16km long run → Saturday, Sunday's 11km → today, add an easy 8km Friday). The coach refused with caveats, called the sessions "Runna workouts it can't touch", and claimed it couldn't see Sunday's run. All three claims are wrong. Verified against the live DB and running API:

1. **They aren't Runna's sessions.** This week is `source='app'` rows from `plan-2026-07-12-f864e0` ("Sub-20 5k — Race-Pace Progression", Jul 21–Aug 26), whose status is **archived** — it was archived when the Knutsford bridge plan (Sep 1–25) was activated while it was still mid-flight. The 9d edit gate (`editableSession`, server.js:1033) allows only the **active** plan's sessions, so the athlete's actual current week is uneditable.
2. **Sunday's run was in context — twice, and wrong.** `applyAppPlanPrecedence` (planned.js:71-79) suppresses `garmin` ghosts only for *live* app rows; archived-plan rows suppress nothing, so every session appears twice. Today's pair even disagrees: app row "W4 Progressive Long Run **20km**" vs its Garmin twin (same `workout_id` 1629198369) "…**16km**" with 16×1km progressive steps. **Garmin is ground truth** — the athlete called it "today's progressive 16km" — so the app row is stale, most likely a `replace`/nudge whose DB write hit the `recorded:false` degrade. The coach hallucinated "no Sunday run" out of this duplicated, contradictory context.
3. **Two modes confuse the athlete** and the capability split is invisible from the chat UI.

Target model (athlete's words): one mode that does both; the Garmin calendar is the source of truth and anything on it — Runna-created included — can be moved or deleted; the coach must see the whole calendar.

**Good news from exploration:** nothing is missing on the Garmin side. `source='garmin'` rows already store both the calendar-item id (`schedule_id`) and template id (`workout_id`); `schedule_workout`/`unschedule_workout`/`delete_workout` are unrestricted; Runna's items are ordinary unprotected workouts in the athlete's own library (`ownerId` = athlete, `protected:false`, `trainingPlanId:0`). The work is gating, plumbing, prompts and dedupe. **No schema migration** — `removed_at`, `plans.status` and all id columns already exist.

## Decisions taken (athlete-confirmed)

- **Garmin wins on divergence**: the app row stays the editable identity (it holds the spec, rationale, plan history) but display/context take `title` + distance from its Garmin twin when they differ.
- **Foreign remove = unschedule only**: drops the calendar entry, keeps the workout template in the Garmin library. Never destroys something Runna or the athlete built. App-owned sessions keep today's delete-the-template semantics.
- **Lifecycle fixed too**: activating a plan must not archive a plan that is still running. Smallest honest version = a new `queued` status (below), deliberately *not* full queue management.

---

## Step 1 — reconcile primitives (`ingest/pacer_cli.py` `cmd_reconcile`, 400-462)

Three optional ids, no new flags. `ingest/workout_push.py` is **unchanged** — `wp.unschedule` (61-66) and `wp.find_schedule_id` (69-79) already exist.

- **move** — accept optional `schedule_id`; when present skip the `find_schedule_id` month scan (garmin rows already store the exact id). Rest unchanged: schedule-new-date-first, then unschedule-old, failures stay `warning` not error.
- **remove** — accept optional `schedule_id`; **present ⇒ `wp.unschedule` that entry only** (template kept), absent ⇒ today's `wp.delete` template path. Output gains `unscheduled: true` on the new branch.
- **replace** — accept optional `replace_schedule_id`; present ⇒ unschedule the old entry instead of deleting the template. Build+guard still runs before any network call; upload-new-then-remove-old ordering unchanged.

Update the docstring (401-416) to state app-owned vs foreign semantics. Risk: a stale provided `schedule_id` (entry moved in Garmin Connect since last ingest) makes unschedule fail — already degrades to the existing double-listing `warning`, never a vanished session.

## Step 2 — edit gate + per-source bookkeeping (`server/server.js` 1006-1199)

**`editableSession` (1018-1042)** — drop `AND p.source = 'app'` (1028), add `p.source` to the SELECT, and replace the active-plan 409 (1033-1036) with:

- 404 — no row / `removed_at` set (unchanged).
- 409 draft — `source='app'` and `plans.status='draft'`: "draft sessions are re-composed, not edited — nothing is on Garmin".
- 409 ghost — `source='garmin'` whose `workout_id` matches an app row **on the same `calendar_date`**: "this is the Garmin mirror of an app-planned session — edit the app session instead" (defence against corrupting app-row bookkeeping through the mirror).

  **The date scoping is mandatory and must match Step 3's Rule A.** A date-agnostic test creates a dead end for any workout the athlete moved in Garmin Connect: Rule B hides the now-stale app row, so the Garmin row is the only visible one, but the gate then refuses it as a "mirror" — visible and uneditable, with nothing else to edit. Confirmed live on 2026-08-11: workout `1629198369` has its app row on 08-11 and its real Garmin entry on 08-15, and the current date-agnostic gate returns `409 mirror` for the 08-15 row.
- 409 past (unchanged).

Everything else passes: **any non-draft app row whatever its plan status** (active, queued, archived, completed, one-off `plan_id` NULL) and **any `source='garmin'` row**. `runna_ical` passes the shared gate so `remove` can accept it; `move`/`replace` refuse it per-endpoint.

**Factor out `persistAppRow(result, spec, plan_id, rationale)`** from `/api/pacer/push` (599-609) — same `appScheduleId` negative-hash, BigInt-bound-as-text. Reused by push and foreign replace.

**move (1051-1123)**
- `runna_ical` → 409: *"this workout is only in Runna's feed — not synced to Garmin yet. It can be removed here; move it once Garmin has it, or move it in Runna."* (the coach relays this verbatim).
- Skip the stored-spec re-validation (1065-1068) when `source !== 'app'` — a garmin row's `steps_json` is Garmin's `workoutSegments`, not a buildable spec.
- Pass `schedule_id: row.schedule_id` to reconcile for garmin rows.
- Bookkeeping: app path unchanged (UPDATE date + `clearGhosts`). **Garmin path re-keys the row** — this is safe: it was verified empirically that the schedule id Garmin returns from `schedule_workout` is the *same* id ingest later stores as the calendar item's `schedule_id`, so the re-keyed row upserts cleanly on the next ingest instead of duplicating. (Method: for one-off pushed app rows, `appScheduleId('app:' + ghost.schedule_id)` reproduces the app row's primary key exactly — confirmed on every such pair in the live database.) The update is `UPDATE planned_workouts SET schedule_id = $1::bigint, calendar_date = $2 WHERE schedule_id = $3::bigint` using reconcile's returned new schedule id (bound as text), and **no `clearGhosts`** (it would delete the row just re-keyed). Re-keying avoids any visibility gap and the next ingest upserts onto the same id — idempotent. Null returned sid → delete the row + `warning`; ingest heals within a day.
- Collision scan (1070-1094) unchanged — already self-excludes and ghost-filters.

**remove (1129-1149)**
- app: unchanged (delete template, soft-delete `removed_at`, `clearGhosts`).
- garmin: reconcile `{op:'remove', workout_id, schedule_id}` → unschedule only, then **hard-delete the DB row** (it described a calendar entry that no longer exists); no `clearGhosts`.
- `runna_ical`: no reconcile (`workout_id` is NULL — nothing on Garmin); set `removed_at` as a **tombstone**. Ingest needs no change: `upsert()` (ingest.py:137-154) only SETs columns present in the row dict, so `removed_at` survives re-ingest, and `_delete_stale` hard-deletes the row once the feed drops it. Every read path already filters `removed_at IS NULL`.

**replace (1157-1199)**
- `runna_ical` → 409 (same message as move); app unchanged.
- garmin: reconcile `{op:'replace', replace_workout_id, replace_schedule_id, ...spec}`, then `persistAppRow(result, spec, null, null)` (a one-off app row) + delete the garmin row.

All three stay under `withGarminLock` (873-885); all new schedule_id binds go through `$n::bigint` with text values (the >2^53 hazard).

## Step 3 — visibility: ghost dedupe, Garmin-truth overlay, ids for the coach

**`server/planned.js`** — export one shared SQL fragment pair (`applyAppPlanPrecedence` itself is unchanged; it still handles live-app whole-date precedence over unrelated `runna_ical` rows). It must be SQL, not JS: the four read queries filter `removed_at IS NULL` before JS runs, so a JS dedupe couldn't match ghosts of *removed* app rows.

- **Filter** — drop the mirror: `NOT (p.source='garmin' AND p.workout_id IS NOT NULL AND EXISTS (SELECT 1 FROM planned_workouts a WHERE a.source='app' AND a.workout_id = p.workout_id))`. Also fixes past-date duplicates; it only ever drops a literal same-`workout_id` mirror.
- **Overlay** — Garmin truth for app rows: prefer the mirror ghost's `title` / `estimated_distance_m` / `estimated_duration_s` via `COALESCE`. **It must be a `LEFT JOIN LATERAL … LIMIT 1`, not a plain `LEFT JOIN`** — see the verified hazard below. Apply the overlay to **future rows only** (`p.calendar_date >= today`): past dates are history and the codebase's standing rule is that history stays whatever was actually prescribed. The filter still applies to all dates.

```sql
LEFT JOIN LATERAL (
  SELECT g.title, g.estimated_distance_m, g.estimated_duration_s
  FROM planned_workouts g
  WHERE g.source = 'garmin' AND g.workout_id = p.workout_id
    AND p.source = 'app' AND p.calendar_date >= $today
  ORDER BY (g.calendar_date = p.calendar_date) DESC, g.schedule_id
  LIMIT 1) gh ON true
```

**Verified hazard — an app row can have more than one ghost.** Workout `1648106609` is scheduled on both 2026-07-30 and 2026-07-31, so it has two `source='garmin'` rows. A plain `LEFT JOIN` on `workout_id` duplicates its app row in the result set — re-introducing exactly the duplication this step exists to remove (reproduced live: 6 rows instead of 5). The `LATERAL … LIMIT 1` with the same-date-first `ORDER BY` is the fix, and it was confirmed to return one row per date across 2026-07-29→08-01 and 2026-08-11→08-20.

**Overlay `steps_json` too — otherwise step detail is lost (regression found in review).** Before this change, an app-planned session's *step list* reached the coach via its Garmin ghost row; the app row's own `steps_json` is the buildable spec object, which `parseSteps` deliberately returns `null` for (the documented 9a behaviour). Once the ghost is filtered, every app-planned session loses its steps on `/api/planned`, `sectionUpcoming`, `buildDayFocus` and `scheduledSummary` — confirmed live: 2026-08-11 previously carried 16 pace-target interval lines and now shows `steps: null`, as do all six future app sessions.

Fix: add `steps_json` to the LATERAL's select list and use `COALESCE(gh.steps_json, p.steps_json)` in the **four display surfaces**. In `planning.calendar`, keep the two separate — `spec` must remain `p.steps_json` (the buildable spec the coach edits and re-pushes), while the displayed steps come from the overlay. Do not let the overlay clobber `spec`.

**The mirror test must be DATE-SCOPED, or a workout moved on Garmin disappears (found in review; now a live scenario — the athlete reshuffled this week by hand in Garmin Connect).** The filter as first specified suppresses any `garmin` row sharing a `workout_id` with an app row, *regardless of date*. When the athlete moves a pushed workout in Garmin Connect, ingest re-creates the ghost at the **new** date while the app row keeps the **old** one — so the real session is filtered into invisibility and a phantom shows on the wrong day. Reproduced on existing data: workout `1648106609` has Garmin entries on both 2026-07-30 and 2026-07-31, and the 07-31 entry vanishes entirely from the deduped view.

Two rules replace the single filter (both verified live — the hidden 07-31 entry reappears, and the future window is unchanged, so no false positives):

```sql
-- A. A ghost is a mirror only when it sits on the SAME date as its app row.
NOT (p.source = 'garmin' AND p.workout_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM planned_workouts a
  WHERE a.source = 'app' AND a.workout_id = p.workout_id
    AND a.calendar_date = p.calendar_date))

-- B. A FUTURE pushed app row whose workout Garmin now holds only on another
--    date is stale — Garmin wins, so hide it and let the ghost show the truth.
--    Future only: past rows are history and stay as prescribed.
NOT (p.source = 'app' AND p.workout_id IS NOT NULL AND p.calendar_date >= $today
  AND NOT EXISTS (SELECT 1 FROM planned_workouts g WHERE g.source = 'garmin'
        AND g.workout_id = p.workout_id AND g.calendar_date = p.calendar_date)
  AND EXISTS (SELECT 1 FROM planned_workouts g2 WHERE g2.source = 'garmin'
        AND g2.workout_id = p.workout_id))
```

Rule B is what keeps the hub honest when the athlete edits their calendar directly in Garmin — which they do. The overlay's LATERAL should likewise prefer the same-date ghost (it already does).

**Divergence is common, which is why Garmin wins.** Three live instances found, not one: 2026-08-11 (app "…20km" vs Garmin "…16km"), 2026-08-01 (app "Race Pace 3km" vs Garmin "Race Pace 2.5km"), 2026-07-30 (app "Structured Test — 4x600m" vs Garmin "Data demo").

Apply both to `/api/planned` (server.js:112), `sectionUpcoming` (context.js:349), `scheduledSummary` (context.js:856), `buildDayFocus` planRow (context.js:507), and the new `planning.calendar`.

**`planning.calendar`** — replaces `planning.active_plan` (context.js:768-794), whose active-plan-only scope is the mirror of the gate we're removing. One query, today → +28d, all sources, non-draft, `removed_at IS NULL`, dedupe+overlay applied, `ORDER BY calendar_date, schedule_id` (byte-stable — no per-call values, per the prompt-cache rule):

```js
planning.calendar = { window_days: 28, sessions: [{
  schedule_id,                 // ::text — exact past 2^53
  date, title, km, source,     // 'app' | 'garmin' | 'runna_ical'
  plan_id, plan_status, pushed,
  editable,                    // true | 'remove_only'  (runna_ical)
  rationale, spec,             // app rows only
  spec_stale,                  // true when the Garmin twin's title/distance differ from the stored spec
}]}
```

`spec_stale` is the honest fix for the 20km/16km case: the coach sees Garmin's title *and* knows its stored spec no longer matches, so it can offer to re-push rather than reason from stale numbers. `planning.plans` (803-836) unchanged.

**`scheduledSummary` (846-875)** — add `p.schedule_id::text` to the SELECT and extend each line with `[id <schedule_id>]` plus a source tag (`[app-planned]` kept, `[garmin]`, `[runna-feed]` added), so the coach can name and edit anything the tool shows. Ordering and ids are DB-stable, so cache stability holds.

## Step 4 — lifecycle: stop archiving a running plan (`queued`)

Smallest honest version of the CLAUDE.md "queued plan" TODO — status honesty only, no queue UI, no reordering.

- **`plans.status`** gains `queued` (schema.pg.sql comment + transition docs; no DDL — it's a text column).
- **Activation flip (`pushNextSession`, server.js:901-916)**: retire the other active plan only when it is finished (`PLAN_FINISHED_SQL` → `completed`) **or** its span overlaps the new plan's span (genuine supersession → `archived`). If it is mid-flight and non-overlapping, leave it `active` and flip the new plan to **`queued`** instead. Retire-then-flip ordering preserved so a crash can never leave two actives.
- **Promotion**: in `GET /api/plan/current` (server.js:807, right after the existing auto-complete UPDATE at 811) — if no plan is `active` and a `queued` plan exists, promote the earliest-starting one. Idempotent, forward-only, no scheduler, matching the auto-complete pattern.
- **Precedence liveness**: `appRowLive` (planned.js:71) becomes `plan_status` in (`active`, `queued`) or NULL — a queued plan's sessions are pushed and real on Garmin, so they must suppress overlapping Runna dates.
- **`/api/plan/current` selection**: prefer `active` > `queued` > newest draft > newest completed.

Note: with the Step 2 gate widening, queued/archived sessions are editable regardless — this step is about the status being *true*, and about precedence.

## Step 5 — one persona, one reply function, one route

**`server/coach.js`** — delete `COMPOSER_SYSTEM` (273-369); rebuild `PLANNING_SYSTEM` from the same ten fragment consts (unchanged) plus merged prose:

1. **Role** — composes and pushes individual sessions, composes multi-week plans for review, **and edits any future workout on the Garmin calendar**. Both contradictions deleted: planning 176-177 ("you do NOT build multi-week blocks… That remains Runna's job") and composer 355 ("editing happens in PLANNING mode, not here").
2. `REPEAT_RULES`; read-the-calendar-first (composer 277-281, generalised) **plus a new hard rule**: *the Garmin calendar is the athlete's source of truth; never claim a day is empty, or that a workout doesn't exist, without a `get_scheduled_workouts` call covering that date.*
3. Assess-before-propose (planning 179-187, verbatim); Case 1 / Case 2 adaptation contract (composer 283-299) framed "when the ask is a multi-week plan".
4. `PACE_RULES`, `ARCHETYPES`, spec shape, `SPEC_RULES`, `SEGMENTING_RULES`; plan JSON shape + plan rules (composer 305-340).
5. **Merged flow** — single-session: prose → one session per turn → `[[PLAN_COMPLETE]]`; multi-week: prose outline → whole plan in ONE fence → validation relay → re-emit corrected.
6. **Editing the calendar — rewritten** (replaces planning 210-225): `planning.calendar` + the tool's `[id …]` tags are the id sources (copy verbatim, never invent). Editable = any listed future workout: app sessions **whatever their plan's status**, and `[garmin]` workouts **including Runna-synced ones** — *a Runna-created workout is an ordinary workout in the athlete's Garmin calendar; moving or removing it is fine (removal unschedules the calendar entry, the template stays in their library; Runna's feed may re-list the old date — that re-listed feed row can itself be removed)*. `[runna-feed]` rows are remove-only (relay the app's refusal message). Past frozen; drafts re-composed not edited. Directive shapes (214-217) unchanged; one edit per turn, nudge confirm-first, no-ripple, collision paragraph all kept. Add: when `spec_stale`, trust the Garmin title and offer to re-push.
7. `LIFECYCLE_RULES` (retarget its `planning.active_plan` reference at 154 → `planning.calendar`; add `queued`), `DISCARD_RULE`, `MEMORY_RULES`, merged app-notices / never-push-never-save / emission rule (**exactly ONE fence per turn — a session spec, a full plan, or an edit directive**) / feedback / `GUARD_RULES`.

**Extractor** — one `extractDirective(text)`: per fence, in order edit → plan (`sessions[]`) → spec (`blocks[]`), returning `{edit}|{plan}|{spec}|null`; fold in `extractEdit`/`extractPlan`, extend `specAttempted` with `"sessions"\s*:`.

**`planReply` (796-859)** — `max_tokens: 16000`; returns `{ reply, spec, edit, plan, done, specError }` (`planError` folds into `specError`); one one-shot repair loop with a merged reason. **Delete `composeReply` (887-931)** and its export.

**`server/server.js`** — `/api/coach/plan` (409-416) destructures the union and, when `plan` is present, runs the batch `runPacer('validate')` + valid/preview stamping lifted from the compose route (632-640). **Delete `/api/coach/compose` (625-643)**; delete `compose` from `web/src/api.js:51`.

## Step 6 — ChatWidget merge (`web/src/ChatWidget.jsx`; `PlanReview.jsx` untouched)

- Mode becomes `'chat' | 'planning'`; delete the derived `composer` (68) and its `enterMode` path.
- `runPlanTurn` (127-209) gains the plan branch from `runComposeTurn` (222-237) — the `[plan emitted: …]` marker and invalid-session relay — reusing the existing one-shot `canRelayFailure` re-entry (190-193). Delete `runComposeTurn` (215-251) and the composer dispatch in `send()` (296-299).
- Gates: `savePlan` (258) `!composer` → `!planning`; `PlanReview active={composer}` (560) → `active={planning}`; `push`/`applyEdit` already gate on `planning`.
- Chrome: the wide panel (`h-[620px] w-[560px]`, 438-442) now applies to the one mode; **delete the "Adapt" button (478-485)**; one "Plan" button; merged empty-state (520-528) and placeholder (689-693) copy covering sessions, plans and edits; `planError` rendering folds into the existing `specError` path.

## Step 7 — docs (`CLAUDE.md`, comments in `schema.pg.sql`)

New roadmap bullet **9f — unified planning mode + whole-calendar editing**: the mode merge (one persona/reply/route, `/api/coach/compose` deleted), the widened gate, reconcile's optional-id unschedule semantics, the SQL dedupe + Garmin-truth overlay, `planning.calendar`, and the `queued` status + transitions. Mark "(superseded in 9f)" on the 8c/9b/9d bullets describing two modes or the active-plan-only gate; update the "What this is" intro (line 5) and the API section's edit-endpoint scope; extend the `removed_at` note (line 51) to cover ical tombstones. Record two known edges: an app row can go stale against an out-of-band Garmin edit (surfaced as `spec_stale`, not auto-healed), and Runna's feed may re-list a removed workout's old date (the tombstone remove covers it).

## Verification

`KEY=$(grep '^API_SECRET=' server/.env | cut -d= -f2)`; API restart `launchctl kickstart -k gui/$(id -u)/com.garminhub.api`; frontend rebuild `bash deploy/local-macos/install.sh` (production build — no hot reload).

1. **Dedupe + overlay** — `curl -s -H "X-Api-Key: $KEY" 'localhost:3001/api/planned?from=2026-08-11&to=2026-08-26' | jq 'group_by(.calendar_date)|map(select(length>1))'` → `[]` (8 duplicated dates today). Aug 11 shows title **"…16km"** (Garmin truth) on the app row's `schedule_id -880300935221343886`. **Correction (raised by the implementer, verified):** `/api/coach/context-dump` renders `buildContext`, not `buildPlanningContext` (`renderContextDump`, context.js:603), so it can never show `planning.calendar`. Do **not** add an endpoint or extend the dump for this. Verify the planning context with a read-only Node probe instead — confirmed working:

```bash
node -e "
const { buildPlanningContext } = require('./server/context');
const { db } = require('./server/db');
(async () => {
  const a = await buildPlanningContext(db, []);
  const b = await buildPlanningContext(db, []);
  console.log('byte-stable:', JSON.stringify(a) === JSON.stringify(b));
  console.log(JSON.stringify(a.planning.calendar, null, 1));
  process.exit(0);
})();"
```

Expect: `byte-stable: true` (the prompt-cache requirement, checked directly rather than by eye), exact text ids, and `spec_stale: true` on the Aug 11 session.
2. **Gate rails** (409 with the right message): the ghost `1709786539` → "edit the app session instead"; a `runna_ical` row → the not-synced message; any past row → frozen history.
3. **Acceptance reshuffle, API level** — **the ids and dates below are stale: the athlete reshuffled this week by hand in Garmin Connect on 2026-08-11.** Run `POST /api/ingest/refresh` first, then re-derive the current session ids from `planned_workouts` and pick any two future app-plan sessions to move. Do not move a session to a date that already holds one. (Original, for shape only:) `POST /api/plan/session/-880300935221343886/move {"to_date":"2026-08-15"}` then `POST /api/plan/session/-99565088384309370/move {"to_date":"2026-08-11"}`. psql: one row per date across Aug 11–16, ghosts `1709786515`/`1709786560` gone; Garmin Connect calendar agrees; a following `POST /api/ingest/refresh` stays clean.
4. **Acceptance, chat level (the real test)** — Plan mode: *"reshuffle this week: today's long run to Saturday, Sunday's easy 11k to today, and add an easy 8k on Friday."* Expect correct session names (no "Runna workouts", no hallucinated-empty Sunday), one move directive per turn as confirm cards, then a fenced 8km easy spec for 2026-08-14 → preview → Push (the one-off lands via `persistAppRow`).
5. **Multi-week still works in the merged mode** — ask for a 2-week bridge plan → outline → one fenced plan → `PlanReview` with validation badges → Save → draft appears in `planning.plans`.
6. **Foreign edits** — schedule a workout manually in Garmin Connect, ingest, then move it (row re-keyed to the new positive schedule_id + date) and remove it (row deleted, calendar entry gone, **template still in Garmin → Workouts**). Remove a `runna_ical` row → `removed_at` set; `POST /api/ingest/refresh`; still tombstoned and absent from `/api/planned`.
7. **Lifecycle** — with the bridge plan active and a new non-overlapping plan activated, psql shows the running plan still `active` and the new one `queued`; after the active plan's end date passes, a `GET /api/plan/current` promotes the queued plan to `active`.
8. **UI** — one Plan button, wide accent-bordered panel, no "Adapt" anywhere in the built bundle.

## Suggested order of work

Steps 1–3 are independently testable and deliver most of the value (the coach can see and edit the real calendar); 5–6 are the mode merge; 4 is separable and can ship last.

1. Step 1 (reconcile ops) — pure Python, testable by piping JSON to `pacer_cli.py` directly.
2. Step 3 (dedupe + overlay + `planning.calendar` + tool ids) — fixes the hallucination surface; verify with checks 1–2.
3. Step 2 (gate + bookkeeping) — unlocks the reshuffle; verify with checks 2–3.
4. Steps 5–6 (prompt/route/UI merge) — verify with checks 4–5 and 8.
5. Step 4 (`queued` lifecycle) — verify with check 7.
6. Step 7 (docs) last, describing what actually shipped.

## Out of scope (do not build incidentally)

- Full queued-plan management (reordering, multiple queued plans, activation UI for a queue). Step 4 adds status honesty and auto-promotion only.
- 9e cross-session re-adaptation / rebalancing. Edits stay strictly in-place, no ripple.
- Auto-healing a stale app row against an out-of-band Garmin edit. Surface it as `spec_stale` and let the coach offer a re-push.
- String ids over the wire as a general fix for the >2^53 rounding TODO (`server/db.js`). Keep using `::text` at the specific call sites this plan touches.
- Any change to `/api/coach/chat`, the daily brief, ingest scheduling, or the dashboard's visual system.
