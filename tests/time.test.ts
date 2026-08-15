import { describe, expect, it } from 'vitest'
import {
  calendarDateInZone,
  dayOfWeekInZone,
  eachCalendarDate,
  formatCalendarDate,
  formatTimeOfDay,
  minutesFromMidnightInZone,
  parseCalendarDate,
  parseTimeOfDay,
  slotInstant,
  zoneOffsetMinutes,
  zonedTimeToUtc,
} from '@/lib/time'

/**
 * Non-negotiable #3: timestamps stored as UTC, rendered in the venue's local time.
 * The cases that actually break naive implementations are the DST boundaries, so
 * those are the ones pinned here.
 */

describe('calendar dates', () => {
  it('round-trips without shifting zone', () => {
    const date = parseCalendarDate('2026-03-07')
    expect(formatCalendarDate(date)).toBe('2026-03-07')
    expect(date.toISOString()).toBe('2026-03-07T00:00:00.000Z')
  })

  it('rejects impossible dates', () => {
    expect(() => parseCalendarDate('2026-02-30')).toThrow()
    expect(() => parseCalendarDate('2026-13-01')).toThrow()
    expect(() => parseCalendarDate('not-a-date')).toThrow()
  })

  it('enumerates an inclusive range', () => {
    const days = eachCalendarDate(parseCalendarDate('2026-03-07'), parseCalendarDate('2026-03-10'))
    expect(days.map(formatCalendarDate)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ])
  })
})

describe('times of day', () => {
  it('converts between HH:MM and minutes from midnight', () => {
    expect(parseTimeOfDay('08:00')).toBe(480)
    expect(parseTimeOfDay('18:30')).toBe(1110)
    expect(parseTimeOfDay('00:00')).toBe(0)
    expect(formatTimeOfDay(480)).toBe('08:00')
    expect(formatTimeOfDay(1110)).toBe('18:30')
  })

  it('rejects impossible times', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow()
    expect(() => parseTimeOfDay('08:60')).toThrow()
  })
})

describe('zone offsets', () => {
  it('tracks US Pacific across its DST transition', () => {
    // 2026: US DST starts Mar 8, ends Nov 1.
    expect(zoneOffsetMinutes(new Date('2026-03-07T20:00:00Z'), 'America/Los_Angeles')).toBe(-480)
    expect(zoneOffsetMinutes(new Date('2026-03-14T20:00:00Z'), 'America/Los_Angeles')).toBe(-420)
  })

  it('handles a southern-hemisphere zone, where DST runs the other way', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-15T00:00:00Z'), 'Australia/Sydney')).toBe(660)
    expect(zoneOffsetMinutes(new Date('2026-07-15T00:00:00Z'), 'Australia/Sydney')).toBe(600)
  })

  it('reports zero for UTC year round', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-01T00:00:00Z'), 'UTC')).toBe(0)
    expect(zoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'UTC')).toBe(0)
  })
})

