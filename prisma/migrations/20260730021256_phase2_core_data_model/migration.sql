-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('player', 'coach', 'assistant', 'manager');

-- CreateEnum
CREATE TYPE "RelationshipKind" AS ENUM ('family', 'guardian', 'other');

-- CreateEnum
CREATE TYPE "AvailabilityKind" AS ENUM ('weekly', 'blackout');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('scheduled', 'confirmed', 'played', 'postponed', 'cancelled');

-- CreateEnum
CREATE TYPE "OfficialPosition" AS ENUM ('center', 'AR1', 'AR2', 'scorekeeper');

-- CreateEnum
CREATE TYPE "AcceptanceStatus" AS ENUM ('pending', 'accepted', 'declined');

-- CreateEnum
CREATE TYPE "BlackoutScope" AS ENUM ('org', 'division', 'team', 'venue');

-- CreateTable
CREATE TABLE "League" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sport" TEXT NOT NULL DEFAULT 'soccer',
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "League_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Division" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "logoUrl" TEXT,
    "preferredVenueId" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "dob" DATE,
    "notes" TEXT,
    "userId" TEXT,
    "hasConflictOfInterest" BOOLEAN NOT NULL DEFAULT false,
    "conflictNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonRelationship" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "relatedPersonId" TEXT NOT NULL,
    "kind" "RelationshipKind" NOT NULL DEFAULT 'family',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PersonRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'player',
    "jerseyNumber" TEXT,
    "activeFrom" DATE,
    "activeTo" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referee" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "certificationLevel" TEXT,
    "payRateCents" INTEGER,
    "maxGamesPerDay" INTEGER NOT NULL DEFAULT 3,
    "travelBufferMinutes" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Referee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefereeAvailability" (
    "id" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "kind" "AvailabilityKind" NOT NULL,
    "dayOfWeek" INTEGER,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RefereeAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Field" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeSlot" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "specificDate" DATE,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "fieldId" TEXT,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "status" "GameStatus" NOT NULL DEFAULT 'scheduled',
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "roundNumber" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameOfficial" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "position" "OfficialPosition" NOT NULL,
    "status" "AcceptanceStatus" NOT NULL DEFAULT 'pending',
    "payRateCentsOverride" INTEGER,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "GameOfficial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackoutDate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scope" "BlackoutScope" NOT NULL,
    "divisionId" TEXT,
    "teamId" TEXT,
    "venueId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BlackoutDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_RefereePreferredVenues" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RefereePreferredVenues_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "League_orgId_deletedAt_idx" ON "League"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "Season_leagueId_deletedAt_idx" ON "Season"("leagueId", "deletedAt");

-- CreateIndex
CREATE INDEX "Division_seasonId_deletedAt_idx" ON "Division"("seasonId", "deletedAt");

-- CreateIndex
CREATE INDEX "Team_divisionId_deletedAt_idx" ON "Team"("divisionId", "deletedAt");

-- CreateIndex
CREATE INDEX "Team_preferredVenueId_idx" ON "Team"("preferredVenueId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_userId_key" ON "Person"("userId");

-- CreateIndex
CREATE INDEX "Person_orgId_deletedAt_idx" ON "Person"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "Person_orgId_email_idx" ON "Person"("orgId", "email");

-- CreateIndex
CREATE INDEX "PersonRelationship_relatedPersonId_idx" ON "PersonRelationship"("relatedPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonRelationship_personId_relatedPersonId_kind_key" ON "PersonRelationship"("personId", "relatedPersonId", "kind");

-- CreateIndex
CREATE INDEX "TeamMembership_teamId_deletedAt_idx" ON "TeamMembership"("teamId", "deletedAt");

-- CreateIndex
CREATE INDEX "TeamMembership_personId_deletedAt_idx" ON "TeamMembership"("personId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Referee_personId_key" ON "Referee"("personId");

-- CreateIndex
CREATE INDEX "Referee_deletedAt_idx" ON "Referee"("deletedAt");

-- CreateIndex
CREATE INDEX "RefereeAvailability_refereeId_deletedAt_idx" ON "RefereeAvailability"("refereeId", "deletedAt");

-- CreateIndex
CREATE INDEX "Venue_orgId_deletedAt_idx" ON "Venue"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "Field_venueId_deletedAt_idx" ON "Field"("venueId", "deletedAt");

-- CreateIndex
CREATE INDEX "TimeSlot_fieldId_deletedAt_idx" ON "TimeSlot"("fieldId", "deletedAt");

-- CreateIndex
CREATE INDEX "Game_seasonId_startTime_idx" ON "Game"("seasonId", "startTime");

-- CreateIndex
CREATE INDEX "Game_divisionId_startTime_idx" ON "Game"("divisionId", "startTime");

-- CreateIndex
CREATE INDEX "Game_fieldId_startTime_idx" ON "Game"("fieldId", "startTime");

-- CreateIndex
CREATE INDEX "Game_homeTeamId_idx" ON "Game"("homeTeamId");

-- CreateIndex
CREATE INDEX "Game_awayTeamId_idx" ON "Game"("awayTeamId");

-- CreateIndex
CREATE INDEX "Game_deletedAt_idx" ON "Game"("deletedAt");

-- CreateIndex
CREATE INDEX "GameOfficial_gameId_deletedAt_idx" ON "GameOfficial"("gameId", "deletedAt");

-- CreateIndex
CREATE INDEX "GameOfficial_refereeId_deletedAt_idx" ON "GameOfficial"("refereeId", "deletedAt");

-- CreateIndex
CREATE INDEX "BlackoutDate_orgId_startDate_idx" ON "BlackoutDate"("orgId", "startDate");

-- CreateIndex
CREATE INDEX "BlackoutDate_divisionId_idx" ON "BlackoutDate"("divisionId");

-- CreateIndex
CREATE INDEX "BlackoutDate_teamId_idx" ON "BlackoutDate"("teamId");

-- CreateIndex
CREATE INDEX "BlackoutDate_venueId_idx" ON "BlackoutDate"("venueId");

-- CreateIndex
CREATE INDEX "_RefereePreferredVenues_B_index" ON "_RefereePreferredVenues"("B");

-- AddForeignKey
ALTER TABLE "League" ADD CONSTRAINT "League_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_preferredVenueId_fkey" FOREIGN KEY ("preferredVenueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonRelationship" ADD CONSTRAINT "PersonRelationship_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonRelationship" ADD CONSTRAINT "PersonRelationship_relatedPersonId_fkey" FOREIGN KEY ("relatedPersonId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referee" ADD CONSTRAINT "Referee_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefereeAvailability" ADD CONSTRAINT "RefereeAvailability_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Referee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeSlot" ADD CONSTRAINT "TimeSlot_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameOfficial" ADD CONSTRAINT "GameOfficial_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameOfficial" ADD CONSTRAINT "GameOfficial_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Referee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RefereePreferredVenues" ADD CONSTRAINT "_RefereePreferredVenues_A_fkey" FOREIGN KEY ("A") REFERENCES "Referee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RefereePreferredVenues" ADD CONSTRAINT "_RefereePreferredVenues_B_fkey" FOREIGN KEY ("B") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
