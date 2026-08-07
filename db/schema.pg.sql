-- Garmin Hub — PostgreSQL schema.
-- Port of the LIVE SQLite schema (including migration-added columns like
-- profile.routines_json). Stage 5a promoted the date/time columns to real
-- types (timestamp / date / timestamptz); stage 5b promoted every *_json /
-- raw_json column to jsonb. Column order matches the live SQLite tables
-- (migrated columns last).
--
-- Type mapping:
--   INTEGER Garmin ids -> bigint  (activity ids ~23.5B and negative 60-bit ical
--                                  schedule-id hashes overflow int4)
--   REAL               -> double precision
--   INTEGER HR columns -> double precision (SQLite affinity let a real into
--                         activities.avg_hr; all HR-type columns widened)
--   is_race_auto/override -> smallint, nullable (NULL override = "no override";
--                            API contract is 0/1/null, unchanged)
-- All other INTEGER columns audited clean in the live DB and stay integer.
--
-- Apply with: db/setup_local.sh (creates roles + database first).

CREATE TABLE IF NOT EXISTS activities (
  activity_id                  bigint PRIMARY KEY,

  -- Identity / timing
  name                         text,
  start_time_local             timestamp,  -- local time, no zone (Garmin startTimeLocal)
  location_name                text,

  -- Distance / duration / speed
  distance_m                   double precision,
  duration_s                   double precision,
  moving_duration_s            double precision,
  elapsed_duration_s           double precision,
  avg_speed_mps                double precision,
  max_speed_mps                double precision,
  avg_grade_adjusted_speed_mps double precision,

  -- Energy
  calories                     double precision,
  bmr_calories                 double precision,
  steps                        integer,
  lap_count                    integer,

  -- Heart rate + zones (seconds in each zone)
  avg_hr                       double precision,
  max_hr                       double precision,
  hr_zone1_s                   double precision,
  hr_zone2_s                   double precision,
  hr_zone3_s                   double precision,
  hr_zone4_s                   double precision,
  hr_zone5_s                   double precision,

  -- Cadence
  avg_cadence_spm              double precision,
  max_cadence_spm              double precision,
  max_double_cadence           double precision,

  -- Power + zones (seconds in each zone)
  avg_power                    double precision,
  max_power                    double precision,
  norm_power                   double precision,
  power_zone1_s                double precision,
  power_zone2_s                double precision,
  power_zone3_s                double precision,
  power_zone4_s                double precision,
  power_zone5_s                double precision,

  -- Running dynamics
  avg_ground_contact_ms        double precision,
  avg_stride_length_cm         double precision,
  avg_vertical_oscillation_cm  double precision,
  avg_vertical_ratio           double precision,

  -- Training load / effect
  aerobic_training_effect      double precision,
  anaerobic_training_effect    double precision,
  training_effect_label        text,
  activity_training_load       double precision,
  vo2max                       double precision,
  moderate_intensity_min       double precision,
  vigorous_intensity_min       double precision,
  difference_body_battery      double precision,

  -- Elevation
  elevation_gain_m             double precision,
  elevation_loss_m             double precision,
  avg_elevation_m              double precision,
  max_elevation_m              double precision,
  min_elevation_m              double precision,

  -- Geo (for weather backfill)
  start_lat                    double precision,
  start_lng                    double precision,
  end_lat                      double precision,
  end_lng                      double precision,

  -- Fastest splits (seconds)
  fastest_split_1000_s         double precision,
  fastest_split_1609_s         double precision,
  fastest_split_5000_s         double precision,

  -- Fidelity safety net
  raw_json                     jsonb,

  -- Appended by SQLite migration (live column order preserved)
  activity_type                text,    -- Garmin activityType.typeKey
  activity_group               text     -- derived bucket: run/football/walk/other
);

CREATE INDEX IF NOT EXISTS idx_activities_start_time_local
  ON activities (start_time_local);

