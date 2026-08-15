-- Referee-initiated requests to officiate a game.
--
-- Its own table rather than a new GameOfficial status: a GameOfficial row means
-- "on the crew" throughout the application, and conflict detection treats any
-- non-declined assignment as consuming the referee's time and daily cap. A
-- request must not do either until it is approved.

CREATE TYPE "OfficiatingRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

CREATE TABLE "OfficiatingRequest" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "position" "OfficialPosition" NOT NULL,
    "status" "OfficiatingRequestStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OfficiatingRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OfficiatingRequest_refereeId_status_deletedAt_idx"
    ON "OfficiatingRequest"("refereeId", "status", "deletedAt");

CREATE INDEX "OfficiatingRequest_gameId_deletedAt_idx"
    ON "OfficiatingRequest"("gameId", "deletedAt");

ALTER TABLE "OfficiatingRequest" ADD CONSTRAINT "OfficiatingRequest_gameId_fkey"
    FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OfficiatingRequest" ADD CONSTRAINT "OfficiatingRequest_refereeId_fkey"
    FOREIGN KEY ("refereeId") REFERENCES "Referee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OfficiatingRequest" ADD CONSTRAINT "OfficiatingRequest_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Defaulting to on: a referee who asked for a game wants to hear the answer, and
-- an assigner needs to know a request is waiting. The column default means an
-- existing row needs no back-fill.
ALTER TABLE "NotificationPreference"
    ADD COLUMN "officiatingRequest" BOOLEAN NOT NULL DEFAULT true;
