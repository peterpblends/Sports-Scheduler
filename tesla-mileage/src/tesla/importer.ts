/**
 * Bringing in history from somewhere else.
 *
 * Two shapes are accepted, and the importer works out which one it is looking at
 * from the header row:
 *
 *   readings — a log of positions/odometer over time (TeslaFi position exports,
 *              TeslaMate position dumps, anything with a timestamp and an
 *              odometer). These go through the same stitching as live data, so
 *              imported history behaves exactly like recorded history.
 *
 *   trips    — one row per completed drive (Tessie and TeslaMate drive exports,
 *              or a spreadsheet kept by hand). Distances are taken as given.
 *
 * Nothing here needs to be exact about column names: the mapper accepts the
 * common spellings and reports what it could not understand.
 */
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import type { Classification, Sample } from '../domain/types.ts';
import { isClassification } from '../domain/types.ts';
import { rebuildTrips } from '../domain/pipeline.ts';
import { isValidIso, nowIso, zonedToUtcIso } from '../lib/time.ts';

/** Split CSV text into rows, honoring quoted fields and either line ending. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Find the first header whose normalized name is in `candidates`. */
function columnIndex(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = headers.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

const COLUMNS = {
  timestamp: ['timestamp', 'date', 'datetime', 'time', 'date_time', 'recorded_at', 'at', 'start_date'],
  odometer: ['odometer', 'odometer_mi', 'odometer_miles', 'odo', 'end_odometer'],
  startOdometer: ['start_odometer', 'odometer_start', 'starting_odometer'],
  endOdometer: ['end_odometer', 'odometer_end', 'ending_odometer'],
  latitude: ['latitude', 'lat', 'start_latitude'],
  longitude: ['longitude', 'lon', 'lng', 'long', 'start_longitude'],
  endLatitude: ['end_latitude', 'end_lat'],
  endLongitude: ['end_longitude', 'end_lon', 'end_lng'],
  shift: ['shift_state', 'shift', 'gear'],
  speed: ['speed', 'speed_mph'],
  battery: ['battery_level', 'usable_battery_level', 'battery'],
  state: ['state', 'vehicle_state'],
  startedAt: ['start_date', 'started_at', 'start_time', 'start', 'date'],
  endedAt: ['end_date', 'ended_at', 'end_time', 'end'],
  distance: ['distance', 'distance_mi', 'distance_miles', 'miles', 'mileage', 'trip_miles'],
  startName: ['start_address', 'start_location', 'from', 'origin', 'start'],
  endName: ['end_address', 'end_location', 'to', 'destination', 'end'],
  classification: ['classification', 'category', 'type', 'business_personal'],
  purpose: ['purpose', 'business_purpose', 'reason', 'description', 'notes'],
  client: ['client', 'customer', 'account', 'project'],
};

function cell(row: string[], index: number): string {
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

function toNumber(value: string): number | null {
  if (value === '') return null;
  const cleaned = value.replace(/[$,]/g, '').replace(/\s*(mi|miles|km)\s*$/i, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/;
const US_LIKE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/;

/**
 * Read a timestamp from a spreadsheet.
 *
 * A time with no zone on it is the driver's wall clock, not UTC — reading it as
 * UTC would move trips across midnight and, at the turn of the year, into the
 * wrong tax year. Those are resolved in `timezone`; anything that carries its
 * own offset is respected as written.
 */
export function toIsoTimestamp(value: string, timezone = 'UTC'): string | null {
  const raw = value.trim();
  if (raw === '') return null;

  if (HAS_ZONE.test(raw)) {
    const candidate = raw.includes('T') ? raw : raw.replace(' ', 'T');
    if (isValidIso(candidate)) return new Date(candidate).toISOString();
  }

  const iso = ISO_LIKE.exec(raw);
  if (iso !== null) {
    return zonedToUtcIso(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      Number(iso[6] ?? 0),
      timezone,
    );
  }

  const us = US_LIKE.exec(raw);
  if (us !== null) {
    let hour = Number(us[4] ?? 0);
    const meridiem = (us[7] ?? '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return zonedToUtcIso(
      Number(us[3]),
      Number(us[1]),
      Number(us[2]),
      hour,
      Number(us[5] ?? 0),
      Number(us[6] ?? 0),
      timezone,
    );
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toClassification(value: string): Classification | null {
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  if (text.startsWith('b')) return 'business';
  if (text.startsWith('p')) return 'personal';
  if (text.startsWith('co')) return 'commute';
  if (text.startsWith('m')) return 'medical';
  if (text.startsWith('ch')) return 'charity';
  return isClassification(text) ? text : null;
}

export type ImportReport = {
  kind: 'readings' | 'trips' | 'unknown';
  rowsSeen: number;
  imported: number;
  skipped: number;
  tripsCreated: number;
  problems: string[];
};

/** Decide which shape a file is, from its headers. */
export function detectKind(headers: string[]): ImportReport['kind'] {
  const hasDistance = columnIndex(headers, COLUMNS.distance) >= 0;
  const hasEndTime = columnIndex(headers, COLUMNS.endedAt) >= 0;
  const hasOdometer =
    columnIndex(headers, COLUMNS.odometer) >= 0 || columnIndex(headers, COLUMNS.startOdometer) >= 0;
  const hasPosition = columnIndex(headers, COLUMNS.latitude) >= 0;

  if (hasDistance && hasEndTime) return 'trips';
  if (hasOdometer && !hasDistance) return 'readings';
  if (hasPosition && !hasDistance) return 'readings';
  if (hasDistance) return 'trips';
  return 'unknown';
}

export function importCsv(
  db: Database,
  vehicleId: number,
  text: string,
  options: { source?: string; timezone?: string } = {},
): ImportReport {
  const timezone = options.timezone ?? 'UTC';
  const rows = parseCsv(text);
  const headerRow = rows[0];
  if (headerRow === undefined) {
    return { kind: 'unknown', rowsSeen: 0, imported: 0, skipped: 0, tripsCreated: 0, problems: ['the file is empty'] };
  }
  const headers = headerRow.map(normalizeHeader);
  const kind = detectKind(headers);
  const body = rows.slice(1);

  if (kind === 'readings') {
    return importReadings(db, vehicleId, headers, body, options.source ?? 'import', timezone);
  }
  if (kind === 'trips') return importTrips(db, vehicleId, headers, body, timezone);
  return {
    kind,
    rowsSeen: body.length,
    imported: 0,
    skipped: body.length,
    tripsCreated: 0,
    problems: [
      `Could not tell what these columns are: ${headers.join(', ')}. A readings file needs a timestamp and an odometer; a trips file needs a start time, an end time, and a distance.`,
    ],
  };
}

function importReadings(
  db: Database,
  vehicleId: number,
  headers: string[],
  rows: string[][],
  source: string,
  timezone: string,
): ImportReport {
  const at = columnIndex(headers, COLUMNS.timestamp);
  const odometer = columnIndex(headers, COLUMNS.odometer);
  const latitude = columnIndex(headers, COLUMNS.latitude);
  const longitude = columnIndex(headers, COLUMNS.longitude);
  const shift = columnIndex(headers, COLUMNS.shift);
  const speed = columnIndex(headers, COLUMNS.speed);
  const battery = columnIndex(headers, COLUMNS.battery);
  const state = columnIndex(headers, COLUMNS.state);

  const problems: string[] = [];
  let imported = 0;
  let skipped = 0;
  let earliest: string | null = null;

  const samples: Sample[] = [];
  for (const row of rows) {
    const stamp = toIsoTimestamp(cell(row, at), timezone);
    if (stamp === null) {
      skipped += 1;
      if (problems.length < 5) problems.push(`Could not read the timestamp "${cell(row, at)}"`);
      continue;
    }
    const odo = toNumber(cell(row, odometer));
    const lat = toNumber(cell(row, latitude));
    const lon = toNumber(cell(row, longitude));
    if (odo === null && (lat === null || lon === null)) {
      skipped += 1;
      continue;
    }
    samples.push({
      vehicleId,
      at: stamp,
      odometerMiles: odo,
      latitude: lat,
      longitude: lon,
      shiftState: cell(row, shift) === '' ? null : cell(row, shift),
      speedMph: toNumber(cell(row, speed)),
      state: cell(row, state) === '' ? null : cell(row, state),
      chargingState: null,
      batteryLevel: toNumber(cell(row, battery)),
      cached: false,
      source,
    });
    if (earliest === null || stamp < earliest) earliest = stamp;
  }

  db.transaction(() => {
    for (const sample of samples) {
      if (repo.insertSample(db, sample)) imported += 1;
    }
  });

  const rebuilt = earliest === null ? { created: 0 } : rebuildTrips(db, vehicleId, earliest);
  return { kind: 'readings', rowsSeen: rows.length, imported, skipped, tripsCreated: rebuilt.created, problems };
}

function importTrips(
  db: Database,
  vehicleId: number,
  headers: string[],
  rows: string[][],
  timezone: string,
): ImportReport {
  const startedAt = columnIndex(headers, COLUMNS.startedAt);
  const endedAt = columnIndex(headers, COLUMNS.endedAt);
  const distance = columnIndex(headers, COLUMNS.distance);
  const startName = columnIndex(headers, COLUMNS.startName);
  const endName = columnIndex(headers, COLUMNS.endName);
  const startOdo = columnIndex(headers, COLUMNS.startOdometer);
  const endOdo = columnIndex(headers, COLUMNS.endOdometer);
  const startLat = columnIndex(headers, COLUMNS.latitude);
  const startLon = columnIndex(headers, COLUMNS.longitude);
  const endLat = columnIndex(headers, COLUMNS.endLatitude);
  const endLon = columnIndex(headers, COLUMNS.endLongitude);
  const classification = columnIndex(headers, COLUMNS.classification);
  const purpose = columnIndex(headers, COLUMNS.purpose);
  const client = columnIndex(headers, COLUMNS.client);

  const problems: string[] = [];
  let imported = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const row of rows) {
      const start = toIsoTimestamp(cell(row, startedAt), timezone);
      const miles = toNumber(cell(row, distance));
      if (start === null || miles === null) {
        skipped += 1;
        if (problems.length < 5) {
          problems.push(`Skipped a row with no usable start time or distance: ${row.slice(0, 3).join(', ')}`);
        }
        continue;
      }
      const end = toIsoTimestamp(cell(row, endedAt), timezone) ?? start;
      const decided = toClassification(cell(row, classification));
      const duration = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));

      repo.upsertTrip(db, {
        vehicleId,
        startedAt: start,
        endedAt: end,
        startLatitude: toNumber(cell(row, startLat)),
        startLongitude: toNumber(cell(row, startLon)),
        endLatitude: toNumber(cell(row, endLat)),
        endLongitude: toNumber(cell(row, endLon)),
        startOdometerMiles: toNumber(cell(row, startOdo)),
        endOdometerMiles: toNumber(cell(row, endOdo)),
        distanceMiles: miles,
        durationSeconds: duration,
        startPlaceId: null,
        endPlaceId: null,
        startDescription: cell(row, startName) === '' ? null : cell(row, startName),
        endDescription: cell(row, endName) === '' ? null : cell(row, endName),
        classification: decided ?? 'unclassified',
        classificationSource: decided === null ? 'none' : 'user',
        classificationReason: decided === null ? 'Imported without a category' : 'Imported with a category already set',
        confidence: decided === null ? 0 : 1,
        purpose: cell(row, purpose) === '' ? null : cell(row, purpose),
        client: cell(row, client) === '' ? null : cell(row, client),
        notes: `Imported ${nowIso().slice(0, 10)}`,
        locked: decided !== null,
        inferred: true,
        open: false,
        distanceSource: 'odometer',
        needsReview: decided === null,
        signature: null,
      });
      imported += 1;
    }
  });

  return { kind: 'trips', rowsSeen: rows.length, imported, skipped, tripsCreated: imported, problems };
}