CREATE TABLE IF NOT EXISTS laps (
  activity_id                  bigint NOT NULL,
  lap_index                    integer NOT NULL,

  distance_m                   double precision,
  duration_s                   double precision,
  moving_duration_s            double precision,
  avg_speed_mps                double precision,
  max_speed_mps                double precision,
  avg_grade_adjusted_speed_mps double precision,

  avg_hr                       double precision,
  max_hr                       double precision,

  avg_cadence_spm              double precision,
  max_cadence_spm              double precision,

  avg_power                    double precision,
  max_power                    double precision,
  norm_power                   double precision,

  ground_contact_ms            double precision,
  stride_length_cm             double precision,
  vertical_oscillation_cm      double precision,
  vertical_ratio               double precision,

  elevation_gain_m             double precision,
  elevation_loss_m             double precision,

  intensity_type               text,    -- active vs recovery
  calories                     double precision,

  raw_json                     jsonb,

  PRIMARY KEY (activity_id, lap_index),
  FOREIGN KEY (activity_id) REFERENCES activities (activity_id)
);

CREATE TABLE IF NOT EXISTS planned_workouts (
  schedule_id                  bigint PRIMARY KEY,  -- Garmin calendar item id; ical rows use a negative UID hash
  workout_id                   bigint,
  calendar_date                date,
  title                        text,
  sport_type                   text,
  estimated_distance_m         double precision,
  estimated_duration_s         double precision,
  steps_json                   jsonb,               -- Garmin: parsed segments; ical: JSON array of description lines
  raw_json                     jsonb,

  -- Appended by SQLite migrations (live column order preserved)
  is_race_auto                 smallint,            -- 0/1, keyword-derived; ingest-owned
  is_race_override             smallint,            -- 0/1 manual override; NULL = none (semantic)
  source                       text,                -- 'garmin' | 'runna_ical' | 'app' (app = API-written, ingest never touches)

  -- Appended by Stage 9a (app-generated plans)
  plan_id                      text,                -- app rows: owning adapted-plan id; NULL = one-off push / non-app row
  rationale                    text,                -- app rows: per-session "why" from the coach
  removed_at                   timestamptz          -- Stage 9d soft-delete (app rows only): NULL = live; set = session dropped from the plan (kept for history / 9e load-awareness), excluded from every read path
);

CREATE INDEX IF NOT EXISTS idx_planned_workouts_calendar_date
  ON planned_workouts (calendar_date);

