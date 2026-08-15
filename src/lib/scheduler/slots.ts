import {
  addCalendarDays,
  calendarDayOfWeek,
  formatCalendarDate,
  parseCalendarDate,
  slotInstant,
} from '../time'
import { windowForDay } from './config'
import type { BlackoutInput, FieldInput, ScheduleConfig, SlotBucket } from './types'

/**
 * A concrete, bookable kickoff: one field, one instant.
 *
 * Field availability is stored as local wall-clock rules ("Saturdays 8am-6pm,
 * Mar 1 - Jun 15"). This turns those rules into real UTC instants by walking the
 * season's calendar dates and converting each occurrence in the venue's own zone —
 * which is why a slot's UTC time shifts by an hour across a DST boundary while its
 * local time does not.
 */
export type CandidateSlot = {
  /** Stable identifier, useful in reports and tie-breaking. */
  key: string
  fieldId: string
  fieldName: string
  venueId: string
  venueName: string
  timezone: string
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string
  /** Minutes from local midnight. */
  startMinute: number
  /** UTC instant of kickoff. */
  startTime: Date
  /** UTC instant the game ends, excluding buffer. */
  endTime: Date
  /** Index of this date within the season's playable dates, from 0. */
  dateIndex: number
  bucket: SlotBucket
}

/**
 * Buckets a local start time so "no team is always stuck at 8am" is measurable.
 * Boundaries are deliberately coarse — the aim is rotation, not precision.
 */
export function bucketFor(startMinute: number): SlotBucket {
  if (startMinute < 10 * 60) return 'early'
  if (startMinute < 15 * 60) return 'midday'
  return 'late'
}

/** Calendar dates in the season that fall on a playable day of the week. */
export function playableDates(
  seasonStart: string,
  seasonEnd: string,
  config: ScheduleConfig,
): string[] {
  const start = parseCalendarDate(seasonStart)
  const end = parseCalendarDate(seasonEnd)
  const playable = new Set(config.playableDaysOfWeek)
  const dates: string[] = []

  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addCalendarDays(cursor, 1)) {
    if (playable.has(calendarDayOfWeek(cursor))) dates.push(formatCalendarDate(cursor))
  }
  return dates
}

/** Org- and venue-scoped blackouts, which remove whole slots regardless of who plays. */
function slotBlockingBlackouts(blackouts: BlackoutInput[]): {
  org: Array<{ from: string; to: string }>
  byVenue: Map<string, Array<{ from: string; to: string }>>
} {
  const org: Array<{ from: string; to: string }> = []
  const byVenue = new Map<string, Array<{ from: string; to: string }>>()

  for (const blackout of blackouts) {
    const range = { from: blackout.startDate, to: blackout.endDate }
    if (blackout.scope === 'org') org.push(range)
    else if (blackout.scope === 'venue' && blackout.venueId) {
      const list = byVenue.get(blackout.venueId) ?? []
      list.push(range)
      byVenue.set(blackout.venueId, list)
    }
  }
  return { org, byVenue }
}

/** ISO dates compare correctly as strings, so no parsing needed here. */
function covers(ranges: Array<{ from: string; to: string }> | undefined, date: string): boolean {
  return (ranges ?? []).some((r) => date >= r.from && date <= r.to)
}

function slotAppliesOn(
  slot: FieldInput['timeSlots'][number],
  date: string,
  dayOfWeek: number,
): boolean {
  if (slot.specificDate) return slot.specificDate === date
  if (slot.dayOfWeek !== dayOfWeek) return false
  if (slot.effectiveFrom && date < slot.effectiveFrom) return false
  if (slot.effectiveTo && date > slot.effectiveTo) return false
  return true
}

/**
 * Every slot a game could be placed in, in chronological order.
 *
 * Within an availability window, kickoffs are carved at `duration + buffer` steps
 * from the window's start, so consecutive games on one field never overlap and
 * always leave the configured clearance. A game must finish inside the window.
 *
 * Org- and venue-level blackouts are applied here. Division- and team-level ones
 * depend on who is playing, so they are checked during placement instead.
 */
export function expandSlots(
  fields: FieldInput[],
  config: ScheduleConfig,
  season: { startDate: string; endDate: string },
  blackouts: BlackoutInput[],
): CandidateSlot[] {
  const dates = playableDates(season.startDate, season.endDate, config)
  const dateIndex = new Map(dates.map((date, index) => [date, index]))
  const blocking = slotBlockingBlackouts(blackouts)
  const step = config.gameDurationMinutes + config.bufferMinutes

  const slots: CandidateSlot[] = []

  // Fields sorted by id so the output order never depends on input order.
  for (const field of [...fields].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const date of dates) {
      if (covers(blocking.org, date)) continue
      if (covers(blocking.byVenue.get(field.venueId), date)) continue

      const calendarDate = parseCalendarDate(date)
      const dayOfWeek = calendarDayOfWeek(calendarDate)
      const { earliest, latest } = windowForDay(config, dayOfWeek)

      for (const window of field.timeSlots) {
        if (!slotAppliesOn(window, date, dayOfWeek)) continue

        const from = Math.max(window.startMinute, earliest)
        const until = Math.min(window.endMinute, latest + config.gameDurationMinutes)

        for (
          let startMinute = from;
          startMinute + config.gameDurationMinutes <= until && startMinute <= latest;
          startMinute += step
        ) {
          const startTime = slotInstant(calendarDate, startMinute, field.timezone)
          slots.push({
            key: `${field.id}|${date}|${startMinute}`,
            fieldId: field.id,
            fieldName: field.name,
            venueId: field.venueId,
            venueName: field.venueName,
            timezone: field.timezone,
            date,
            startMinute,
            startTime,
            endTime: new Date(startTime.getTime() + config.gameDurationMinutes * 60_000),
            dateIndex: dateIndex.get(date) ?? 0,
            bucket: bucketFor(startMinute),
          })
        }
      }
    }
  }

  // Two windows on one field can overlap (a weekly rule plus a one-off), which
  // would otherwise yield duplicate kickoffs.
  const unique = new Map<string, CandidateSlot>()
  for (const slot of slots) if (!unique.has(slot.key)) unique.set(slot.key, slot)

  return [...unique.values()].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.key.localeCompare(b.key),
  )
}

/** Monday-based ISO week key, used for the per-week game cap. */
export function weekKey(date: string): string {
  const parsed = parseCalendarDate(date)
  const day = parsed.getUTCDay()
  const monday = addCalendarDays(parsed, day === 0 ? -6 : 1 - day)
  return formatCalendarDate(monday)
}
