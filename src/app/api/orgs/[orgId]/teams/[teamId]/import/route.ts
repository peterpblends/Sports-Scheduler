import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { handler, parseBody } from '@/lib/http'
import { requireTeamRosterWrite } from '@/lib/scope'
import { parseRosterCsv, type RosterRow } from '@/lib/csv'
import { recordAuditMany, type AuditInput } from '@/lib/audit'
import { parseCalendarDate } from '@/lib/time'

type Ctx = { params: Promise<{ orgId: string; teamId: string }> }

const schema = z.object({
  csv: z.string().min(1).max(1_000_000),
  /** False (the default) validates and reports without writing anything. */
  commit: z.boolean().default(false),
})

/**
 * Roster CSV import, preview-and-fix.
 *
 * A request with `commit: false` validates the whole file and returns every problem it
 * found, so a file can be corrected in one pass instead of one upload per mistake.
 *
 * A request with `commit: true` runs exactly the same validation and refuses outright
 * if anything is wrong: a half-imported roster is worse than a rejected one, because
 * nobody can tell which half landed. When it does write, it writes in a single
 * transaction, so the same is true of a database error midway.
 *
 * Matching against existing people is by email first, then by exact name within the
 * org — email being the only thing in a roster file that is actually an identifier.
 */
export const POST = handler<Ctx>(async (req, ctx) => {
  const { orgId, teamId } = await ctx.params
  const { actor } = await requireTeamRosterWrite(req, orgId, teamId)
  const input = await parseBody(req, schema)

  const parsed = parseRosterCsv(input.csv)

  const team = await prisma.team.findFirstOrThrow({
    where: { id: teamId, deletedAt: null },
    select: { id: true, name: true },
  })

  // Existing people in the org, so the preview can say "this row updates someone" and
  // an import never creates a second Person for the same human.
  const existing = await prisma.person.findMany({
    where: { orgId, deletedAt: null },
    select: { id: true, name: true, email: true },
  })
  const byEmail = new Map(
    existing.filter((person) => person.email).map((person) => [person.email!.toLowerCase(), person]),
  )
  const byName = new Map(existing.map((person) => [person.name.toLowerCase(), person]))

  const currentMembers = await prisma.teamMembership.findMany({
    where: { teamId, deletedAt: null, activeTo: null },
    select: { personId: true, jerseyNumber: true },
  })
  const alreadyOnTeam = new Set(currentMembers.map((member) => member.personId))
  const takenJerseys = new Map(
    currentMembers
      .filter((member) => member.jerseyNumber)
      .map((member) => [member.jerseyNumber!, member.personId]),
  )

  const errors = [...parsed.errors]

  const plan = parsed.rows.map((row) => {
    const match =
      (row.email ? byEmail.get(row.email.toLowerCase()) : undefined) ??
      byName.get(row.name.toLowerCase())

    // A jersey held by someone who is not this row's person is a real clash, and one
    // the file itself cannot see — so it is reported here rather than in the parser.
    if (row.jersey) {
      const holder = takenJerseys.get(row.jersey)
      if (holder && holder !== match?.id) {
        errors.push({
          line: row.line,
          column: 'jersey',
          message: `Jersey ${row.jersey} is already taken on ${team.name}.`,
        })
      }
    }

    return {
      line: row.line,
      name: row.name,
      role: row.role,
      jersey: row.jersey,
      personId: match?.id ?? null,
      action: !match
        ? ('create_person_and_add' as const)
        : alreadyOnTeam.has(match.id)
          ? ('update_membership' as const)
          : ('add_existing_person' as const),
    }
  })

  const summary = {
    rows: parsed.rows.length,
    created: plan.filter((entry) => entry.action === 'create_person_and_add').length,
    added: plan.filter((entry) => entry.action === 'add_existing_person').length,
    updated: plan.filter((entry) => entry.action === 'update_membership').length,
  }

  if (!input.commit || errors.length > 0) {
    return Response.json(
      {
        committed: false,
        team: { id: team.id, name: team.name },
        columns: parsed.columns,
        unknownColumns: parsed.unknownColumns,
        summary,
        plan,
        rows: parsed.rows,
        errors,
      },
      // A commit attempt on an invalid file is a refusal, not a preview.
      { status: input.commit && errors.length > 0 ? 422 : 200 },
    )
  }

  const written = await commitRoster({ orgId, teamId, actor, rows: parsed.rows })

  return Response.json({
    committed: true,
    team: { id: team.id, name: team.name },
    columns: parsed.columns,
    unknownColumns: parsed.unknownColumns,
    summary: { ...summary, ...written },
    plan,
    errors: [],
  })
})

