-- Garmin Hub schema
-- Design principle: typed columns for everything with coaching value,
-- plus a raw_json column per Garmin-sourced table as a fidelity safety net.

-- =========================================================================
-- activities — one row per completed run
-- =========================================================================
CREATE TABLE IF NOT EXISTS activities (
  activity_id                  INTEGER PRIMARY KEY,

  -- Identity / timing
  name                         TEXT,
  start_time_local             TEXT,    -- ISO 8601
  location_name                TEXT,
  activity_type                TEXT,    -- Garmin activityType.typeKey (e.g. running)
  activity_group               TEXT,    -- derived bucket: run/football/walk/other

  -- Distance / duration / speed
  distance_m                   REAL,
  duration_s                   REAL,
  moving_duration_s            REAL,
  elapsed_duration_s           REAL,
  avg_speed_mps                REAL,
  max_speed_mps                REAL,
  avg_grade_adjusted_speed_mps REAL,

  -- Energy
  calories                     REAL,
  bmr_calories                 REAL,
  steps                        INTEGER,
  lap_count                    INTEGER,

  -- Heart rate + zones (seconds in each zone)
  avg_hr                       INTEGER,
  max_hr                       INTEGER,
  hr_zone1_s                   REAL,
  hr_zone2_s                   REAL,
  hr_zone3_s                   REAL,
  hr_zone4_s                   REAL,
  hr_zone5_s                   REAL,

  -- Cadence
  avg_cadence_spm              REAL,
  max_cadence_spm              REAL,
  max_double_cadence           REAL,

  -- Power + zones (seconds in each zone)
  avg_power                    REAL,
  max_power                    REAL,
  norm_power                   REAL,
  power_zone1_s                REAL,
  power_zone2_s                REAL,
  power_zone3_s                REAL,
  power_zone4_s                REAL,
  power_zone5_s                REAL,

  -- Running dynamics
  avg_ground_contact_ms        REAL,
  avg_stride_length_cm         REAL,
  avg_vertical_oscillation_cm  REAL,
  avg_vertical_ratio           REAL,

  -- Training load / effect
  aerobic_training_effect      REAL,
  anaerobic_training_effect    REAL,
  training_effect_label        TEXT,
  activity_training_load       REAL,
  vo2max                       REAL,
  moderate_intensity_min       REAL,
  vigorous_intensity_min       REAL,
  difference_body_battery      REAL,

  -- Elevation
  elevation_gain_m             REAL,
  elevation_loss_m             REAL,
  avg_elevation_m              REAL,
  max_elevation_m              REAL,
  min_elevation_m              REAL,

  -- Geo (for weather backfill)
  start_lat                    REAL,
  start_lng                    REAL,
  end_lat                      REAL,
  end_lng                      REAL,

  -- Fastest splits (seconds)
  fastest_split_1000_s         REAL,
  fastest_split_1609_s         REAL,
  fastest_split_5000_s         REAL,

  -- Fidelity safety net
  raw_json                     TEXT
);

CREATE INDEX IF NOT EXISTS idx_activities_start_time_local
  ON activities (start_time_local);

-- =========================================================================
-- laps — splits per activity
-- =========================================================================
CREATE TABLE IF NOT EXISTS laps (
  activity_id                  INTEGER NOT NULL,
  lap_index                    INTEGER NOT NULL,

  distance_m                   REAL,
  duration_s                   REAL,
  moving_duration_s            REAL,
  avg_speed_mps                REAL,
  max_speed_mps                REAL,
  avg_grade_adjusted_speed_mps REAL,

  avg_hr                       INTEGER,
  max_hr                       INTEGER,

  avg_cadence_spm              REAL,
  max_cadence_spm              REAL,

  avg_power                    REAL,
  max_power                    REAL,
  norm_power                   REAL,

  ground_contact_ms            REAL,
  stride_length_cm             REAL,
  vertical_oscillation_cm      REAL,
  vertical_ratio               REAL,

  elevation_gain_m             REAL,
  elevation_loss_m             REAL,

  intensity_type               TEXT,    -- active vs recovery
  calories                     REAL,

  raw_json                     TEXT,

  PRIMARY KEY (activity_id, lap_index),
  FOREIGN KEY (activity_id) REFERENCES activities (activity_id)
);

-- =========================================================================
-- planned_workouts — one row per planned workout. Two sources: the Garmin
-- calendar sync (~2 weeks of Runna) and Runna's own ical feed (the full plan).
-- =========================================================================
CREATE TABLE IF NOT EXISTS planned_workouts (
  schedule_id                  INTEGER PRIMARY KEY,  -- Garmin calendar item id; ical rows use a negative UID hash

  workout_id                   INTEGER,
  calendar_date                TEXT,
  title                        TEXT,
  sport_type                   TEXT,
  is_race_auto                 INTEGER,              -- 0/1, keyword-derived; owned & overwritten by ingest
  is_race_override             INTEGER,              -- 0/1 manual override; NULL = none; ingest NEVER writes this
  estimated_distance_m         REAL,
  estimated_duration_s         REAL,
  steps_json                   TEXT,                 -- Garmin: parsed segments; ical: JSON array of description lines
  source                       TEXT,                 -- 'garmin' | 'runna_ical' (stale cleanup is per-source)

  raw_json                     TEXT
);

CREATE INDEX IF NOT EXISTS idx_planned_workouts_calendar_date
  ON planned_workouts (calendar_date);

