BEGIN;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'garmin';

ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_source_check;

ALTER TABLE activities
  ADD CONSTRAINT activities_source_check
  CHECK ((source = 'garmin' AND activity_id > 0)
      OR (source = 'apple_health' AND activity_id < 0));

CREATE OR REPLACE FUNCTION activity_windows_overlap(
  activity_start timestamp, activity_duration_s double precision,
  candidate_start timestamp, candidate_end timestamp
) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT activity_start IS NOT NULL
     AND activity_duration_s IS NOT NULL
     AND candidate_start IS NOT NULL
     AND candidate_end IS NOT NULL
     AND activity_start < candidate_end
     AND activity_start + activity_duration_s * interval '1 second' > candidate_start
$$;

COMMIT;