async function commitRoster(input: {
  orgId: string
  teamId: string
  actor: { userId: string; email: string }
  rows: RosterRow[]
}): Promise<{ peopleCreated: number; membershipsCreated: number; membershipsUpdated: number }> {
  const { orgId, teamId, actor, rows } = input

  return prisma.$transaction(async (tx) => {
    const events: AuditInput[] = []
    let peopleCreated = 0
    let membershipsCreated = 0
    let membershipsUpdated = 0

    for (const row of rows) {
      // Re-resolve inside the transaction: a person created by an earlier row in this
      // same file must be found by a later one.
      const match =
        (row.email
          ? await tx.person.findFirst({
              where: { orgId, deletedAt: null, email: { equals: row.email, mode: 'insensitive' } },
              select: { id: true },
            })
          : null) ??
        (await tx.person.findFirst({
          where: { orgId, deletedAt: null, name: { equals: row.name, mode: 'insensitive' } },
          select: { id: true },
        }))

      let personId = match?.id
      if (!personId) {
        const person = await tx.person.create({
          data: {
            orgId,
            name: row.name,
            email: row.email,
            phone: row.phone,
            dob: row.dob ? parseCalendarDate(row.dob) : null,
            notes: row.notes,
          },
          select: { id: true },
        })
        personId = person.id
        peopleCreated += 1
        events.push({
          orgId,
          actorId: actor.userId,
          actorLabel: actor.email,
          entityType: 'Person',
          entityId: person.id,
          action: 'person.created',
          diff: { name: { before: null, after: row.name } },
          meta: { via: 'roster_import', teamId, line: row.line },
        })
      }

      const membership = await tx.teamMembership.findFirst({
        where: { teamId, personId, deletedAt: null, activeTo: null },
        select: { id: true, role: true, jerseyNumber: true },
      })

      if (membership) {
        const changed =
          membership.role !== row.role || (membership.jerseyNumber ?? null) !== row.jersey
        if (changed) {
          await tx.teamMembership.update({
            where: { id: membership.id },
            data: { role: row.role, jerseyNumber: row.jersey },
          })
          membershipsUpdated += 1
          events.push({
            orgId,
            actorId: actor.userId,
            actorLabel: actor.email,
            entityType: 'TeamMembership',
            entityId: membership.id,
            action: 'membership.updated',
            diff: {
              role: { before: membership.role, after: row.role },
              jerseyNumber: { before: membership.jerseyNumber, after: row.jersey },
            },
            meta: { via: 'roster_import', teamId, personId, line: row.line },
          })
        }
        continue
      }

      const created = await tx.teamMembership.create({
        data: { teamId, personId, role: row.role, jerseyNumber: row.jersey },
        select: { id: true },
      })
      membershipsCreated += 1
      events.push({
        orgId,
        actorId: actor.userId,
        actorLabel: actor.email,
        entityType: 'TeamMembership',
        entityId: created.id,
        action: 'membership.created',
        diff: {
          role: { before: null, after: row.role },
          jerseyNumber: { before: null, after: row.jersey },
        },
        meta: { via: 'roster_import', teamId, personId, line: row.line },
      })
    }

    // One event per row plus a summary, so the import is legible in the activity feed
    // as a single act rather than a burst of unexplained creations.
    events.push({
      orgId,
      actorId: actor.userId,
      actorLabel: actor.email,
      entityType: 'Team',
      entityId: teamId,
      action: 'roster.imported',
      diff: { members: { before: null, after: rows.length } },
      meta: { peopleCreated, membershipsCreated, membershipsUpdated, rows: rows.length },
    })

    await recordAuditMany(events, tx)
    return { peopleCreated, membershipsCreated, membershipsUpdated }
  })
}
