import {
  calendarDateInZone,
  formatCalendarDate,
  formatTimeOfDay,
  minutesFromMidnightInZone,
  parseCalendarDate,
  slotInstant,
} from '../time'
import type { ScheduleRow } from './read'

/**
 * The date × field × time grid the drag-and-drop editor drops onto.
 *
 * Built on the server because every cell needs a real UTC instant, and working out
 * what instant a cell denotes is zone arithmetic: the same 9:00 row means different
 * instants on a field in Denver and a field in Los Angeles, and different instants on
 * either side of a DST boundary. Doing it here keeps that maths in one tested place
 * and hands the client nothing but ISO strings.
 *
 * Time rows come from the kickoff times a day actually uses, plus each field's
 * published availability. That means a scheduler can always move a game to a slot a
 * sibling field is using, and to any slot the field itself declares free — including
 * one that is already occupied, which is the case the override flow exists for.
 */

export type GridGame = {
  id: string
  homeTeamName: string
  awayTeamName: string
  divisionName: string
  status: string
  officialCount: number
  durationMinutes: number
}

export type GridCell = {
  fieldId: string
  /** UTC instant this cell denotes, in the field's own zone. */
  startTime: string
  games: GridGame[]
}

export type GridTimeRow = {
  /** Minutes from local midnight, as the row is labelled. */
  minute: number
  label: string
  cells: GridCell[]
}

export type GridDay = {
  date: string
  rows: GridTimeRow[]
}

export type GridColumn = {
  id: string
  fieldName: string
  venueName: string
  timezone: string
}

export type ScheduleGrid = {
  columns: GridColumn[]
  days: GridDay[]
  /** Games with no field yet, which can be dragged into the grid. */
  unplaced: GridGame[]
}

export type GridFieldInput = {
  id: string
  name: string
  venueId: string
  venueName: string
  timezone: string
  timeSlots: Array<{
    dayOfWeek: number | null
    startMinute: number
    endMinute: number
    specificDate: Date | null
    effectiveFrom: Date | null
    effectiveTo: Date | null
  }>
}

const toGame = (row: ScheduleRow): GridGame => ({
  id: row.id,
  homeTeamName: row.homeTeamName,
  awayTeamName: row.awayTeamName,
  divisionName: row.divisionName,
  status: row.status,
  officialCount: row.officials.length,
  durationMinutes: row.durationMinutes,
})

/** Local start minutes a field declares as bookable on a given local date. */
function declaredMinutes(
  field: GridFieldInput,
  localDate: Date,
  stepMinutes: number,
  durationMinutes: number,
): number[] {
  const dayOfWeek = localDate.getUTCDay()
  const out: number[] = []

  for (const slot of field.timeSlots) {
    if (slot.specificDate) {
      if (slot.specificDate.getTime() !== localDate.getTime()) continue
    } else {
      if (slot.dayOfWeek !== dayOfWeek) continue
      if (slot.effectiveFrom && localDate.getTime() < slot.effectiveFrom.getTime()) continue
      if (slot.effectiveTo && localDate.getTime() > slot.effectiveTo.getTime()) continue
    }
    for (
      let minute = slot.startMinute;
      minute + durationMinutes <= slot.endMinute;
      minute += stepMinutes
    ) {
      out.push(minute)
    }
  }
  return out
}

export function buildScheduleGrid(input: {
  rows: ScheduleRow[]
  fields: GridFieldInput[]
  /** Spacing of generated drop targets within an availability window. */
  stepMinutes?: number
  durationMinutes?: number
}): ScheduleGrid {
  const { rows, fields } = input
  const stepMinutes = input.stepMinutes ?? 75
  const durationMinutes = input.durationMinutes ?? 60

  const placed = rows.filter((row) => row.fieldId)
  const unplaced = rows.filter((row) => !row.fieldId).map(toGame)

  // Only fields that either hold a game or declare availability on a day in range.
  const byField = new Map(fields.map((field) => [field.id, field]))
  const columns: GridColumn[] = fields
    .map((field) => ({
      id: field.id,
      fieldName: field.name,
      venueName: field.venueName,
      timezone: field.timezone,
    }))
    .sort(
      (a, b) => a.venueName.localeCompare(b.venueName) || a.fieldName.localeCompare(b.fieldName),
    )

  // Dates come from the games themselves: the editor edits an existing schedule
  // rather than offering the whole season.
  const dates = new Set<string>()
  for (const row of placed) {
    dates.add(formatCalendarDate(calendarDateInZone(row.startTime, row.timezone)))
  }

  const days: GridDay[] = [...dates]
    .sort()
    .map((date) => {
      const localDate = parseCalendarDate(date)

      // Rows: every minute a game on this date starts at, in its own field's zone,
      // unioned with every minute each field declares free.
      const minutes = new Set<number>()
      for (const row of placed) {
        const rowDate = formatCalendarDate(calendarDateInZone(row.startTime, row.timezone))
        if (rowDate === date) minutes.add(minutesFromMidnightInZone(row.startTime, row.timezone))
      }
      for (const field of fields) {
        for (const minute of declaredMinutes(field, localDate, stepMinutes, durationMinutes)) {
          minutes.add(minute)
        }
      }

      const timeRows: GridTimeRow[] = [...minutes]
        .sort((a, b) => a - b)
        .map((minute) => ({
          minute,
          label: formatTimeOfDay(minute),
          cells: columns.map((column) => {
            const field = byField.get(column.id)!
            // The cell's instant is this local reading in *this field's* zone, which is
            // why a cross-venue move can change the underlying UTC time.
            const startTime = slotInstant(localDate, minute, field.timezone)
            return {
              fieldId: column.id,
              startTime: startTime.toISOString(),
              games: placed
                .filter(
                  (row) =>
                    row.fieldId === column.id &&
                    row.startTime.getTime() === startTime.getTime(),
                )
                .map(toGame),
            }
          }),
        }))

      return { date, rows: timeRows }
    })
    // A date whose every cell is empty carries no information.
    .filter((day) => day.rows.some((row) => row.cells.some((cell) => cell.games.length > 0)))

  return { columns, days, unplaced }
}