-- Adapted-plan parents (Stage 9c/9d). One row per saved plan; planned_workouts
-- app rows point here via plan_id. Holds the plan-level metadata the composer
-- generates (name/goal/summary/weeks) plus the plan lifecycle. Per-session
-- push state lives on planned_workouts (workout_id NULL = not yet pushed).
--
-- status lifecycle (Stage 9d) — forward-only, nothing ever moves backward:
--   'draft'     saved, not yet pushed to Garmin
--   'active'    every session pushed (the 9c activation flip). At most ONE
--               plan is active at a time, enforced at activation: flipping a
--               plan to active retires any other active plan (below).
--   'completed' block finished — goal race date (parsed from goal_race text,
--               falling back to date_to) has passed. Set automatically on
--               /api/plan/current load; also the retirement target at
--               activation when the outgoing active plan is already finished.
--   'archived'  superseded while still live — another plan activated before
--               this one finished (the re-adaptation case 9e leans on).
--   'discarded' abandoned draft — superseded by a newer saved draft (draft
--               hygiene: a new save discards prior drafts + their session rows).
-- Legal transitions: draft -> active | discarded; active -> completed | archived.
-- All statuses are retained as history — nothing in the lifecycle deletes a plan,
-- with ONE exception (9d-2): an athlete-requested discard of a DRAFT
-- (POST /api/plan/:plan_id/discard) hard-deletes the plan row and its session
-- rows. Draft-only, and only while no session carries a workout_id — a draft
-- has nothing on Garmin and no run history, so there is nothing to preserve.
-- Draft visibility (9d-2): a draft's sessions are dormant — excluded from every
-- default read surface and from app-plan precedence until activation flips the
-- plan to 'active'. Drafts surface only via /api/plan/current (the Activate
-- card) and the planning context's plan-lifecycle list.
-- runna_cleared_at (9d-3): athlete-asserted "Runna is cancelled / nothing to
-- cancel" — the manual override for the post-push cancel-Runna gate, set via
-- POST /api/plan/:plan_id/runna-cleared. NULL = not asserted (the gate clears
-- itself when the plan's date span holds no live Runna rows). Never written by
-- ingest; the feed check can't hold the athlete hostage.
CREATE TABLE IF NOT EXISTS plans (
  plan_id                      text PRIMARY KEY,    -- matches planned_workouts.plan_id
  name                         text,
  goal_race                    text,
  summary                      text,
  weeks_json                   jsonb,               -- composer weeks[] verbatim (start/focus lines)
  date_from                    date,
  date_to                      date,
  status                       text NOT NULL DEFAULT 'draft',  -- see lifecycle above
  created_at                   timestamptz,
  runna_cleared_at             timestamptz          -- 9d-3 manual cancel-gate override
);

CREATE TABLE IF NOT EXISTS recovery (
  calendar_date                date PRIMARY KEY,

  -- HRV
  hrv_last_night               integer,
  hrv_weekly_avg               integer,
  hrv_status                   text,
  hrv_baseline_low             integer,
  hrv_baseline_balanced_low    integer,
  hrv_baseline_balanced_upper  integer,

  -- Resting HR
  resting_hr                   double precision,

  -- Sleep
  sleep_seconds                integer,
  deep_sleep_seconds           integer,
  light_sleep_seconds          integer,
  rem_sleep_seconds            integer,
  awake_seconds                integer,
  sleep_score                  integer,
  sleep_score_qualifier        text,
  avg_sleep_stress             double precision,

  -- Training readiness
  readiness_score              integer,
  readiness_level              text,
  readiness_feedback           text,
  recovery_time_minutes        double precision,
  acute_load                   double precision,
  sleep_factor_pct             integer,
  recovery_time_factor_pct     integer,
  acwr_factor_pct              integer,
  stress_factor_pct            integer,
  hrv_factor_pct               integer,
  sleep_history_factor_pct     integer,

  -- Training status
  training_status              text,
  vo2max                       double precision,

  -- Stress
  avg_stress                   integer,
  max_stress                   integer,

  -- Body Battery
  bb_charged                   integer,
  bb_drained                   integer,

  raw_json                     jsonb
);

CREATE TABLE IF NOT EXISTS coach_notes (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at                   timestamptz,
  note_type                    text,    -- 'daily' / 'weekly' / 'ondemand' / 'memory' (coach's silent persistent facts)
  content                      text,
  model                        text,
  date_range_start             date,
  date_range_end               date
);

CREATE TABLE IF NOT EXISTS profile (
  id                           integer PRIMARY KEY CHECK (id = 1),
  shoes_json                   jsonb,
  races_json                   jsonb,
  injuries_json                jsonb,
  general_notes                text,
  updated_at                   timestamptz,

  -- Appended by SQLite migrations (live column order preserved)
  routines_json                jsonb,   -- migration-only in SQLite; NOT in ingest/schema.sql
  lt_speed_mps                 double precision,  -- ingest-owned LT trio
  lt_hr                        double precision,
  lt_detected_date             timestamp,  -- full Garmin timestamp despite the name
  runna_ical_url               text
);
-- Seed the single row so callers always find one (idempotent).
INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS personal_records (
  type_id                      integer PRIMARY KEY,  -- Garmin PR typeId (running: 1,2,3,4,5,7)
  label                        text,
  value                        double precision,     -- seconds (time) or metres (distance)
  value_kind                   text,                 -- 'time' | 'distance'
  activity_id                  bigint,               -- source activity id (~23B — bigint required)
  record_date                  date,
  raw_json                     jsonb
);

CREATE TABLE IF NOT EXISTS race_predictions (
  calendar_date                date PRIMARY KEY,
  time_5k_s                    integer,
  time_10k_s                   integer,
  time_half_s                  integer,
  time_marathon_s              integer,
  fetched_at                   date,
  raw_json                     jsonb
);

-- =========================================================================
-- Grants — mirror the Node db/writeDb split with real database roles.
-- garminhub_ro: SELECT only (Node's read-only `db` connection).
-- garminhub_rw: DML only, no DDL (Node's writeDb + the Python ingest).
-- Roles are created by setup_local.sh; DDL runs as the superuser/owner.
-- =========================================================================
REVOKE CREATE ON SCHEMA public FROM PUBLIC;  -- PG14 default is too permissive
GRANT USAGE ON SCHEMA public TO garminhub_ro, garminhub_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO garminhub_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO garminhub_rw;
-- UPDATE on sequences permits only nextval/setval (no DDL) — the data-load
-- ETL needs setval to reposition the coach_notes identity after loading ids.
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO garminhub_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO garminhub_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO garminhub_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO garminhub_rw;
