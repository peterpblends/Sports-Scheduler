-- Database-level guards for the officiating races the application could only
-- narrow, not close.
--
-- Every one of these rules was previously enforced by reading a row, deciding, and
-- then inserting — which under Postgres's default READ COMMITTED lets two concurrent
-- requests both observe "nobody holds this position" and both insert. The result was
-- two centre officials on one game, or one referee on a crew twice, with no error
-- reported to anybody.
--
-- These are PARTIAL unique indexes and must stay that way. The predicates matter:
--
--   * `"deletedAt" IS NULL` — a soft-deleted assignment must not keep occupying a
--     position forever, or the slot could never be reused.
--   * `status <> 'declined'` — a declined assignment frees the position back up.
--     That is the whole point of declining, and it is exactly how
--     `openPositionsFor` in src/lib/officiating.ts defines an open slot. A unique
--     index without this clause would forbid the entirely legitimate state of "the
--     original official declined and somebody else took the game", which is the
--     normal outcome of the request flow.
--
-- Prisma's schema language cannot express a partial index, so these live in raw SQL
-- and are documented in schema.prisma next to the models they constrain. Do not
-- "resolve the drift" by deleting them.

-- One official holds a given position on a given game.
CREATE UNIQUE INDEX "GameOfficial_game_position_held_key"
    ON "GameOfficial" ("gameId", "position")
    WHERE "deletedAt" IS NULL AND status <> 'declined';

-- A referee appears on a crew at most once, whatever the position.
CREATE UNIQUE INDEX "GameOfficial_game_referee_held_key"
    ON "GameOfficial" ("gameId", "refereeId")
    WHERE "deletedAt" IS NULL AND status <> 'declined';

-- A referee has at most one live request outstanding per game. The application
-- already refuses a second one; this makes two simultaneous ones impossible rather
-- than merely unlikely.
CREATE UNIQUE INDEX "OfficiatingRequest_game_referee_pending_key"
    ON "OfficiatingRequest" ("gameId", "refereeId")
    WHERE "deletedAt" IS NULL AND status = 'pending';