-- =========================================================================
-- recovery — one row per calendar date (HRV, sleep, readiness, stress, etc.)
-- Consolidates several daily wellness payloads into a single typed row.
-- =========================================================================
CREATE TABLE IF NOT EXISTS recovery (
  calendar_date                TEXT PRIMARY KEY,

  -- HRV (get_hrv_data -> hrvSummary)
  hrv_last_night               INTEGER,
  hrv_weekly_avg               INTEGER,
  hrv_status                   TEXT,
  hrv_baseline_low             INTEGER,
  hrv_baseline_balanced_low    INTEGER,
  hrv_baseline_balanced_upper  INTEGER,

  -- Resting HR (get_rhr_day)
  resting_hr                   REAL,

  -- Sleep (get_sleep_data -> dailySleepDTO)
  sleep_seconds                INTEGER,
  deep_sleep_seconds           INTEGER,
  light_sleep_seconds          INTEGER,
  rem_sleep_seconds            INTEGER,
  awake_seconds                INTEGER,
  sleep_score                  INTEGER,
  sleep_score_qualifier        TEXT,
  avg_sleep_stress             REAL,

  -- Training readiness (get_training_readiness, most recent entry)
  readiness_score              INTEGER,
  readiness_level              TEXT,
  readiness_feedback           TEXT,
  recovery_time_minutes        REAL,
  acute_load                   REAL,
  sleep_factor_pct             INTEGER,
  recovery_time_factor_pct     INTEGER,
  acwr_factor_pct              INTEGER,
  stress_factor_pct            INTEGER,
  hrv_factor_pct               INTEGER,
  sleep_history_factor_pct     INTEGER,

  -- Training status (get_training_status)
  training_status              TEXT,
  vo2max                       REAL,

  -- Stress (get_all_day_stress)
  avg_stress                   INTEGER,
  max_stress                   INTEGER,

  -- Body Battery (get_body_battery, most recent entry)
  bb_charged                   INTEGER,
  bb_drained                   INTEGER,

  -- Fidelity safety net (consolidated dict of all source payloads)
  raw_json                     TEXT
);
-- PK already indexes calendar_date; no separate index needed.

-- =========================================================================
-- coach_notes — AI coaching output (our own data, no raw_json)
-- =========================================================================
CREATE TABLE IF NOT EXISTS coach_notes (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at                   TEXT,    -- ISO 8601
  note_type                    TEXT,    -- 'daily' / 'weekly' / 'ondemand'
  content                      TEXT,
  model                        TEXT,
  date_range_start             TEXT,
  date_range_end               TEXT
);

-- =========================================================================
-- profile — single-row coaching settings (id pinned to 1), injected into
-- AI-coach prompts. Edited via the settings modal (GET/POST /api/profile).
-- Shoes/races/injuries are growable lists, stored as JSON. Paces are NOT
-- stored — the coach infers them from actual run data.
-- =========================================================================
CREATE TABLE IF NOT EXISTS profile (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  shoes_json                   TEXT,    -- JSON array of {name, purpose}
  races_json                   TEXT,    -- JSON array of {name, date, goal_time}
  injuries_json                TEXT,    -- JSON array of constraint strings
  general_notes                TEXT,    -- anything else for the coach
  updated_at                   TEXT,    -- ISO 8601, set on each write
  lt_speed_mps                 REAL,    -- lactate threshold speed, TRUE m/s (ingest-owned)
  lt_hr                        INTEGER, -- lactate threshold heart rate, bpm (ingest-owned)
  lt_detected_date             TEXT,    -- LT source calendarDate (ISO), for staleness
  runna_ical_url               TEXT     -- Runna calendar-feed URL; ingest pulls the full plan from it
);
-- Seed the single empty row so callers always find one (idempotent).
INSERT OR IGNORE INTO profile (id) VALUES (1);

-- =========================================================================
-- personal_records — Garmin-sourced running PRs. One row per record type.
-- Read-only / ingest-owned (the user does NOT edit these). Kept separate from
-- the user-edited profile table so re-ingest can overwrite a beaten PR without
-- ever clobbering user edits (same isolation rationale as is_race_override).
-- =========================================================================
CREATE TABLE IF NOT EXISTS personal_records (
  type_id                      INTEGER PRIMARY KEY,  -- Garmin PR typeId (running: 1,2,3,4,5,7)
  label                        TEXT,                 -- human label ("5K", "Longest Run"…)
  value                        REAL,                 -- raw value: seconds (time) or metres (distance)
  value_kind                   TEXT,                 -- 'time' | 'distance'
  activity_id                  INTEGER,              -- source activity (NULL if not run-tied)
  record_date                  TEXT,                 -- ISO date the record was set
  raw_json                     TEXT
);

-- =========================================================================
-- race_predictions — Garmin's current predicted race times (all in seconds).
-- One row per prediction date (PK). Ingest-owned, read-only; callers read the
-- most recent row for "current" predictions.
-- =========================================================================
CREATE TABLE IF NOT EXISTS race_predictions (
  calendar_date                TEXT PRIMARY KEY,  -- Garmin's prediction date
  time_5k_s                    INTEGER,
  time_10k_s                   INTEGER,
  time_half_s                  INTEGER,
  time_marathon_s              INTEGER,
  fetched_at                   TEXT,              -- ISO date this prediction was ingested
  raw_json                     TEXT
);
