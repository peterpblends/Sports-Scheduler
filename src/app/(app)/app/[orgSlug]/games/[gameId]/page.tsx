import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { Alert, Card, PageHeader } from '@/components/ui'
import { EntityHistory } from '@/components/activity-feed'
import { GameEditor, OfficialsPanel } from '@/components/game-editor'
import { refereeForUser } from '@/lib/scope'
import {
  calendarDateInZone,
  formatCalendarDate,
  formatInstantInZone,
  formatTimeOfDay,
  minutesFromMidnightInZone,
} from '@/lib/time'

/**
 * Game detail: the editor, the crew, and the per-entity history the spec asks for —
 * who changed this game and when, including any override reason recorded at the time.
 */
export default async function GamePage({
  params,
}: {
  params: Promise<{ orgSlug: string; gameId: string }>
}) {
  const { orgSlug, gameId } = await params
  const { role, orgId, actor } = await requireOrgAccess(orgSlug, 'schedule:read:published')

  const game = await prisma.game.findFirst({
    where: {
      id: gameId,
      deletedAt: null,
      season: { deletedAt: null, league: { orgId, deletedAt: null } },
    },
    include: {
      season: { include: { league: true } },
      division: true,
      homeTeam: true,
      awayTeam: true,
      field: { include: { venue: true } },
      officials: {
        where: { deletedAt: null },
        orderBy: { position: 'asc' },
        include: { referee: { include: { person: { select: { id: true, name: true } } } } },
      },
    },
  })
  if (!game) notFound()

  // A game only exists on the live working set. Roles that can read just the published
  // schedule should not reach a draft game's detail page.
  if (!can(role, 'schedule:read')) {
    const season = await prisma.season.findUniqueOrThrow({
      where: { id: game.seasonId },
      select: { publishedVersionId: true },
    })
    if (!season.publishedVersionId) notFound()
  }

  const canEdit = can(role, 'schedule:edit')
  const canAssign = can(role, 'official:assign')

  const [history, officialHistory, fields, ownReferee, org] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { entityType: 'Game', entityId: gameId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.auditEvent.findMany({
      where: {
        entityType: 'GameOfficial',
        orgId,
        meta: { path: ['gameId'], equals: gameId },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    canEdit
      ? prisma.field.findMany({
          where: { deletedAt: null, venue: { orgId, deletedAt: null } },
          orderBy: [{ venue: { name: 'asc' } }, { name: 'asc' }],
          include: { venue: { select: { name: true, timezone: true } } },
        })
      : Promise.resolve([]),
    can(role, 'official:respond:own') ? refereeForUser(actor.userId, orgId) : Promise.resolve(null),
    prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } }),
  ])

  const timezone = game.field?.venue.timezone ?? org.timezone

  const ownAssignmentIds = ownReferee
    ? game.officials.filter((official) => official.refereeId === ownReferee.id).map((o) => o.id)
    : []

  return (
    <>
      <PageHeader
        title={`${game.homeTeam.name} v ${game.awayTeam.name}`}
        subtitle={`${game.season.league.name} · ${game.season.name} · ${game.division.name}${
          game.roundNumber !== null ? ` · round ${game.roundNumber}` : ''
        }`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link href={`/app/${orgSlug}/schedule`} className="text-ink-500 hover:underline dark:text-ink-300">
          ← Schedule
        </Link>
        {can(role, 'schedule:read') && (
          <Link
            href={`/app/${orgSlug}/seasons/${game.seasonId}/versions`}
            className="font-medium text-turf-600 hover:underline"
          >
            Version history →
          </Link>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold">Details</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Kickoff">
              {formatInstantInZone(game.startTime, timezone)}
              <div className="text-xs text-ink-500 dark:text-ink-400">
                {game.durationMinutes} minutes · {timezone}
              </div>
            </Row>
            <Row label="Where">
              {game.field ? (
                <>
                  {game.field.venue.name}
                  <div className="text-xs text-ink-500 dark:text-ink-400">{game.field.name}</div>
                </>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">not placed</span>
              )}
            </Row>
            <Row label="Status">
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-900">
                {game.status}
              </span>
            </Row>
            <Row label="Score">
              <span className="tabular-nums">
                {game.homeScore === null ? '—' : `${game.homeScore}–${game.awayScore}`}
              </span>
            </Row>
          </dl>
          {game.notes && (
            <p className="mt-3 border-t border-ink-200 pt-3 text-sm text-ink-600 dark:border-ink-700 dark:text-ink-300">
              {game.notes}
            </p>
          )}
        </Card>

        <OfficialsPanel
          orgId={orgId}
          gameId={gameId}
          canAssign={canAssign}
          ownAssignmentIds={ownAssignmentIds}
          assignments={game.officials.map((official) => ({
            id: official.id,
            refereeName: official.referee.person.name,
            position: official.position,
            status: official.status,
          }))}
        />
      </div>

      {canEdit && (
        <div className="mt-4">
          <GameEditor
            orgId={orgId}
            gameId={gameId}
            timezone={timezone}
            initial={{
              localDate: formatCalendarDate(calendarDateInZone(game.startTime, timezone)),
              localTime: formatTimeOfDay(minutesFromMidnightInZone(game.startTime, timezone)),
              fieldId: game.fieldId,
              durationMinutes: game.durationMinutes,
              status: game.status,
              homeScore: game.homeScore,
              awayScore: game.awayScore,
              notes: game.notes,
            }}
            fields={fields.map((field) => ({
              id: field.id,
              label: `${field.venue.name} — ${field.name}`,
              timezone: field.venue.timezone,
            }))}
          />
        </div>
      )}

      {can(role, 'audit:read') ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="text-base font-semibold">History</h2>
            <p className="mt-1 mb-3 text-sm text-ink-500 dark:text-ink-300">
              Who changed this game, when, and what they changed.
            </p>
            <EntityHistory
              timeZone={timezone}
              events={history.map((event) => ({
                id: event.id,
                action: event.action,
                actorLabel: event.actorLabel,
                createdAt: event.createdAt,
                diff: event.diff,
                meta: event.meta,
              }))}
            />
          </Card>

          <Card>
            <h2 className="text-base font-semibold">Officiating changes</h2>
            <p className="mt-1 mb-3 text-sm text-ink-500 dark:text-ink-300">
              Assignments, responses and any override an assigner recorded.
            </p>
            <EntityHistory
              timeZone={timezone}
              events={officialHistory.map((event) => ({
                id: event.id,
                action: event.action,
                actorLabel: event.actorLabel,
                createdAt: event.createdAt,
                diff: event.diff,
                meta: event.meta,
              }))}
            />
          </Card>
        </div>
      ) : (
        <div className="mt-4">
          <Alert kind="info">Your role cannot read the change history for this game.</Alert>
        </div>
      )}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-500 dark:text-ink-400">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}