describe('local wall-clock to UTC', () => {
  /**
   * The heart of it: a "Saturdays 8am" rule must resolve to a *different* UTC
   * instant either side of the DST change, because 8am local is what the field is
   * actually booked for.
   */
  it('keeps 8am local across a spring-forward boundary', () => {
    const beforeDst = zonedTimeToUtc(2026, 3, 7, 480, 'America/Los_Angeles')
    const afterDst = zonedTimeToUtc(2026, 3, 14, 480, 'America/Los_Angeles')

    expect(beforeDst.toISOString()).toBe('2026-03-07T16:00:00.000Z') // UTC-8
    expect(afterDst.toISOString()).toBe('2026-03-14T15:00:00.000Z') // UTC-7

    // Both still read as 8am at the venue, which is the whole point.
    expect(minutesFromMidnightInZone(beforeDst, 'America/Los_Angeles')).toBe(480)
    expect(minutesFromMidnightInZone(afterDst, 'America/Los_Angeles')).toBe(480)
  })

  it('keeps 8am local across a fall-back boundary', () => {
    const beforeEnd = zonedTimeToUtc(2026, 10, 31, 480, 'America/Los_Angeles')
    const afterEnd = zonedTimeToUtc(2026, 11, 7, 480, 'America/Los_Angeles')

    expect(beforeEnd.toISOString()).toBe('2026-10-31T15:00:00.000Z')
    expect(afterEnd.toISOString()).toBe('2026-11-07T16:00:00.000Z')
    expect(minutesFromMidnightInZone(afterEnd, 'America/Los_Angeles')).toBe(480)
  })

  it('resolves a nonexistent local time forward past the gap', () => {
    // 2:30am does not exist on 2026-03-08 in US Pacific; clocks jump 2am -> 3am.
    const instant = zonedTimeToUtc(2026, 3, 8, 150, 'America/Los_Angeles')
    // Lands at 3:30am PDT, the next real moment, rather than throwing or silently
    // wrapping to the previous day.
    expect(minutesFromMidnightInZone(instant, 'America/Los_Angeles')).toBe(210)
    expect(calendarDateInZone(instant, 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-08T00:00:00.000Z',
    )
  })

  it('resolves an ambiguous local time to its first occurrence', () => {
    // 1:30am happens twice on 2026-11-01 in US Pacific.
    const instant = zonedTimeToUtc(2026, 11, 1, 90, 'America/Los_Angeles')
    expect(instant.toISOString()).toBe('2026-11-01T08:30:00.000Z') // PDT, the earlier one
    expect(minutesFromMidnightInZone(instant, 'America/Los_Angeles')).toBe(90)
  })

  it('round-trips a whole season of Saturday 8am slots', () => {
    const tz = 'America/Los_Angeles'
    let date = parseCalendarDate('2026-02-07')
    let crossings = 0

    for (let week = 0; week < 20; week++) {
      const instant = slotInstant(date, 480, tz)
      // Always Saturday, always 8am, whatever UTC says.
      expect(dayOfWeekInZone(instant, tz)).toBe(6)
      expect(minutesFromMidnightInZone(instant, tz)).toBe(480)
      expect(formatCalendarDate(calendarDateInZone(instant, tz))).toBe(formatCalendarDate(date))
      if (instant.getUTCHours() === 15) crossings++
      date = new Date(date.getTime() + 7 * 86_400_000)
    }

    // Some of those weeks were PDT (15:00Z) and some PST (16:00Z) — if they were
    // all the same, the test would not be exercising anything.
    expect(crossings).toBeGreaterThan(0)
    expect(crossings).toBeLessThan(20)
  })

  it('works for a zone with a half-hour offset', () => {
    const instant = zonedTimeToUtc(2026, 6, 15, 600, 'Asia/Kolkata') // 10:00 IST
    expect(instant.toISOString()).toBe('2026-06-15T04:30:00.000Z')
    expect(minutesFromMidnightInZone(instant, 'Asia/Kolkata')).toBe(600)
  })
})

describe('local day boundaries', () => {
  it('assigns a late-evening game to the local date, not the UTC date', () => {
    // 8pm Pacific on Apr 11 is already Apr 12 in UTC.
    const instant = zonedTimeToUtc(2026, 4, 11, 1200, 'America/Los_Angeles')
    expect(instant.toISOString()).toBe('2026-04-12T03:00:00.000Z')
    expect(formatCalendarDate(calendarDateInZone(instant, 'America/Los_Angeles'))).toBe('2026-04-11')
    expect(dayOfWeekInZone(instant, 'America/Los_Angeles')).toBe(6) // Saturday
    // Read in UTC it would look like Sunday the 12th — the bug this guards against.
    expect(formatCalendarDate(calendarDateInZone(instant, 'UTC'))).toBe('2026-04-12')
  })

  it('separates two venues in different zones at the same instant', () => {
    const instant = new Date('2026-04-12T02:00:00Z')
    expect(formatCalendarDate(calendarDateInZone(instant, 'America/Los_Angeles'))).toBe('2026-04-11')
    expect(formatCalendarDate(calendarDateInZone(instant, 'Europe/London'))).toBe('2026-04-12')
  })
})
