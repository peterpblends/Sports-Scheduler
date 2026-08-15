-- Denormalise the game count onto ScheduleVersion.
--
-- Listing a season's versions used to `include` the model without a `select`, which
-- made Prisma fetch every column — including `snapshot`, a JSON document holding one
-- entry per game in the season — and then JSON-parse each one purely to report a
-- count. For a 20k-game season with a few dozen versions that is the entire schedule
-- history loaded and parsed to render a list, on an endpoint any scheduler can call.
--
-- The count is safe to denormalise: a snapshot is written once at version creation
-- and never updated, which is the invariant the whole revision-history feature rests
-- on.

ALTER TABLE "ScheduleVersion" ADD COLUMN "gameCount" INTEGER NOT NULL DEFAULT 0;

-- Back-fill from the existing snapshots. `jsonb_array_length` runs inside the
-- database, so nothing is transferred to the application to do this.
UPDATE "ScheduleVersion"
SET "gameCount" = COALESCE(jsonb_array_length(("snapshot"::jsonb) -> 'games'), 0)
WHERE "snapshot" IS NOT NULL
  AND jsonb_typeof(("snapshot"::jsonb) -> 'games') = 'array';
