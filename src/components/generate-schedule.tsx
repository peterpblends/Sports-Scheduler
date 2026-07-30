'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'
import { Alert, Card, EmptyState, buttonClass, inputClass, secondaryButtonClass } from './ui'
import { DAY_NAMES } from '@/lib/time'

type SoftConstraint = {
  constraint: string
  target: string
  relaxed: boolean
  magnitude: number
  unit: string
  affected: Array<{ teamId: string; teamName: string; detail: string; magnitude: number }>
}

type Report = {
  seed: number
  rounds: number
  counts: {
    placed: number
    preserved: number
    unplaced: number
    byes: number
    officialsRequired: number
    officialsAssigned: number
  }
  teams: Array<{
    teamId: string
    teamName: string
    games: number
    home: number
    away: number
    homeAwayDelta: number
    byes: number
    minRestDaysObserved: number | null
    slotBuckets: Record<string, number>
  }>
  softConstraints: SoftConstraint[]
  unplaced: Array<{ roundNumber: number; reason: string }>
  unfilledOfficials: Array<{ gameIndex: number; position: string; reason: string }>
  refereeLoad: Array<{ refereeId: string; name: string; games: number; payCents: number }>
  notes: string[]
}

type PreviewGame = {
  index: number
  roundNumber: number
  homeTeam: string | null
  awayTeam: string | null
  venue: string | null
  field: string | null
  localStartTime: string | null
  preserved: boolean
  bracket: string | null
  officials: Array<{ position: string; referee: string }>
}

type GenerateResponse = {
  committed: boolean
  report: Report
  preview: PreviewGame[]
  written?: { created: number; retired: number; assignments: number }
}

const READABLE_REASON: Record<string, string> = {
  field_double_booked: 'every field was already booked',
  team_double_booked: 'a team was already playing then',
  home_team_daily_cap: 'the home team had hit its games-per-day cap',
  away_team_daily_cap: 'the away team had hit its games-per-day cap',
  home_team_weekly_cap: 'the home team had hit its games-per-week cap',
  away_team_weekly_cap: 'the away team had hit its games-per-week cap',
  team_already_playing_this_round: 'a team was already fixtured that round',
  division_blackout: 'a division blackout covered every remaining date',
  home_team_blackout: 'a blackout on the home team covered every remaining date',
  away_team_blackout: 'a blackout on the away team covered every remaining date',
  no_slots_available: 'no bookable slots exist',
  no_feasible_slot: 'no remaining slot satisfied every hard constraint',
  daily_cap: 'they had hit their games-per-day cap',
  blackout: 'they were blacked out',
  outside_weekly_window: 'the kickoff fell outside their availability',
  overlapping_assignment: 'they already had an overlapping game',
  insufficient_travel_time: 'there was not enough travel time between venues',
  conflict_of_interest: 'they are tied to one of the teams',
  none_eligible: 'no official was eligible',
  no_officials_registered: 'no officials are registered',
}

function humanize(reason: string): string {
  // Reasons arrive either bare or as "Home v Away: key".
  const [prefix, key] = reason.includes(': ') ? reason.split(/: (?=[a-z_]+$)/) : [null, reason]
  const readable = READABLE_REASON[key ?? reason] ?? (key ?? reason).replace(/_/g, ' ')
  return prefix ? `${prefix} — ${readable}` : readable
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700 dark:text-ink-200">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500 dark:text-ink-400">{hint}</span>}
    </label>
  )
}

/**
 * Schedule configuration editor plus the generation report.
 *
 * Generating is a two-step flow on purpose: the first run is a dry run that writes
 * nothing, so an admin can read the relaxation report and adjust before committing.
 */
