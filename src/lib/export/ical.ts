import type { ScheduleRow } from '../schedule/read'

/**
 * iCalendar (RFC 5545) generation for live subscription feeds.
 *
 * Three decisions matter here, and all three are about what a calendar client does with
 * a feed it re-fetches every few hours:
 *
 *  1. **UIDs are stable and derived from the game id.** A client replaces an event whose
 *     UID it has seen rather than adding a second one, so a rescheduled game moves
 *     instead of appearing twice. A random UID per render would duplicate the whole
 *     season on every poll.
 *  2. **Times are emitted as UTC (`Z`) instants.** The kickoff is an instant; the client
 *     renders it in the subscriber's own zone. Emitting a floating local time would put
 *     an away game at the wrong hour for anyone travelling, and shipping VTIMEZONE
 *     blocks means hand-maintaining DST rules the platform already knows.
 *  3. **`SEQUENCE` comes from the row's own version counter.** A client is entitled to
 *     ignore an update whose SEQUENCE has not advanced.
 *
 * Dependency-free, and a pure function of its rows, so the output is testable without a
 * request and identical wherever it runs.
 */

export type IcalEvent = {
  uid: string
  start: Date
  durationMinutes: number
  summary: string
  description?: string
  location?: string
  /** Bumped when the event changes, so clients accept the update. */
  sequence?: number
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
}

export type IcalCalendar = {
  name: string
  description?: string
  /** Suggested client refresh interval, ISO 8601 duration. */
  refreshInterval?: string
  events: IcalEvent[]
  /** Fixed in tests; defaults to now. */
  stamp?: Date
}

const CRLF = '\r\n'

/** iCalendar's UTC form: 20260516T160000Z. No punctuation, always Zulu. */
export function icalInstant(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`
}

/**
 * Escapes a TEXT value. Backslash first, or it would double-escape the sequences the
 * later replacements introduce.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Folds a content line to 75 octets, continuing with a leading space.
 *
 * Counted in octets rather than characters, and never split inside a multi-byte
 * sequence — a fold in the middle of a UTF-8 character produces a file some clients
 * reject outright.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const parts: string[] = []
  let offset = 0
  let limit = 75
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length)
    // Walk back off a continuation byte so the split lands on a character boundary.
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
    parts.push(bytes.subarray(offset, end).toString('utf8'))
    offset = end
    // Continuation lines carry a leading space, which costs one of the 75 octets.
    limit = 74
  }
  return parts.join(`${CRLF} `)
}

export function buildIcal(calendar: IcalCalendar): string {
  const stamp = icalInstant(calendar.stamp ?? new Date())

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//THE YARD//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `NAME:${escapeText(calendar.name)}`,
  ]
  if (calendar.description) {
    lines.push(`X-WR-CALDESC:${escapeText(calendar.description)}`)
    lines.push(`DESCRIPTION:${escapeText(calendar.description)}`)
  }
  if (calendar.refreshInterval) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${calendar.refreshInterval}`)
    lines.push(`X-PUBLISHED-TTL:${calendar.refreshInterval}`)
  }

  for (const event of calendar.events) {
    const end = new Date(event.start.getTime() + event.durationMinutes * 60_000)
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icalInstant(event.start)}`,
      `DTEND:${icalInstant(end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `SEQUENCE:${event.sequence ?? 0}`,
      `STATUS:${event.status ?? 'CONFIRMED'}`,
      'TRANSP:OPAQUE',
    )
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 requires CRLF line endings and a trailing break.
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`
}

const CANCELLED = new Set(['cancelled', 'forfeited'])
const TENTATIVE = new Set(['postponed'])

/**
 * Turns schedule rows into events.
 *
 * A cancelled game is emitted as `STATUS:CANCELLED` rather than dropped: a subscriber
 * who already has the event needs to be told it is off, and silently removing it from
 * the feed leaves a stale entry in their calendar forever.
 */
export function scheduleToIcal(input: {
  rows: ScheduleRow[]
  name: string
  description?: string
  /** Host part of the UID domain, so UIDs are globally unique to this deployment. */
  domain: string
  stamp?: Date
}): string {
  return buildIcal({
    name: input.name,
    description: input.description,
    refreshInterval: 'PT2H',
    stamp: input.stamp,
    events: input.rows.map((row) => ({
      uid: `game-${row.id}@${input.domain}`,
      start: row.startTime,
      durationMinutes: row.durationMinutes,
      summary: `${row.homeTeamName} v ${row.awayTeamName}`,
      location: row.venueName ? `${row.venueName} — ${row.fieldName}` : undefined,
      description: [
        row.divisionName,
        row.roundNumber !== null ? `Round ${row.roundNumber}` : null,
        row.officials.length
          ? `Officials: ${row.officials.map((official) => official.refereeName).join(', ')}`
          : null,
        row.notes,
      ]
        .filter(Boolean)
        .join('\n'),
      status: CANCELLED.has(row.status)
        ? 'CANCELLED'
        : TENTATIVE.has(row.status)
          ? 'TENTATIVE'
          : 'CONFIRMED',
    })),
  })
}

export function icalResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="${filename.replace(/[^\w.-]+/g, '-')}"`,
      // Clients poll this; a cached copy would delay a reschedule reaching anyone.
      'cache-control': 'no-store',
    },
  })
}
