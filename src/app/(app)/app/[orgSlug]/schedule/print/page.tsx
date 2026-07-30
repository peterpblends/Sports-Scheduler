import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireOrgAccess } from '@/lib/auth-server'
import { can } from '@/lib/authz'
import { readSchedule, groupByLocalDate } from '@/lib/schedule/read'
import { formatDayHeading } from '@/components/schedule-views'
import { formatCalendarDate, formatClockInZone } from '@/lib/time'

/**
 * The printable schedule.
 *
 * Produces a PDF through the browser's own print-to-PDF rather than by shipping a PDF
 * library. That is a deliberate trade: it costs one stylesheet instead of a rendering
 * dependency, it inherits the platform's font and hyphenation handling, and the output
 * is a real vector PDF with selectable text. What it gives up is server-side
 * generation — nobody can email this as an attachment without a browser, which is a
 * fair price for a page a league secretary prints twice a season.
 *
 * The print rules that actually matter here are the ones about where a page may break:
 * a day's table must not be split from its heading, and a row must not be split down
 * the middle.
 */
export default async function PrintSchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ seasonId?: string; teamId?: string; divisionId?: string; venueId?: string }>
}) {
  const { orgSlug } = await params
  const query = await searchParams
  const { role, orgId, orgName } = await requireOrgAccess(orgSlug, 'schedule:read:published')

  const seasons = await prisma.season.findMany({
    where: { deletedAt: null, league: { orgId, deletedAt: null } },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    include: { league: { select: { name: true } } },
  })
  const season = query.seasonId
    ? seasons.find((candidate) => candidate.id === query.seasonId)
    : (seasons.find((candidate) => candidate.status === 'active') ?? seasons[0])
  if (!season) notFound()

  const canReadDrafts = can(role, 'schedule:read')
  const schedule = await readSchedule({
    orgId,
    seasonId: season.id,
    canReadDrafts,
    filter: {
      teamId: query.teamId ?? null,
      divisionId: query.divisionId ?? null,
      venueId: query.venueId ?? null,
    },
  })

  const [team, division, venue] = await Promise.all([
    query.teamId
      ? prisma.team.findFirst({ where: { id: query.teamId }, select: { name: true } })
      : null,
    query.divisionId
      ? prisma.division.findFirst({ where: { id: query.divisionId }, select: { name: true } })
      : null,
    query.venueId
      ? prisma.venue.findFirst({ where: { id: query.venueId }, select: { name: true } })
      : null,
  ])

  const scope = [team?.name, division?.name, venue?.name].filter(Boolean).join(' · ')
  const days = groupByLocalDate(schedule.rows)
  const showOfficials = can(role, 'official:read')

  return (
    <div className="print-root mx-auto max-w-4xl px-4 py-8">
      {/* Screen-only controls. Nothing in here reaches the paper. */}
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/app/${orgSlug}/schedule?seasonId=${season.id}`}
          className="text-sm text-ink-500 hover:underline dark:text-ink-300"
        >
          ← Back to the schedule
        </Link>
        <p className="text-sm text-ink-500 dark:text-ink-300">
          Use your browser&apos;s Print (⌘P / Ctrl-P) and choose &ldquo;Save as PDF&rdquo;.
        </p>
      </div>

      {canReadDrafts && !schedule.version && (
        <p className="no-print mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          This is the working draft — nothing is published yet, so what you print is not what
          coaches and referees can see.
        </p>
      )}

      <header className="print-header mb-6 border-b border-ink-300 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{orgName}</h1>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">
          {season.league.name} · {season.name} · {formatCalendarDate(season.startDate)} →{' '}
          {formatCalendarDate(season.endDate)}
        </p>
        {scope && <p className="mt-1 text-sm font-medium">{scope}</p>}
        <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
          {schedule.rows.length} game{schedule.rows.length === 1 ? '' : 's'} ·{' '}
          {canReadDrafts
            ? schedule.version
              ? `working draft (published: v${schedule.version.number})`
              : 'working draft, nothing published'
            : `published v${schedule.version?.number ?? '—'}`}{' '}
          · times in each venue&apos;s local zone
        </p>
      </header>

      {days.length === 0 ? (
        <p className="text-sm text-ink-500 dark:text-ink-300">Nothing to print for this filter.</p>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.date} className="print-day">
              <h2 className="mb-2 text-base font-semibold">
                {formatDayHeading(day.date)}
                <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
                  {day.rows.length} game{day.rows.length === 1 ? '' : 's'}
                </span>
              </h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-ink-300 text-left text-xs uppercase tracking-wide">
                    <th className="py-1 pr-3 font-medium">Time</th>
                    <th className="py-1 pr-3 font-medium">Division</th>
                    <th className="py-1 pr-3 font-medium">Match</th>
                    <th className="py-1 pr-3 font-medium">Venue</th>
                    {showOfficials && <th className="py-1 font-medium">Officials</th>}
                  </tr>
                </thead>
                <tbody>
                  {day.rows.map((row) => (
                    <tr key={row.id} className="print-row border-b border-ink-200">
                      <td className="py-1 pr-3 whitespace-nowrap tabular-nums">
                        {formatClockInZone(row.startTime, row.timezone)}
                      </td>
                      <td className="py-1 pr-3 text-xs">
                        {row.divisionName}
                        {row.roundNumber !== null && ` · r${row.roundNumber}`}
                      </td>
                      <td className="py-1 pr-3">
                        {row.homeTeamName} v {row.awayTeamName}
                        {row.homeScore !== null && row.awayScore !== null && (
                          <span className="ml-2 tabular-nums">
                            {row.homeScore}–{row.awayScore}
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3 text-xs">
                        {row.venueName ? `${row.venueName} · ${row.fieldName}` : 'unplaced'}
                      </td>
                      {showOfficials && (
                        <td className="py-1 text-xs">
                          {row.officials.length === 0
                            ? '—'
                            : row.officials
                                .map((official) => `${official.refereeName} (${official.position})`)
                                .join(', ')}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}

      <footer className="print-footer mt-8 border-t border-ink-300 pt-3 text-xs text-ink-500 dark:text-ink-400">
        {orgName} · {season.league.name} {season.name} · printed from Sports Scheduler
      </footer>
    </div>
  )
}