export function GenerateSchedule({
  orgId,
  seasonId,
  seasonName,
  canGenerate,
}: {
  orgId: string
  seasonId: string
  seasonName: string
  canGenerate: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [response, setResponse] = useState<GenerateResponse | null>(null)
  const [showAllGames, setShowAllGames] = useState(false)

  function readConfig(form: FormData) {
    const num = (name: string) => {
      const raw = form.get(name)
      return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : undefined
    }
    const minutes = (name: string) => {
      const raw = form.get(name)
      if (typeof raw !== 'string' || !raw.includes(':')) return undefined
      const [h, m] = raw.split(':').map(Number)
      return h! * 60 + m!
    }

    const days = DAY_NAMES.map((_, index) => index).filter((index) =>
      form.getAll('playableDaysOfWeek').includes(String(index)),
    )

    return {
      seed: num('seed'),
      roundRobinTimes: num('roundRobinTimes'),
      gamesPerTeamCap: form.get('gamesPerTeamCap') ? num('gamesPerTeamCap') : null,
      numberOfRounds: form.get('numberOfRounds') ? num('numberOfRounds') : null,
      byeHandling: (form.get('byeHandling') as 'balanced' | 'rotate') || undefined,
      crossDivisionPlay: (form.get('crossDivisionPlay') as 'none' | 'limited' | 'full') || undefined,
      crossDivisionGamesPerTeam: num('crossDivisionGamesPerTeam'),

      playableDaysOfWeek: days.length > 0 ? days : undefined,
      gameDurationMinutes: num('gameDurationMinutes'),
      bufferMinutes: num('bufferMinutes'),
      earliestStartMinute: minutes('earliestStart'),
      latestStartMinute: minutes('latestStart'),
      minRestDays: num('minRestDays'),
      maxGamesPerTeamPerDay: num('maxGamesPerTeamPerDay'),
      maxGamesPerTeamPerWeek: num('maxGamesPerTeamPerWeek'),

      homeAwayBalanceTarget: num('homeAwayBalanceTarget'),
      weights: {
        homeAway: num('weightHomeAway'),
        consecutiveOpponent: num('weightConsecutive'),
        slotRotation: num('weightSlotRotation'),
        venueSpread: num('weightVenueSpread'),
        restDays: num('weightRestDays'),
        siblingProximity: num('weightSibling'),
      },

      assignOfficials: form.get('assignOfficials') === 'on',
      officialsRequired: {
        center: num('officialsCenter') ?? 0,
        AR1: num('officialsAR1') ?? 0,
        AR2: num('officialsAR2') ?? 0,
        scorekeeper: num('officialsScorekeeper') ?? 0,
      },

      playoffs: {
        enabled: form.get('playoffsEnabled') === 'on',
        format: (form.get('playoffFormat') as 'single_elimination' | 'double_elimination') || undefined,
        teams: num('playoffTeams'),
        seeding: (form.get('playoffSeeding') as 'standings' | 'provisional') || undefined,
      },
    }
  }

  async function run(form: FormData, commit: boolean) {
    setBusy(commit ? 'commit' : 'preview')
    setError(null)
    try {
      const result = await api<GenerateResponse>(
        `/api/orgs/${orgId}/seasons/${seasonId}/generate`,
        { body: { config: readConfig(form), commit } },
      )
      setResponse(result)
      if (commit) router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed.')
    } finally {
      setBusy(null)
    }
  }

  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormEl(event.currentTarget)
    await run(new FormData(event.currentTarget), false)
  }

  if (!canGenerate) {
    return (
      <Alert kind="info">
        Your role can view the schedule but not generate it. Schedulers, admins and owners can.
      </Alert>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold">Schedule configuration</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Every parameter has a sensible default — change what matters and generate.
          Generating first shows a preview and writes nothing.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-6">
          {error && <Alert>{error}</Alert>}

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
              Format
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Times through the round robin">
                <input name="roundRobinTimes" type="number" min={1} max={10} defaultValue={2} className={inputClass} />
              </Field>
              <Field label="Games per team cap" hint="Blank for no cap.">
                <input name="gamesPerTeamCap" type="number" min={1} className={inputClass} />
              </Field>
              <Field label="Number of rounds" hint="Blank to derive from the date range.">
                <input name="numberOfRounds" type="number" min={1} className={inputClass} />
              </Field>
              <Field label="Bye handling" hint="Only matters with an odd team count.">
                <select name="byeHandling" defaultValue="balanced" className={inputClass}>
                  <option value="balanced">Balanced across passes</option>
                  <option value="rotate">Same rotation each pass</option>
                </select>
              </Field>
              <Field label="Cross-division play">
                <select name="crossDivisionPlay" defaultValue="none" className={inputClass}>
                  <option value="none">None</option>
                  <option value="limited">Limited</option>
                  <option value="full">Full — one pool</option>
                </select>
              </Field>
              <Field label="Cross-division games per team">
                <input name="crossDivisionGamesPerTeam" type="number" min={0} defaultValue={2} className={inputClass} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
              Timing
            </legend>
            <Field label="Playable days" hint="Games are only ever placed on these days.">
              <div className="flex flex-wrap gap-3">
                {DAY_NAMES.map((day, index) => (
                  <label key={day} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      name="playableDaysOfWeek"
                      value={index}
                      defaultChecked={index === 6}
                      className="rounded border-ink-300"
                    />
                    {day.slice(0, 3)}
                  </label>
                ))}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Game duration (minutes)">
                <input name="gameDurationMinutes" type="number" min={5} defaultValue={60} className={inputClass} />
              </Field>
              <Field label="Buffer between games (minutes)" hint="Clearance on the same field.">
                <input name="bufferMinutes" type="number" min={0} defaultValue={15} className={inputClass} />
              </Field>
              <Field label="Earliest kickoff" hint="Venue local time.">
                <input name="earliestStart" type="time" defaultValue="08:00" className={inputClass} />
              </Field>
              <Field label="Latest kickoff">
                <input name="latestStart" type="time" defaultValue="17:00" className={inputClass} />
              </Field>
              <Field label="Minimum rest days" hint="Soft — reported when relaxed.">
                <input name="minRestDays" type="number" min={0} defaultValue={3} className={inputClass} />
              </Field>
              <Field label="Max games per team per day" hint="Hard cap. 2 allows double-headers.">
                <input name="maxGamesPerTeamPerDay" type="number" min={1} defaultValue={1} className={inputClass} />
              </Field>
              <Field label="Max games per team per week" hint="Hard cap.">
                <input name="maxGamesPerTeamPerWeek" type="number" min={1} defaultValue={2} className={inputClass} />
              </Field>
              <Field label="Seed" hint="Same seed and config reproduces the same schedule.">
                <input name="seed" type="number" min={0} defaultValue={1} className={inputClass} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
              Fairness
            </legend>
            <p className="text-xs text-ink-500 dark:text-ink-400">
              These are soft: the generator scores them and reports what it had to relax.
              Higher weight means the generator works harder to honour that one.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Home/away balance target" hint="Acceptable home minus away gap.">
                <input name="homeAwayBalanceTarget" type="number" min={0} defaultValue={1} className={inputClass} />
              </Field>
              <Field label="Weight: home/away">
                <input name="weightHomeAway" type="number" min={0} defaultValue={12} className={inputClass} />
              </Field>
              <Field label="Weight: avoid repeat opponent">
                <input name="weightConsecutive" type="number" min={0} defaultValue={8} className={inputClass} />
              </Field>
              <Field label="Weight: rotate time slots">
                <input name="weightSlotRotation" type="number" min={0} defaultValue={4} className={inputClass} />
              </Field>
              <Field label="Weight: spread venues">
                <input name="weightVenueSpread" type="number" min={0} defaultValue={3} className={inputClass} />
              </Field>
              <Field label="Weight: rest days">
                <input name="weightRestDays" type="number" min={0} defaultValue={20} className={inputClass} />
              </Field>
              <Field label="Weight: keep siblings together">
                <input name="weightSibling" type="number" min={0} defaultValue={6} className={inputClass} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
              Officials
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="assignOfficials" defaultChecked className="rounded border-ink-300" />
              Assign officials during generation
            </label>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Centre referees">
                <input name="officialsCenter" type="number" min={0} max={4} defaultValue={1} className={inputClass} />
              </Field>
              <Field label="Assistant 1">
                <input name="officialsAR1" type="number" min={0} max={4} defaultValue={1} className={inputClass} />
              </Field>
              <Field label="Assistant 2">
                <input name="officialsAR2" type="number" min={0} max={4} defaultValue={1} className={inputClass} />
              </Field>
              <Field label="Scorekeepers">
                <input name="officialsScorekeeper" type="number" min={0} max={4} defaultValue={0} className={inputClass} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
              Playoffs
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="playoffsEnabled" className="rounded border-ink-300" />
              Reserve slots for a playoff bracket
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Format">
                <select name="playoffFormat" defaultValue="single_elimination" className={inputClass}>
                  <option value="single_elimination">Single elimination</option>
                  <option value="double_elimination">Double elimination</option>
                </select>
              </Field>
              <Field label="Qualifying teams per division">
                <input name="playoffTeams" type="number" min={2} max={64} defaultValue={4} className={inputClass} />
              </Field>
              <Field label="Seeding">
                <select name="playoffSeeding" defaultValue="standings" className={inputClass}>
                  <option value="standings">From standings</option>
                  <option value="provisional">Provisional order</option>
                </select>
              </Field>
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3 border-t border-ink-200 pt-4 dark:border-ink-700">
            <button type="submit" disabled={busy !== null} className={buttonClass}>
              {busy === 'preview' ? 'Generating…' : 'Generate preview'}
            </button>
            {response && !response.committed && (
              <button
                type="button"
                disabled={busy !== null}
                className={secondaryButtonClass}
                onClick={() => {
                  if (!formEl) return
                  if (
                    !window.confirm(
                      `Replace the schedule for ${seasonName}? The current games are kept in history, not deleted.`,
                    )
                  ) {
                    return
                  }
                  void run(new FormData(formEl), true)
                }}
              >
                {busy === 'commit' ? 'Saving…' : 'Commit this schedule'}
              </button>
            )}
          </div>
        </form>
      </Card>

      {response && <GenerationReport response={response} showAll={showAllGames} onToggleAll={setShowAllGames} />}
    </div>
  )
}

function GenerationReport({
  response,
  showAll,
  onToggleAll,
}: {
  response: GenerateResponse
  showAll: boolean
  onToggleAll: (next: boolean) => void
}) {
  const { report, preview } = response
  const relaxed = report.softConstraints.filter((entry) => entry.relaxed)
  const met = report.softConstraints.filter((entry) => !entry.relaxed)
  const shown = showAll ? preview : preview.slice(0, 30)

  return (
    <div className="space-y-4">
      {response.committed ? (
        <Alert kind="success">
          Committed. {response.written?.created} game{response.written?.created === 1 ? '' : 's'} written,{' '}
          {response.written?.assignments} official assignment
          {response.written?.assignments === 1 ? '' : 's'} made, {response.written?.retired} previous
          game{response.written?.retired === 1 ? '' : 's'} retained in history.
        </Alert>
      ) : (
        <Alert kind="info">
          Preview only — nothing has been written. Read the report below, then commit.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Games placed', value: report.counts.placed },
          { label: 'Preserved', value: report.counts.preserved },
          { label: 'Could not place', value: report.counts.unplaced },
          {
            label: 'Officials filled',
            value: `${report.counts.officialsAssigned} / ${report.counts.officialsRequired}`,
          },
        ].map((stat) => (
          <Card key={stat.label}>
            <div className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
              {stat.label}
            </div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{stat.value}</div>
          </Card>
        ))}
      </div>

      {report.notes.length > 0 && (
        <Card>
          <h3 className="text-base font-semibold">Notes from the generator</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-600 dark:text-ink-300">
            {report.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h3 className="text-base font-semibold">Soft constraints</h3>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Hard constraints — double-booking, field availability, referee availability, blackouts —
          are never violated. Anything the generator had to give ground on is listed here.
        </p>

        {relaxed.length === 0 ? (
          <div className="mt-4">
            <Alert kind="success">Every fairness target was met.</Alert>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {relaxed.map((entry) => (
              <div
                key={entry.constraint}
                className="rounded-lg border border-amber-300 bg-amber-500/5 p-3 dark:border-amber-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="font-medium">{entry.constraint.replace(/_/g, ' ')}</h4>
                  <span className="text-xs text-amber-800 dark:text-amber-300">
                    off by up to {entry.magnitude} {entry.unit}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">Target: {entry.target}</p>
                <ul className="mt-2 space-y-0.5 text-sm">
                  {entry.affected.map((team) => (
                    <li key={`${entry.constraint}-${team.teamId}`}>
                      <span className="font-medium">{team.teamName}</span>{' '}
                      <span className="text-ink-500 dark:text-ink-400">— {team.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {met.length > 0 && (
          <p className="mt-4 text-xs text-ink-500 dark:text-ink-400">
            Met in full: {met.map((entry) => entry.constraint.replace(/_/g, ' ')).join(', ')}.
          </p>
        )}
      </Card>

      {report.unplaced.length > 0 && (
        <Card>
          <h3 className="text-base font-semibold">Fixtures that could not be placed</h3>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            These were left out rather than forced into a slot that breaks a hard constraint.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {report.unplaced.map((entry, index) => (
              <li key={index}>
                <span className="text-ink-500 dark:text-ink-400">round {entry.roundNumber}:</span>{' '}
                {humanize(entry.reason)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.unfilledOfficials.length > 0 && (
        <Card>
          <h3 className="text-base font-semibold">
            Unfilled officiating slots
            <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
              {report.unfilledOfficials.length}
            </span>
          </h3>
          <ul className="mt-3 space-y-1 text-sm">
            {report.unfilledOfficials.slice(0, 40).map((entry, index) => {
              const game = preview[entry.gameIndex]
              return (
                <li key={index}>
                  <span className="font-medium">{entry.position}</span>{' '}
                  <span className="text-ink-500 dark:text-ink-400">
                    for {game?.homeTeam ?? '?'} v {game?.awayTeam ?? '?'} — {humanize(entry.reason)}
                  </span>
                </li>
              )
            })}
          </ul>
          {report.unfilledOfficials.length > 40 && (
            <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
              …and {report.unfilledOfficials.length - 40} more.
            </p>
          )}
        </Card>
      )}

      {report.refereeLoad.some((load) => load.games > 0) && (
        <Card>
          <h3 className="text-base font-semibold">Officiating load</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Official</th>
                  <th className="pb-2 pr-4 font-medium">Games</th>
                  <th className="pb-2 font-medium">Pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {report.refereeLoad.map((load) => (
                  <tr key={load.refereeId}>
                    <td className="py-1.5 pr-4">{load.name}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{load.games}</td>
                    <td className="py-1.5 tabular-nums">${(load.payCents / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <h3 className="text-base font-semibold">Per-team summary</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
              <tr>
                <th className="pb-2 pr-4 font-medium">Team</th>
                <th className="pb-2 pr-4 font-medium">Games</th>
                <th className="pb-2 pr-4 font-medium">Home / away</th>
                <th className="pb-2 pr-4 font-medium">Byes</th>
                <th className="pb-2 pr-4 font-medium">Shortest rest</th>
                <th className="pb-2 font-medium">Early / mid / late</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
              {report.teams.map((team) => (
                <tr key={team.teamId}>
                  <td className="py-1.5 pr-4 font-medium">{team.teamName}</td>
                  <td className="py-1.5 pr-4 tabular-nums">{team.games}</td>
                  <td className="py-1.5 pr-4 tabular-nums">
                    {team.home} / {team.away}
                    {team.homeAwayDelta > 1 && (
                      <span className="ml-1 text-amber-700 dark:text-amber-300">
                        (±{team.homeAwayDelta})
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums">{team.byes}</td>
                  <td className="py-1.5 pr-4 tabular-nums">
                    {team.minRestDaysObserved === null ? '—' : `${team.minRestDaysObserved}d`}
                  </td>
                  <td className="py-1.5 tabular-nums text-ink-500 dark:text-ink-400">
                    {team.slotBuckets.early ?? 0} / {team.slotBuckets.midday ?? 0} /{' '}
                    {team.slotBuckets.late ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">
            Proposed games
            <span className="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400">
              {preview.length}
            </span>
          </h3>
          {preview.length > 30 && (
            <button type="button" className={secondaryButtonClass} onClick={() => onToggleAll(!showAll)}>
              {showAll ? 'Show first 30' : `Show all ${preview.length}`}
            </button>
          )}
        </div>

        {preview.length === 0 ? (
          <div className="mt-4">
            <EmptyState>No games were produced.</EmptyState>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Round</th>
                  <th className="pb-2 pr-4 font-medium">Local kickoff</th>
                  <th className="pb-2 pr-4 font-medium">Match</th>
                  <th className="pb-2 pr-4 font-medium">Where</th>
                  <th className="pb-2 font-medium">Officials</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                {shown.map((game) => (
                  <tr key={game.index}>
                    <td className="py-1.5 pr-4 tabular-nums">{game.roundNumber}</td>
                    <td className="py-1.5 pr-4 whitespace-nowrap">{game.localStartTime ?? '—'}</td>
                    <td className="py-1.5 pr-4">
                      {game.bracket ? (
                        <span className="text-ink-500 dark:text-ink-400">{game.bracket}</span>
                      ) : (
                        <>
                          {game.homeTeam} <span className="text-ink-500 dark:text-ink-400">v</span>{' '}
                          {game.awayTeam}
                        </>
                      )}
                      {game.preserved && (
                        <span className="ml-2 rounded-full bg-turf-500/15 px-2 py-0.5 text-xs text-turf-700 dark:text-turf-500">
                          preserved
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-4 text-xs text-ink-500 dark:text-ink-400">
                      {game.venue} · {game.field}
                    </td>
                    <td className="py-1.5 text-xs text-ink-500 dark:text-ink-400">
                      {game.officials.length === 0
                        ? '—'
                        : game.officials.map((o) => `${o.referee} (${o.position})`).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
          Kickoffs are shown in each venue&apos;s local time. Seed {report.seed} — the same seed and
          config regenerates this schedule exactly.
        </p>
      </Card>
    </div>
  )
}
