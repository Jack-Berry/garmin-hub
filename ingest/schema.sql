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
-- planned_workouts — one row per Runna planned workout
-- =========================================================================
CREATE TABLE IF NOT EXISTS planned_workouts (
  schedule_id                  INTEGER PRIMARY KEY,  -- calendar item id

  workout_id                   INTEGER,
  calendar_date                TEXT,
  title                        TEXT,
  sport_type                   TEXT,
  is_race                      INTEGER,              -- 0/1
  estimated_distance_m         REAL,
  estimated_duration_s         REAL,
  steps_json                   TEXT,                 -- parsed step structure

  raw_json                     TEXT
);

CREATE INDEX IF NOT EXISTS idx_planned_workouts_calendar_date
  ON planned_workouts (calendar_date);

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
