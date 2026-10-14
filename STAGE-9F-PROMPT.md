# Prompt for Sol — Stage 9f implementation

Paste everything below the line.

---

You are implementing **Stage 9f** of garmin-hub, a personal single-user running-analytics app with an AI coaching layer. The repo is at `/Users/jackberry/Code/Projects/garmin-hub` (branch `main`).

## Read first, in this order

1. `CLAUDE.md` — the authoritative project context. Read all of it. It documents the architecture, the database contract, the staged roadmap, and the house rules.
2. `STAGE-9F-HANDOFF.md` — the specification for this work: the diagnosis, the decisions already made and confirmed by the athlete, seven implementation steps, a suggested order, an explicit out-of-scope list, and an end-to-end verification section.

Implement the handoff document. It is the spec; this prompt is how to work.

## What this change is, in one paragraph

The AI coach has two conversational composing modes (planning and composer) that confuse the user, and its workout-editing capability is gated to sessions of the one *active* plan. That gate locked the athlete out of editing their own current training week (its plan was archived while still mid-flight), and a related dedupe gap fed the coach duplicated, contradictory calendar data, causing it to hallucinate that a scheduled run didn't exist. Stage 9f merges the two modes into one, widens editing to any future workout on the Garmin calendar (including Runna-synced ones), fixes the duplication, and stops plan activation from archiving a plan that is still running.

## Working agreement

- **The athlete QAs each step group before you move to the next.** Follow the "Suggested order of work" in the handoff. Stop after each group, report, and wait. Do not run ahead.
- **Verify before you trust.** Every `file:line` reference in the handoff was accurate on 2026-08-11 and will have drifted. Re-locate each target by symbol or nearby text before editing; if what you find contradicts the handoff's description, **stop and say so** rather than editing what you assume was meant. The same goes for the handoff's factual claims — for example, it asserts that ingest's `upsert()` only SETs columns present in the row dict (so a `removed_at` tombstone survives re-ingest). Confirm that in the code before building on it.
- **Flag deviations, don't improvise.** If a directive turns out to be wrong, impossible, or clearly worse than an alternative, halt and explain the problem with evidence. Do not silently substitute a different design.
- **Keep it lean.** This is the project's cardinal rule: brief files, no speculative abstraction, no new dependencies, no helper layers the spec didn't ask for. Match the surrounding code's style, naming and comment density. If you find yourself adding a module, a config flag, or a generalisation the handoff doesn't name, that's a signal to stop and ask.
- **Scope discipline.** The handoff's "Out of scope" section is binding.

## Safety — read carefully

- **`ingest/pacer_cli.py` push and reconcile write to the athlete's real Garmin Connect account.** These are live, externally-visible mutations of a real training calendar. Never run them speculatively, never to "see what happens", and never as part of exploration. Before any command that mutates Garmin or the database, state plainly what it will do and wait for explicit go-ahead.
- Read-only work needs no permission: reading files, `psql garminhub` SELECTs, `curl` GETs against the local API, and `pacer_cli.py validate` (which makes no network calls).
- **No schema DDL.** Every column this work needs already exists. `db/schema.pg.sql` is documentation-and-fresh-setup only; it cannot alter live tables. If you become convinced a migration is genuinely required, stop and raise it.
- Do not delete training data. Plans and their history are retained by design.
- Do not commit or push unless asked. Leave changes in the working tree for review.

## Environment

- API: Express on `127.0.0.1:3001`, behind a shared secret. `KEY=$(grep '^API_SECRET=' server/.env | cut -d= -f2)`, then send `-H "X-Api-Key: $KEY"`.
- **Server changes need a restart:** `launchctl kickstart -k gui/$(id -u)/com.garminhub.api`.
- **Frontend changes do NOT hot-reload.** `:4173` serves a production build. To see any change: `bash deploy/local-macos/install.sh` (rebuilds and reloads the launchd services).
- Python is Homebrew 3.13 at `/usr/local/bin/python3.13`, never Apple's system Python.
- Database: `psql garminhub`. All `*_json` columns are real `jsonb` — the driver returns parsed objects, so never `JSON.parse` a column value.
- There is no automated test suite. Verification is the manual curl/psql sequence in the handoff.

## Traps specific to this work

These are the places most likely to produce a plausible-but-wrong implementation:

- **Never `clearGhosts` on a foreign (`source='garmin'`) row you just edited** — it matches on `workout_id` alone and would delete the row you re-keyed.
- **Bind schedule ids as text into `$n::bigint`.** The app's negative hash ids exceed JavaScript's 2^53 integer precision; passing them as Numbers rounds them silently.
- **`runna_ical` rows have no `workout_id`** — nothing exists on Garmin for them. They are removable as a database tombstone only; move and replace must refuse them with the message the handoff specifies, because the coach relays it to the athlete verbatim.
- **A `source='garmin'` row's `steps_json` is Garmin's `workoutSegments`, not a buildable spec.** Skip the stored-spec re-validation for those rows or it will fail.
- **Prompt-cache byte-stability is real money.** `buildContext` / `buildPlanningContext` output is sent as a cached system block on every coach call. Anything you add there must be byte-identical between calls: no timestamps, no randomness, stable ordering.
- **New-state-first ordering in reconcile is deliberate** — schedule the new date before unscheduling the old, so a session can never vanish mid-operation. A failure in the second half degrades to a `warning` about double-listing. Preserve that.
- Garmin-succeeded-but-database-write-failed must degrade to `recorded: false`, never a 500 — a blind retry would double-book the calendar.

## Reporting

After each step group, report: files changed and what changed in each; any deviation from the handoff with your reasoning; the verification commands you ran with their **actual output** (not a claim that they passed); and anything you could not verify and why. If something failed, say so plainly and show the output.
