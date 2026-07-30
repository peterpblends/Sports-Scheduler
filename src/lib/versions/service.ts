import { prisma } from '../prisma'
import { recordAudit, recordAuditMany, type AuditInput } from '../audit'
import { conflict, notFound } from '../http'
import { parseSnapshot, type GameSnapshot, type ScheduleSnapshot } from './snapshot'
import type {
  AcceptanceStatus,
  GameStatus,
  OfficialPosition,
  Prisma,
  ScheduleVersionSource,
} from '@prisma/client'

/**
 * Creating, publishing and restoring schedule versions.
 *
 * Three rules hold throughout, and they are what make the history trustworthy:
 *
 *  1. A version's `snapshot` is written once and never updated.
 *  2. Restoring writes a **new** version rather than deleting the ones after it, so
 *     the history only ever grows (non-negotiable #2).
 *  3. Games are soft-deleted when replaced, so the rows behind an old version are
 *     still reachable even though the version does not depend on them.
 */

type Actor = { userId: string; email: string }

/** Reads the season's current live games into an immutable snapshot. */
export async function captureSnapshot(
  seasonId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<ScheduleSnapshot> {
  const games = await tx.game.findMany({
    where: { seasonId, deletedAt: null },
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    include: {
      division: { select: { id: true, name: true } },
      homeTeam: { select: { id: true, name: true } },
      awayTeam: { select: { id: true, name: true } },
      field: { include: { venue: { select: { id: true, name: true, timezone: true } } } },
      officials: {
        where: { deletedAt: null },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: { referee: { include: { person: { select: { name: true } } } } },
      },
    },
  })

  return {
    snapshotVersion: 1,
    seasonId,
    takenAt: new Date().toISOString(),
    games: games.map(
      (game): GameSnapshot => ({
        gameId: game.id,
        divisionId: game.divisionId,
        divisionName: game.division.name,
        homeTeamId: game.homeTeamId,
        homeTeamName: game.homeTeam.name,
        awayTeamId: game.awayTeamId,
        awayTeamName: game.awayTeam.name,
        fieldId: game.fieldId,
        fieldName: game.field?.name ?? null,
        venueId: game.field?.venueId ?? null,
        venueName: game.field?.venue.name ?? null,
        timezone: game.field?.venue.timezone ?? null,
        startTime: game.startTime.toISOString(),
        durationMinutes: game.durationMinutes,
        status: game.status,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        roundNumber: game.roundNumber,
        notes: game.notes,
        officials: game.officials.map((official) => ({
          refereeId: official.refereeId,
          refereeName: official.referee.person.name,
          position: official.position,
          status: official.status,
        })),
      }),
    ),
  }
}

/**
 * Writes a new version for a season.
 *
 * The number is the season's current maximum plus one, computed inside the caller's
 * transaction. Two concurrent creations race on `@@unique([seasonId, number])`; the
 * loser gets a unique violation and can retry, which is the right trade for keeping
 * numbers gapless and readable.
 */
export async function createVersion(
  input: {
    orgId: string
    seasonId: string
    actor: Actor
    source: ScheduleVersionSource
    label?: string
    note?: string
    config?: Prisma.InputJsonValue
    restoredFromId?: string
    /** Used to build the default label for a restore, e.g. "v3 — restored from v1". */
    restoredFromNumber?: number
    /** Defaults to capturing the season's current live games. */
    snapshot?: ScheduleSnapshot
  },
  tx: Prisma.TransactionClient,
): Promise<{ id: string; number: number; label: string }> {
  const snapshot = input.snapshot ?? (await captureSnapshot(input.seasonId, tx))

  const latest = await tx.scheduleVersion.findFirst({
    where: { seasonId: input.seasonId },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const number = (latest?.number ?? 0) + 1
  const label =
    input.label?.trim() || defaultLabel(input.source, number, input.restoredFromNumber)

  const version = await tx.scheduleVersion.create({
    data: {
      seasonId: input.seasonId,
      number,
      label,
      note: input.note ?? null,
      source: input.source,
      authorId: input.actor.userId,
      authorLabel: input.actor.email,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      config: input.config ?? undefined,
      restoredFromId: input.restoredFromId ?? null,
    },
    select: { id: true, number: true, label: true },
  })

  await recordAudit(
    {
      orgId: input.orgId,
      actorId: input.actor.userId,
      actorLabel: input.actor.email,
      entityType: 'ScheduleVersion',
      entityId: version.id,
      action: `version.${input.source === 'manual_save' ? 'saved' : input.source}`,
      diff: {
        number: { before: latest?.number ?? null, after: number },
        games: { before: null, after: snapshot.games.length },
      },
      meta: {
        seasonId: input.seasonId,
        label,
        note: input.note ?? null,
        games: snapshot.games.length,
        source: input.source,
        restoredFromId: input.restoredFromId ?? null,
      },
    },
    tx,
  )

  return version
}

/**
 * The label describes what the version *is*; the number is displayed separately, so
 * embedding it here would render as "v4 v4 — generated".
 */
function defaultLabel(
  source: ScheduleVersionSource,
  number: number,
  restoredFromNumber?: number,
): string {
  void number
  switch (source) {
    case 'generated':
      return 'Generated'
    case 'restore':
      return restoredFromNumber ? `Restored from v${restoredFromNumber}` : 'Restored'
    case 'manual_save':
      return 'Saved by hand'
  }
}

/**
 * Publishes a version.
 *
 * Exactly one version per season is published at a time: the previously published one
 * is archived, never deleted, and `Season.publishedVersionId` moves to the new one.
 * That pointer is what every published-only read resolves against.
 */
export async function publishVersion(input: {
  orgId: string
  seasonId: string
  versionId: string
  actor: Actor
  note?: string
}): Promise<{ id: string; number: number; publishedAt: Date }> {
  return prisma.$transaction(async (tx) => {
    const version = await tx.scheduleVersion.findFirst({
      where: { id: input.versionId, seasonId: input.seasonId },
    })
    if (!version) throw notFound('Version not found.')
    if (version.status === 'published') throw conflict('That version is already published.')

    const season = await tx.season.findUniqueOrThrow({
      where: { id: input.seasonId },
      select: { publishedVersionId: true },
    })

    // Clear the pointer first: it is unique, so it cannot hold two versions at once.
    if (season.publishedVersionId) {
      await tx.season.update({
        where: { id: input.seasonId },
        data: { publishedVersionId: null },
      })
      await tx.scheduleVersion.update({
        where: { id: season.publishedVersionId },
        data: { status: 'archived' },
      })
    }

    const publishedAt = new Date()
    const published = await tx.scheduleVersion.update({
      where: { id: input.versionId },
      data: { status: 'published', publishedAt, publishedById: input.actor.userId },
      select: { id: true, number: true },
    })
    await tx.season.update({
      where: { id: input.seasonId },
      data: { publishedVersionId: input.versionId },
    })

    await recordAudit(
      {
        orgId: input.orgId,
        actorId: input.actor.userId,
        actorLabel: input.actor.email,
        entityType: 'ScheduleVersion',
        entityId: input.versionId,
        action: 'version.published',
        diff: { status: { before: version.status, after: 'published' } },
        meta: {
          seasonId: input.seasonId,
          number: published.number,
          label: version.label,
          supersededVersionId: season.publishedVersionId,
          note: input.note ?? null,
        },
      },
      tx,
    )

    return { ...published, publishedAt }
  })
}

/** Unpublishes the current version, leaving nothing public. */
export async function unpublishSeason(input: {
  orgId: string
  seasonId: string
  actor: Actor
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const season = await tx.season.findUniqueOrThrow({
      where: { id: input.seasonId },
      select: { publishedVersionId: true },
    })
    if (!season.publishedVersionId) throw conflict('Nothing is published for this season.')

    await tx.season.update({ where: { id: input.seasonId }, data: { publishedVersionId: null } })
    await tx.scheduleVersion.update({
      where: { id: season.publishedVersionId },
      data: { status: 'archived' },
    })
    await recordAudit(
      {
        orgId: input.orgId,
        actorId: input.actor.userId,
        actorLabel: input.actor.email,
        entityType: 'ScheduleVersion',
        entityId: season.publishedVersionId,
        action: 'version.unpublished',
        diff: { status: { before: 'published', after: 'archived' } },
        meta: { seasonId: input.seasonId },
      },
      tx,
    )
  })
}

/**
 * Restores a prior version's content.
 *
 * The current games are soft-deleted and the snapshot's games are re-created as new
 * rows, then a **new version** is written recording what was restored and from where.
 * Nothing between the restored version and now is removed — the acceptance scenario is
 * "restore v1 and confirm v3 exists with v1's content", and that is exactly what
 * happens: v1 and v2 both remain, v3 is the restore.
 *
 * Games whose status the caller wants left alone (played results, by default) are
 * kept as they are rather than being replaced by their snapshot counterparts, so a
 * restore cannot erase a recorded result.
 */
export async function restoreVersion(input: {
  orgId: string
  seasonId: string
  versionId: string
  actor: Actor
  note?: string
  /** Statuses a restore must not overwrite. Defaults to played results. */
  preserveStatuses?: GameStatus[]
}): Promise<{ version: { id: string; number: number; label: string }; created: number; retired: number; preserved: number }> {
  const preserveStatuses: GameStatus[] = input.preserveStatuses ?? ['played']

  return prisma.$transaction(async (tx) => {
    const source = await tx.scheduleVersion.findFirst({
      where: { id: input.versionId, seasonId: input.seasonId },
    })
    if (!source) throw notFound('Version not found.')

    const snapshot = parseSnapshot(source.snapshot)

    // Keep protected games exactly where they are.
    const protectedGames = await tx.game.findMany({
      where: { seasonId: input.seasonId, deletedAt: null, status: { in: preserveStatuses } },
      select: { id: true },
    })
    const protectedIds = new Set(protectedGames.map((game) => game.id))

    const stale = await tx.game.findMany({
      where: {
        seasonId: input.seasonId,
        deletedAt: null,
        id: { notIn: [...protectedIds] },
      },
      select: { id: true },
    })
    const staleIds = stale.map((game) => game.id)
    const now = new Date()

    if (staleIds.length > 0) {
      await tx.gameOfficial.updateMany({
        where: { gameId: { in: staleIds }, deletedAt: null },
        data: { deletedAt: now },
      })
      await tx.game.updateMany({ where: { id: { in: staleIds } }, data: { deletedAt: now } })
    }

    // Re-create the snapshot's games, skipping any that a protected game already covers.
    const protectedKeys = new Set(
      (
        await tx.game.findMany({
          where: { id: { in: [...protectedIds] } },
          select: { divisionId: true, homeTeamId: true, awayTeamId: true },
        })
      ).map((game) => `${game.divisionId}|${game.homeTeamId}|${game.awayTeamId}`),
    )

    let created = 0
    const gameEvents: AuditInput[] = []

    for (const game of snapshot.games) {
      const key = `${game.divisionId}|${game.homeTeamId}|${game.awayTeamId}`
      if (protectedKeys.has(key)) continue
      // Skip a snapshot row whose field no longer exists rather than failing the restore.
      if (game.fieldId) {
        const field = await tx.field.findFirst({ where: { id: game.fieldId, deletedAt: null } })
        if (!field) continue
      }

      const recreated = await tx.game.create({
        data: {
          seasonId: input.seasonId,
          divisionId: game.divisionId,
          homeTeamId: game.homeTeamId,
          awayTeamId: game.awayTeamId,
          fieldId: game.fieldId,
          startTime: new Date(game.startTime),
          durationMinutes: game.durationMinutes,
          // A result cannot be restored, only a fixture: a snapshot row that was
          // played comes back as scheduled with its score cleared.
          status: game.status === 'played' ? 'scheduled' : (game.status as GameStatus),
          homeScore: null,
          awayScore: null,
          roundNumber: game.roundNumber,
          notes: game.notes,
        },
        select: { id: true },
      })
      created += 1

      gameEvents.push({
        orgId: input.orgId,
        actorId: input.actor.userId,
        actorLabel: input.actor.email,
        entityType: 'Game',
        entityId: recreated.id,
        action: 'game.restored',
        diff: {
          startTime: { before: null, after: game.startTime },
          fieldId: { before: null, after: game.fieldId },
          roundNumber: { before: null, after: game.roundNumber },
        },
        meta: {
          via: 'restore',
          fromVersionId: source.id,
          fromVersionNumber: source.number,
          originalGameId: game.gameId,
        },
      })

      for (const official of game.officials) {
        const referee = await tx.referee.findFirst({
          where: { id: official.refereeId, deletedAt: null },
        })
        if (!referee) continue
        await tx.gameOfficial.create({
          data: {
            gameId: recreated.id,
            refereeId: official.refereeId,
            position: official.position as OfficialPosition,
            status: official.status as AcceptanceStatus,
          },
        })
      }
    }

    await recordAuditMany(gameEvents, tx)

    // The new version snapshots what the season now actually holds, which is the
    // restored games plus anything that was protected from the restore.
    const version = await createVersion(
      {
        orgId: input.orgId,
        seasonId: input.seasonId,
        actor: input.actor,
        source: 'restore',
        restoredFromNumber: source.number,
        note: input.note,
        config: (source.config ?? undefined) as Prisma.InputJsonValue | undefined,
        restoredFromId: source.id,
      },
      tx,
    )

    await recordAudit(
      {
        orgId: input.orgId,
        actorId: input.actor.userId,
        actorLabel: input.actor.email,
        entityType: 'Season',
        entityId: input.seasonId,
        action: 'schedule.restored',
        diff: {
          games: { before: staleIds.length + protectedIds.size, after: created + protectedIds.size },
        },
        meta: {
          restoredFromVersionId: source.id,
          restoredFromNumber: source.number,
          newVersionId: version.id,
          newVersionNumber: version.number,
          created,
          retired: staleIds.length,
          preserved: protectedIds.size,
          retiredGameIds: staleIds,
        },
      },
      tx,
    )

    return { version, created, retired: staleIds.length, preserved: protectedIds.size }
  }, { timeout: 120_000 })
}

/**
 * The snapshot a reader is entitled to see.
 *
 * Roles holding `schedule:read` get the live working set; everyone else gets the
 * published version, or nothing if the season has never been published. This is the
 * single place that decision is made, so no caller can get it wrong.
 */
export async function readableSnapshot(
  seasonId: string,
  canReadDrafts: boolean,
): Promise<{ snapshot: ScheduleSnapshot | null; source: 'live' | 'published' | 'none'; version: { id: string; number: number; label: string; publishedAt: Date | null } | null }> {
  if (canReadDrafts) {
    return { snapshot: await captureSnapshot(seasonId), source: 'live', version: null }
  }

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      publishedVersion: {
        select: { id: true, number: true, label: true, publishedAt: true, snapshot: true },
      },
    },
  })

  const published = season?.publishedVersion
  if (!published) return { snapshot: null, source: 'none', version: null }

  return {
    snapshot: parseSnapshot(published.snapshot),
    source: 'published',
    version: {
      id: published.id,
      number: published.number,
      label: published.label,
      publishedAt: published.publishedAt,
    },
  }
}
