-- CreateEnum
CREATE TYPE "ScheduleVersionStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ScheduleVersionSource" AS ENUM ('generated', 'manual_save', 'restore');

-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "publishedVersionId" TEXT;

-- CreateTable
CREATE TABLE "ScheduleVersion" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "status" "ScheduleVersionStatus" NOT NULL DEFAULT 'draft',
    "source" "ScheduleVersionSource" NOT NULL,
    "authorId" TEXT,
    "authorLabel" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "config" JSONB,
    "restoredFromId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" TEXT,

    CONSTRAINT "ScheduleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleVersion_seasonId_createdAt_idx" ON "ScheduleVersion"("seasonId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduleVersion_status_idx" ON "ScheduleVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleVersion_seasonId_number_key" ON "ScheduleVersion"("seasonId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Season_publishedVersionId_key" ON "Season"("publishedVersionId");

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "ScheduleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleVersion" ADD CONSTRAINT "ScheduleVersion_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleVersion" ADD CONSTRAINT "ScheduleVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleVersion" ADD CONSTRAINT "ScheduleVersion_restoredFromId_fkey" FOREIGN KEY ("restoredFromId") REFERENCES "ScheduleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

