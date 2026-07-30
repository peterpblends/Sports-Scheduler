import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { badRequest, handler, parseBody, requirePermission } from '@/lib/http'
import { assertSeasonInOrg } from '@/lib/scope'
import { recordAudit } from '@/lib/audit'
import { generateSchedule, scheduleConfigSchema } from '@/lib/scheduler'
import { loadSchedulerInput } from '@/lib/scheduler/db'
import { formatInstantInZone } from '@/lib/time'
import type { Prisma } from '@prisma/client'

type Ctx = { params: Promise<{ orgId: string; seasonId: string }> }

const bodySchema = z.object({
  config: scheduleConfigSchema.optional(),
  /**
   * When false the engine runs and returns its report without writing anything —
   * the preview an admin sees before committing.
   */
  commit: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
})

/**
 * Runs the scheduling engine for a season.
 *
 * A dry run (the default) returns the proposed games and the relaxation report and
 * touches nothing. Committing replaces the season's regenerable games — the ones the
 * config does not list as preserved — inside a single transaction, and records one
 * audit event describing the whole generation.
 *
 * Phase 4 will wrap the commit in an immutable ScheduleVersion; for now the audit
 * event carries the config, the seed and the counts, so a regeneration is already
 * traceable.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, seasonId } = await ctx.params
  const { actor } = await requirePermission(req, orgId, 'schedule:generate')
  const season = await assertSeasonInOrg(orgId, seasonId)
  const { config = {}, commit, note } = await parseBody(req, bodySchema)

  if (season.status === 'archived') {
    throw badRequest('This season is archived. Set it back to draft or active to regenerate.')
  }

  const input = await loadSchedulerInput(orgId, seasonId, config)
  if (input.divisions.every((division) => division.teams.length < 2)) {
    throw badRequest('Add at least two teams to a division before generating a schedule.')
  }

  const result = generateSchedule(input)

  // Names, and local kickoff times, so the preview is readable without a second call.
  const teamNames = new Map(
    input.divisions.flatMap((d) => d.teams.map((t) => [t.id, t.name] as const)),
  )
  const fields = new Map(input.fields.map((field) => [field.id, field]))
  const refereeNames = new Map(input.referees.map((referee) => [referee.id, referee.name]))

  const preview = result.games.map((game, index) => {
    const field = fields.get(game.fieldId)
    return {
      index,
      divisionId: game.divisionId,
      roundNumber: game.roundNumber,
      homeTeam: teamNames.get(game.homeTeamId) ?? null,
      awayTeam: teamNames.get(game.awayTeamId) ?? null,
      venue: field?.venueName ?? null,
      field: field?.name ?? null,
      startTime: game.startTime.toISOString(),
      localStartTime: field ? formatInstantInZone(game.startTime, field.timezone) : null,
      preserved: game.preserved,
      bracket: game.bracket?.label ?? null,
      officials: result.assignments
        .filter((assignment) => assignment.gameIndex === index)
        .map((assignment) => ({
          position: assignment.position,
          referee: refereeNames.get(assignment.refereeId) ?? assignment.refereeId,
        })),
    }
  })

  if (!commit) {
    return Response.json({ committed: false, config: result.config, report: result.report, preview })
  }

  const written = await commitSchedule({
    orgId,
    seasonId,
    actor,
    result,
    note,
  })

  return Response.json({
    committed: true,
    config: result.config,
    report: result.report,
    preview,
    written,
  })
})

/**
 * Persists a generated schedule.
 *
 * Games the config preserves are left exactly as they are. Everything else in the
 * season is soft-deleted and replaced — never hard-deleted, so the previous
 * schedule stays reachable in history (non-negotiable #2).
 */
async function commitSchedule(input: {
  orgId: string
  seasonId: string
  actor: { userId: string; email: string }
  result: ReturnType<typeof generateSchedule>
  note?: string
}): Promise<{ created: number; retired: number; assignments: number }> {
  const { orgId, seasonId, actor, result } = input
  const preserveIds = new Set(
    result.games.filter((game) => game.preserved && game.existingId).map((game) => game.existingId!),
  )
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    // Retire the previous generation, apart from what is preserved.
    const stale = await tx.game.findMany({
      where: { seasonId, deletedAt: null, id: { notIn: [...preserveIds] } },
      select: { id: true },
    })
    const staleIds = stale.map((game) => game.id)

    if (staleIds.length > 0) {
      await tx.gameOfficial.updateMany({
        where: { gameId: { in: staleIds }, deletedAt: null },
        data: { deletedAt: now },
      })
      await tx.game.updateMany({ where: { id: { in: staleIds } }, data: { deletedAt: now } })
    }

    // Insert the new games, keeping the engine's index order so assignments line up.
    const createdIds: (string | null)[] = []
    for (const game of result.games) {
      if (game.preserved) {
        createdIds.push(game.existingId)
        continue
      }
      // A bracket placeholder has no teams yet, so there is nothing to insert.
      if (!game.homeTeamId || !game.awayTeamId) {
        createdIds.push(null)
        continue
      }
      const created = await tx.game.create({
        data: {
          seasonId,
          divisionId: game.divisionId,
          homeTeamId: game.homeTeamId,
          awayTeamId: game.awayTeamId,
          fieldId: game.fieldId,
          startTime: game.startTime,
          durationMinutes: game.durationMinutes,
          roundNumber: game.roundNumber,
          status: 'scheduled',
          notes: game.bracket?.label ?? null,
        },
        select: { id: true },
      })
      createdIds.push(created.id)
    }

    let assignments = 0
    for (const assignment of result.assignments) {
      const gameId = createdIds[assignment.gameIndex]
      if (!gameId) continue
      await tx.gameOfficial.create({
        data: {
          gameId,
          refereeId: assignment.refereeId,
          position: assignment.position,
          payRateCentsOverride: null,
        },
      })
      assignments += 1
    }

    const created = createdIds.filter(
      (id, index) => id !== null && !result.games[index]!.preserved,
    ).length

    await recordAudit(
      {
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'Season',
        entityId: seasonId,
        action: 'schedule.generated',
        diff: {
          games: { before: staleIds.length, after: created + preserveIds.size },
        },
        meta: {
          note: input.note ?? null,
          seed: result.config.seed,
          config: result.config as unknown as Prisma.InputJsonValue,
          counts: result.report.counts,
          retiredGameIds: staleIds,
          preservedGameIds: [...preserveIds],
          softConstraintsRelaxed: result.report.softConstraints
            .filter((entry) => entry.relaxed)
            .map((entry) => ({ constraint: entry.constraint, magnitude: entry.magnitude })),
          unplaced: result.report.unplaced.length,
          unfilledOfficials: result.report.unfilledOfficials.length,
        },
      },
      tx,
    )

    return { created, retired: staleIds.length, assignments }
  })
}
