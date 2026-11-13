BEGIN;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'garmin';

ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_source_check;

ALTER TABLE activities
  ADD CONSTRAINT activities_source_check
  CHECK ((source = 'garmin' AND activity_id > 0)
      OR (source = 'apple_health' AND activity_id < 0));

COMMIT;
