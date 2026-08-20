/**
 * Typed access to the ledger. Rows come out of SQLite in snake_case and are
 * mapped to the camelCase domain types here, so nothing above this file has to
 * know about column names.
 */
import type { Database, Row } from './index.ts';
import type {
  Classification,
  ClassificationSource,
  Place,
  PlaceKind,
  PlaceLabel,
  Sample,
  Trip,
} from '../domain/types.ts';
import type { Rule, RuleConditions } from '../domain/classify.ts';
import { parseConditions } from '../domain/classify.ts';
import type { GeoInfo } from '../domain/places.ts';
import { IRS_RATES, type RatePeriod } from '../domain/rates.ts';
import { localMonth, nowIso } from '../lib/time.ts';
import { open as openSecret, seal } from '../lib/secretbox.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';

// -- small coercion helpers ---------------------------------------------------

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

// -- vehicles -----------------------------------------------------------------

export type Vehicle = {
  id: number;
  vin: string | null;
  teslaId: string | null;
  displayName: string;
  model: string | null;
  active: boolean;
  lastOdometerMiles: number | null;
  lastSampleAt: string | null;
  lastState: string | null;
};

function toVehicle(row: Row): Vehicle {
  return {
    id: Number(row.id),
    vin: text(row.vin),
    teslaId: text(row.tesla_id),
    displayName: String(row.display_name),
    model: text(row.model),
    active: flag(row.active),
    lastOdometerMiles: num(row.last_odometer_miles),
    lastSampleAt: text(row.last_sample_at),
    lastState: text(row.last_state),
  };
}

export function listVehicles(db: Database, includeInactive = false): Vehicle[] {
  const sql = includeInactive
    ? 'SELECT * FROM vehicle ORDER BY id'
    : 'SELECT * FROM vehicle WHERE active = 1 ORDER BY id';
  return db.all<Row>(sql).map(toVehicle);
}

export function getVehicle(db: Database, id: number): Vehicle | null {
  const row = db.get<Row>('SELECT * FROM vehicle WHERE id = ?', id);
  return row === undefined ? null : toVehicle(row);
}

/** Find or create a vehicle by VIN (or by name when the VIN is unknown). */
export function upsertVehicle(
  db: Database,
  input: { vin?: string | null; teslaId?: string | null; displayName: string; model?: string | null },
): Vehicle {
  const vin = input.vin ?? null;
  const existing =
    vin !== null
      ? db.get<Row>('SELECT * FROM vehicle WHERE vin = ?', vin)
      : db.get<Row>('SELECT * FROM vehicle WHERE display_name = ? AND vin IS NULL', input.displayName);

  if (existing !== undefined) {
    db.run(
      'UPDATE vehicle SET display_name = ?, model = COALESCE(?, model), tesla_id = COALESCE(?, tesla_id) WHERE id = ?',
      input.displayName,
      input.model ?? null,
      input.teslaId ?? null,
      Number(existing.id),
    );
    return getVehicle(db, Number(existing.id)) as Vehicle;
  }

  const { lastInsertRowid } = db.run(
    'INSERT INTO vehicle (vin, tesla_id, display_name, model, created_at) VALUES (?, ?, ?, ?, ?)',
    vin,
    input.teslaId ?? null,
    input.displayName,
    input.model ?? null,
    nowIso(),
  );
  return getVehicle(db, lastInsertRowid) as Vehicle;
}

export function updateVehicleStatus(
  db: Database,
  id: number,
  status: { odometerMiles?: number | null; sampleAt?: string | null; state?: string | null },
): void {
  db.run(
    `UPDATE vehicle SET
       last_odometer_miles = COALESCE(?, last_odometer_miles),
       last_sample_at      = COALESCE(?, last_sample_at),
       last_state          = COALESCE(?, last_state)
     WHERE id = ?`,
    status.odometerMiles ?? null,
    status.sampleAt ?? null,
    status.state ?? null,
    id,
  );
}

// -- samples ------------------------------------------------------------------

function toSample(row: Row): Sample {
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    at: String(row.at),
    odometerMiles: num(row.odometer_miles),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    shiftState: text(row.shift_state),
    speedMph: num(row.speed_mph),
    state: text(row.state),
    chargingState: text(row.charging_state),
    batteryLevel: num(row.battery_level),
    cached: flag(row.cached),
    source: String(row.source),
  };
}

/** Insert a reading. Duplicate timestamps are ignored, so retries are safe. */
export function insertSample(db: Database, sample: Sample): boolean {
  const { changes } = db.run(
    `INSERT OR IGNORE INTO sample
       (vehicle_id, at, odometer_miles, latitude, longitude, shift_state, speed_mph, state, charging_state, battery_level, cached, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sample.vehicleId,
    sample.at,
    sample.odometerMiles,
    sample.latitude,
    sample.longitude,
    sample.shiftState,
    sample.speedMph,
    sample.state,
    sample.chargingState,
    sample.batteryLevel,
    sample.cached,
    sample.source,
  );
  return changes > 0;
}

export function samplesSince(db: Database, vehicleId: number, from: string): Sample[] {
  return db
    .all<Row>('SELECT * FROM sample WHERE vehicle_id = ? AND at >= ? ORDER BY at', vehicleId, from)
    .map(toSample);
}

export function latestSample(db: Database, vehicleId: number): Sample | null {
  const row = db.get<Row>('SELECT * FROM sample WHERE vehicle_id = ? ORDER BY at DESC LIMIT 1', vehicleId);
  return row === undefined ? null : toSample(row);
}

export function sampleCount(db: Database, vehicleId: number): number {
  return Number(db.value<number>('SELECT COUNT(*) FROM sample WHERE vehicle_id = ?', vehicleId) ?? 0);
}

/** Drop readings older than the retention window; trips are kept forever. */
export function pruneSamples(db: Database, before: string): number {
  return db.run('DELETE FROM sample WHERE at < ?', before).changes;
}

// -- places -------------------------------------------------------------------

function toPlace(row: Row): Place {
  return {
    id: Number(row.id),
    name: String(row.name),
    kind: String(row.kind) as PlaceKind,
    label: String(row.label) as PlaceLabel,
    purpose: text(row.purpose),
    client: text(row.client),
    address: text(row.address),
    city: text(row.city),
    region: text(row.region),
    postal: text(row.postal),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    radiusMeters: Number(row.radius_meters),
    isHome: flag(row.is_home),
    isPrimaryOffice: flag(row.is_primary_office),
    notes: text(row.notes),
    visitCount: Number(row.visit_count),
  };
}

export function listPlaces(db: Database): Place[] {
  return db
    .all<Row>('SELECT * FROM place WHERE deleted_at IS NULL ORDER BY kind, name')
    .map(toPlace);
}

export function getPlace(db: Database, id: number): Place | null {
  const row = db.get<Row>('SELECT * FROM place WHERE id = ? AND deleted_at IS NULL', id);
  return row === undefined ? null : toPlace(row);
}

export type PlaceInput = Omit<Place, 'id' | 'visitCount'>;

export function createPlace(db: Database, input: PlaceInput): Place {
  const stamp = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO place
       (name, kind, label, purpose, client, address, city, region, postal, latitude, longitude,
        radius_meters, is_home, is_primary_office, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.kind,
    input.label,
    input.purpose,
    input.client,
    input.address,
    input.city,
    input.region,
    input.postal,
    input.latitude,
    input.longitude,
    input.radiusMeters,
    input.isHome,
    input.isPrimaryOffice,
    input.notes,
    stamp,
    stamp,
  );
  if (input.isHome) clearExclusive(db, 'is_home', lastInsertRowid);
  if (input.isPrimaryOffice) clearExclusive(db, 'is_primary_office', lastInsertRowid);
  return getPlace(db, lastInsertRowid) as Place;
}

/** Only one home and one primary office can exist; the newest wins. */
function clearExclusive(db: Database, column: 'is_home' | 'is_primary_office', keepId: number): void {
  db.run(`UPDATE place SET ${column} = 0 WHERE id <> ?`, keepId);
}

export function updatePlace(db: Database, id: number, input: PlaceInput): Place | null {
  db.run(
    `UPDATE place SET
       name = ?, kind = ?, label = ?, purpose = ?, client = ?, address = ?, city = ?, region = ?,
       postal = ?, latitude = ?, longitude = ?, radius_meters = ?, is_home = ?, is_primary_office = ?,
       notes = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    input.name,
    input.kind,
    input.label,
    input.purpose,
    input.client,
    input.address,
    input.city,
    input.region,
    input.postal,
    input.latitude,
    input.longitude,
    input.radiusMeters,
    input.isHome,
    input.isPrimaryOffice,
    input.notes,
    nowIso(),
    id,
  );
  if (input.isHome) clearExclusive(db, 'is_home', id);
  if (input.isPrimaryOffice) clearExclusive(db, 'is_primary_office', id);
  return getPlace(db, id);
}

export function deletePlace(db: Database, id: number): void {
  db.run('UPDATE place SET deleted_at = ? WHERE id = ?', nowIso(), id);
}

export function bumpVisits(db: Database, placeIds: number[]): void {
  for (const id of placeIds) {
    db.run('UPDATE place SET visit_count = visit_count + 1 WHERE id = ?', id);
  }
}

// -- rules --------------------------------------------------------------------

function toRule(row: Row): Rule {
  return {
    id: Number(row.id),
    name: String(row.name),
    priority: Number(row.priority),
    enabled: flag(row.enabled),
    source: String(row.source) as Rule['source'],
    conditions: parseConditions(String(row.conditions)),
    classification: String(row.classification) as Classification,
    purpose: text(row.purpose),
    client: text(row.client),
    hits: Number(row.hits ?? 0),
  };
}

export function listRules(db: Database, includeDisabled = true): Rule[] {
  const sql = includeDisabled
    ? 'SELECT * FROM rule WHERE deleted_at IS NULL ORDER BY priority, id'
    : 'SELECT * FROM rule WHERE deleted_at IS NULL AND enabled = 1 ORDER BY priority, id';
  return db.all<Row>(sql).map(toRule);
}

export function getRule(db: Database, id: number): Rule | null {
  const row = db.get<Row>('SELECT * FROM rule WHERE id = ? AND deleted_at IS NULL', id);
  return row === undefined ? null : toRule(row);
}

export type RuleInput = {
  name: string;
  priority: number;
  enabled: boolean;
  source: Rule['source'];
  conditions: RuleConditions;
  classification: Classification;
  purpose: string | null;
  client: string | null;
};

export function createRule(db: Database, input: RuleInput): Rule {
  const stamp = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO rule (name, priority, enabled, source, conditions, classification, purpose, client, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.priority,
    input.enabled,
    input.source,
    JSON.stringify(input.conditions),
    input.classification,
    input.purpose,
    input.client,
    stamp,
    stamp,
  );
  return getRule(db, lastInsertRowid) as Rule;
}

export function updateRule(db: Database, id: number, input: RuleInput): Rule | null {
  db.run(
    `UPDATE rule SET name = ?, priority = ?, enabled = ?, conditions = ?, classification = ?,
       purpose = ?, client = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    input.name,
    input.priority,
    input.enabled,
    JSON.stringify(input.conditions),
    input.classification,
    input.purpose,
    input.client,
    nowIso(),
    id,
  );
  return getRule(db, id);
}

export function deleteRule(db: Database, id: number): void {
  db.run('UPDATE rule SET deleted_at = ? WHERE id = ?', nowIso(), id);
}

export function bumpRuleHits(db: Database, ruleId: number): void {
  db.run('UPDATE rule SET hits = hits + 1 WHERE id = ?', ruleId);
}

// -- trips --------------------------------------------------------------------

export function toTrip(row: Row): Trip {
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    startLatitude: num(row.start_latitude),
    startLongitude: num(row.start_longitude),
    endLatitude: num(row.end_latitude),
    endLongitude: num(row.end_longitude),
    startOdometerMiles: num(row.start_odometer_miles),
    endOdometerMiles: num(row.end_odometer_miles),
    distanceMiles: Number(row.distance_miles),
    durationSeconds: Number(row.duration_seconds),
    startPlaceId: num(row.start_place_id),
    endPlaceId: num(row.end_place_id),
    startDescription: text(row.start_description),
    endDescription: text(row.end_description),
    classification: String(row.classification) as Classification,
    classificationSource: String(row.classification_source) as ClassificationSource,
    classificationReason: text(row.classification_reason),
    confidence: Number(row.confidence),
    purpose: text(row.purpose),
    client: text(row.client),
    notes: text(row.notes),
    locked: flag(row.locked),
    inferred: flag(row.inferred),
    open: flag(row.open),
    distanceSource: String(row.distance_source) as Trip['distanceSource'],
    needsReview: flag(row.needs_review),
    signature: text(row.signature),
  };
}

export type TripUpsert = Omit<Trip, 'id'>;

/** The longest a single drive could plausibly be, used to bound overlap lookups. */
const MAX_DRIVE_MS = 24 * 3600_000;

/**
 * Find a stored trip that covers the same drive as `trip`.
 *
 * Matching on the start time alone is not enough. As more readings arrive for a
 * drive — a backfilled import, or a poll that catches its first minutes — the
 * stitcher can legitimately place the same drive a few minutes earlier than it
 * did before. Keyed only on the start time that produces a second row for one
 * drive, and the miles get counted twice, which would overstate a deduction.
 *
 * So: exact start time first (the common case), then any trip whose time range
 * overlaps. Where several overlap, the one sharing the most time wins.
 */
function findSameDrive(db: Database, trip: TripUpsert): { id: number; locked: boolean } | null {
  const exact = db.get<Row>(
    'SELECT id, locked FROM trip WHERE vehicle_id = ? AND started_at = ? AND deleted_at IS NULL',
    trip.vehicleId,
    trip.startedAt,
  );
  if (exact !== undefined) return { id: Number(exact.id), locked: flag(exact.locked) };

  // Bound the search to a window around the new trip. Without the lower bound
  // this predicate has to consider every earlier trip in the ledger, which turns
  // a full rebuild into quadratic work — slow enough to be unusable after a
  // couple of years of driving. No single drive runs longer than a day.
  const windowStart = new Date(Date.parse(trip.startedAt) - MAX_DRIVE_MS).toISOString();
  const overlapping = db.all<Row>(
    `SELECT id, locked, started_at, ended_at FROM trip
      WHERE vehicle_id = ? AND deleted_at IS NULL
        AND started_at > ? AND started_at < ? AND ended_at > ?
      ORDER BY started_at`,
    trip.vehicleId,
    windowStart,
    trip.endedAt,
    trip.startedAt,
  );
  if (overlapping.length === 0) return null;

  const newStart = Date.parse(trip.startedAt);
  const newEnd = Date.parse(trip.endedAt);
  let best: { id: number; locked: boolean; shared: number } | null = null;
  for (const row of overlapping) {
    const shared =
      Math.min(newEnd, Date.parse(String(row.ended_at))) -
      Math.max(newStart, Date.parse(String(row.started_at)));
    if (best === null || shared > best.shared) {
      best = { id: Number(row.id), locked: flag(row.locked), shared };
    }
  }
  if (best === null) return null;

  // Anything else overlapping this drive is a leftover from a narrower view of
  // the same data. Retire the ones the owner has not decided on, so one drive
  // is one row and the miles are counted once.
  for (const row of overlapping) {
    const id = Number(row.id);
    if (id === best.id || flag(row.locked)) continue;
    db.run('UPDATE trip SET deleted_at = ? WHERE id = ?', nowIso(), id);
  }
  return { id: best.id, locked: best.locked };
}

/**
 * Insert or update a trip. Re-running the stitcher over the same window is
 * idempotent, and a trip the owner has decided on keeps their classification
 * while still having its distance corrected from the odometer.
 */
export function upsertTrip(db: Database, trip: TripUpsert): { id: number; created: boolean } {
  const existing = findSameDrive(db, trip);

  if (existing === null) {
    const stamp = nowIso();
    const { lastInsertRowid } = db.run(
      `INSERT INTO trip
         (vehicle_id, started_at, ended_at, start_latitude, start_longitude, end_latitude, end_longitude,
          start_odometer_miles, end_odometer_miles, distance_miles, duration_seconds,
          start_place_id, end_place_id, start_description, end_description,
          classification, classification_source, classification_reason, confidence,
          purpose, client, notes, locked, inferred, open, distance_source, needs_review, signature,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      trip.vehicleId,
      trip.startedAt,
      trip.endedAt,
      trip.startLatitude,
      trip.startLongitude,
      trip.endLatitude,
      trip.endLongitude,
      trip.startOdometerMiles,
      trip.endOdometerMiles,
      trip.distanceMiles,
      trip.durationSeconds,
      trip.startPlaceId,
      trip.endPlaceId,
      trip.startDescription,
      trip.endDescription,
      trip.classification,
      trip.classificationSource,
      trip.classificationReason,
      trip.confidence,
      trip.purpose,
      trip.client,
      trip.notes,
      trip.locked,
      trip.inferred,
      trip.open,
      trip.distanceSource,
      trip.needsReview,
      trip.signature,
      stamp,
      stamp,
    );
    return { id: lastInsertRowid, created: true };
  }

  const { id, locked } = existing;

  // Geometry and distance always refresh; the owner's decision never does. The
  // start moves too, because a drive can turn out to have begun earlier than
  // the readings first showed.
  db.run(
    `UPDATE trip SET
       started_at = ?, start_latitude = ?, start_longitude = ?, start_odometer_miles = ?,
       ended_at = ?, end_latitude = ?, end_longitude = ?, end_odometer_miles = ?,
       distance_miles = ?, duration_seconds = ?, inferred = ?, open = ?, distance_source = ?,
       start_place_id = ?, end_place_id = ?, start_description = ?, end_description = ?,
       signature = ?, deleted_at = NULL, updated_at = ?
     WHERE id = ?`,
    trip.startedAt,
    trip.startLatitude,
    trip.startLongitude,
    trip.startOdometerMiles,
    trip.endedAt,
    trip.endLatitude,
    trip.endLongitude,
    trip.endOdometerMiles,
    trip.distanceMiles,
    trip.durationSeconds,
    trip.inferred,
    trip.open,
    trip.distanceSource,
    trip.startPlaceId,
    trip.endPlaceId,
    trip.startDescription,
    trip.endDescription,
    trip.signature,
    nowIso(),
    id,
  );

  if (!locked) {
    db.run(
      `UPDATE trip SET classification = ?, classification_source = ?, classification_reason = ?,
         confidence = ?,
         purpose = CASE WHEN purpose_source = 'user' THEN purpose ELSE ? END,
         client  = CASE WHEN purpose_source = 'user' THEN client  ELSE ? END,
         needs_review = ?
       WHERE id = ?`,
      trip.classification,
      trip.classificationSource,
      trip.classificationReason,
      trip.confidence,
      trip.purpose,
      trip.client,
      trip.needsReview,
      id,
    );
  }

  return { id, created: false };
}

export function getTrip(db: Database, id: number): Trip | null {
  const row = db.get<Row>('SELECT * FROM trip WHERE id = ? AND deleted_at IS NULL', id);
  return row === undefined ? null : toTrip(row);
}

export type TripFilter = {
  from?: string;
  to?: string;
  classification?: Classification | 'all' | 'deductible';
  needsReview?: boolean;
  vehicleId?: number;
  placeId?: number;
  search?: string;
  limit?: number;
  offset?: number;
};

/**
 * The one place trip filters turn into SQL, shared by the row queries and the
 * aggregate ones so a filter cannot mean two different things depending on which
 * path a page happens to take.
 */
export function tripWhere(
  filter: TripFilter,
  prefix = 't.',
): { sql: string; params: (string | number | null)[] } {
  const t = prefix;
  const clauses = [`${t}deleted_at IS NULL`];
  const params: (string | number | null)[] = [];

  if (filter.from !== undefined) {
    clauses.push(`${t}started_at >= ?`);
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push(`${t}started_at < ?`);
    params.push(filter.to);
  }
  if (filter.classification !== undefined && filter.classification !== 'all') {
    if (filter.classification === 'deductible') {
      clauses.push(`${t}classification IN ('business','medical','charity')`);
    } else {
      clauses.push(`${t}classification = ?`);
      params.push(filter.classification);
    }
  }
  if (filter.needsReview === true) clauses.push(`${t}needs_review = 1`);
  if (filter.vehicleId !== undefined) {
    clauses.push(`${t}vehicle_id = ?`);
    params.push(filter.vehicleId);
  }
  if (filter.placeId !== undefined) {
    clauses.push(`(${t}start_place_id = ? OR ${t}end_place_id = ?)`);
    params.push(filter.placeId, filter.placeId);
  }
  if (filter.search !== undefined && filter.search.trim() !== '') {
    const like = `%${filter.search.trim().toLowerCase()}%`;
    clauses.push(
      `(LOWER(COALESCE(${t}start_description,'')) LIKE ? OR LOWER(COALESCE(${t}end_description,'')) LIKE ?
        OR LOWER(COALESCE(${t}purpose,'')) LIKE ? OR LOWER(COALESCE(${t}client,'')) LIKE ?
        OR LOWER(COALESCE(${t}notes,'')) LIKE ?)`,
    );
    params.push(like, like, like, like, like);
  }

  return { sql: clauses.join(' AND '), params };
}

const whereFor = tripWhere;

export function listTrips(db: Database, filter: TripFilter = {}): Trip[] {
  const { sql, params } = whereFor(filter);
  const limit = filter.limit ?? 500;
  const offset = filter.offset ?? 0;
  return db
    .all<Row>(
      `SELECT t.* FROM trip t WHERE ${sql} ORDER BY t.started_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    )
    .map(toTrip);
}

export function countTrips(db: Database, filter: TripFilter = {}): number {
  const { sql, params } = whereFor(filter);
  return Number(db.value<number>(`SELECT COUNT(*) FROM trip t WHERE ${sql}`, ...params) ?? 0);
}

export function tripsForExport(db: Database, filter: TripFilter): Trip[] {
  const { sql, params } = whereFor(filter);
  return db
    .all<Row>(`SELECT t.* FROM trip t WHERE ${sql} ORDER BY t.started_at ASC`, ...params)
    .map(toTrip);
}

/** Apply the owner's decision. This is what makes a trip authoritative. */
export function setTripDecision(
  db: Database,
  id: number,
  decision: {
    classification: Classification;
    purpose?: string | null;
    client?: string | null;
    notes?: string | null;
    reason?: string;
  },
): Trip | null {
  db.run(
    `UPDATE trip SET
       classification = ?, classification_source = 'user',
       classification_reason = ?, confidence = 1, locked = 1, needs_review = 0,
       purpose = COALESCE(?, purpose), client = COALESCE(?, client), notes = COALESCE(?, notes),
       purpose_source = CASE WHEN ? IS NULL AND ? IS NULL THEN purpose_source ELSE 'user' END,
       updated_at = ?
     WHERE id = ?`,
    decision.classification,
    decision.reason ?? 'Classified by you',
    decision.purpose ?? null,
    decision.client ?? null,
    decision.notes ?? null,
    decision.purpose ?? null,
    decision.client ?? null,
    nowIso(),
    id,
  );
  return getTrip(db, id);
}

/** Release a trip back to automatic handling. */
export function unlockTrip(db: Database, id: number): void {
  db.run('UPDATE trip SET locked = 0, needs_review = 1, updated_at = ? WHERE id = ?', nowIso(), id);
}

export function setTripFields(
  db: Database,
  id: number,
  fields: { purpose?: string | null; client?: string | null; notes?: string | null },
): void {
  db.run(
    `UPDATE trip SET purpose = ?, client = ?, notes = ?, purpose_source = 'user', updated_at = ?
     WHERE id = ?`,
    fields.purpose ?? null,
    fields.client ?? null,
    fields.notes ?? null,
    nowIso(),
    id,
  );
}

export function applyClassification(
  db: Database,
  id: number,
  outcome: {
    classification: Classification;
    source: ClassificationSource;
    reason: string;
    confidence: number;
    purpose: string | null;
    client: string | null;
    needsReview: boolean;
  },
): void {
  db.run(
    `UPDATE trip SET classification = ?, classification_source = ?, classification_reason = ?,
       confidence = ?,
       purpose = CASE WHEN purpose_source = 'user' THEN purpose ELSE ? END,
       client  = CASE WHEN purpose_source = 'user' THEN client  ELSE ? END,
       needs_review = ?, updated_at = ?
     WHERE id = ? AND locked = 0`,
    outcome.classification,
    outcome.source,
    outcome.reason,
    outcome.confidence,
    outcome.purpose,
    outcome.client,
    outcome.needsReview,
    nowIso(),
    id,
  );
}

export function setTripPlaces(
  db: Database,
  id: number,
  patch: {
    startPlaceId: number | null;
    endPlaceId: number | null;
    startDescription: string | null;
    endDescription: string | null;
    signature: string | null;
  },
): void {
  db.run(
    `UPDATE trip SET start_place_id = ?, end_place_id = ?, start_description = ?, end_description = ?,
       signature = ?, updated_at = ? WHERE id = ?`,
    patch.startPlaceId,
    patch.endPlaceId,
    patch.startDescription,
    patch.endDescription,
    patch.signature,
    nowIso(),
    id,
  );
}

/**
 * Retire trips in a window that the stitcher no longer produces — an artifact of
 * an earlier, less complete view of the data. Anything the owner classified is
 * kept, because their record is the one that matters.
 *
 * `from` must be the timestamp of the oldest reading the stitcher actually had.
 * Readings are pruned after a while but trips are kept forever, so a trip older
 * than the surviving readings simply cannot be re-derived — and must not be
 * mistaken for a stale artifact and deleted. Getting this wrong silently erases
 * mileage, so the floor is the caller's responsibility to supply correctly.
 */
export function retireStaleTrips(
  db: Database,
  vehicleId: number,
  from: string,
  keepStartedAt: string[],
): number {
  const rows = db.all<Row>(
    'SELECT id, started_at FROM trip WHERE vehicle_id = ? AND started_at >= ? AND deleted_at IS NULL AND locked = 0',
    vehicleId,
    from,
  );
  const keep = new Set(keepStartedAt);
  let retired = 0;
  for (const row of rows) {
    if (keep.has(String(row.started_at))) continue;
    db.run('UPDATE trip SET deleted_at = ? WHERE id = ?', nowIso(), Number(row.id));
    retired += 1;
  }
  return retired;
}

export function unclassifiedTrips(db: Database, limit = 200): Trip[] {
  return db
    .all<Row>(
      `SELECT * FROM trip WHERE deleted_at IS NULL AND locked = 0 AND needs_review = 1
       ORDER BY started_at DESC LIMIT ?`,
      limit,
    )
    .map(toTrip);
}

/** Every non-deleted trip, oldest first — used when rules or labels change. */
export function allTripsForReclassify(db: Database): Trip[] {
  return db
    .all<Row>('SELECT * FROM trip WHERE deleted_at IS NULL ORDER BY started_at')
    .map(toTrip);
}

// -- feedback and suggestions -------------------------------------------------

export function addFeedback(
  db: Database,
  input: { tripId: number; signature: string; classification: Classification; purpose: string | null; client: string | null },
): void {
  db.run(
    'INSERT INTO feedback (trip_id, signature, classification, purpose, client, at) VALUES (?, ?, ?, ?, ?, ?)',
    input.tripId,
    input.signature,
    input.classification,
    input.purpose,
    input.client,
    nowIso(),
  );
}

export type FeedbackRecord = {
  signature: string;
  classification: Classification;
  purpose: string | null;
  client: string | null;
  at: string;
};

export function listFeedback(db: Database): FeedbackRecord[] {
  return db.all<Row>('SELECT signature, classification, purpose, client, at FROM feedback').map((row) => ({
    signature: String(row.signature),
    classification: String(row.classification) as Classification,
    purpose: text(row.purpose),
    client: text(row.client),
    at: String(row.at),
  }));
}

export type SuggestionRecord = {
  id: number;
  signature: string;
  classification: Classification;
  purpose: string | null;
  client: string | null;
  observations: number;
  description: string;
  status: 'open' | 'accepted' | 'dismissed';
};

function toSuggestion(row: Row): SuggestionRecord {
  return {
    id: Number(row.id),
    signature: String(row.signature),
    classification: String(row.classification) as Classification,
    purpose: text(row.purpose),
    client: text(row.client),
    observations: Number(row.observations),
    description: String(row.description),
    status: String(row.status) as SuggestionRecord['status'],
  };
}

/** Record a proposal, leaving an already-dismissed one dismissed. */
export function upsertSuggestion(
  db: Database,
  input: {
    signature: string;
    classification: Classification;
    purpose: string | null;
    client: string | null;
    observations: number;
    description: string;
  },
): void {
  const stamp = nowIso();
  db.run(
    `INSERT INTO suggestion (signature, classification, purpose, client, observations, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(signature) DO UPDATE SET
       classification = excluded.classification,
       purpose        = excluded.purpose,
       client         = excluded.client,
       observations   = excluded.observations,
       description    = excluded.description,
       updated_at     = excluded.updated_at
     WHERE suggestion.status = 'open'`,
    input.signature,
    input.classification,
    input.purpose,
    input.client,
    input.observations,
    input.description,
    stamp,
    stamp,
  );
}

export function listSuggestions(db: Database, status: 'open' | 'all' = 'open'): SuggestionRecord[] {
  const sql =
    status === 'open'
      ? "SELECT * FROM suggestion WHERE status = 'open' ORDER BY observations DESC, id"
      : 'SELECT * FROM suggestion ORDER BY status, observations DESC';
  return db.all<Row>(sql).map(toSuggestion);
}

export function getSuggestion(db: Database, id: number): SuggestionRecord | null {
  const row = db.get<Row>('SELECT * FROM suggestion WHERE id = ?', id);
  return row === undefined ? null : toSuggestion(row);
}

export function setSuggestionStatus(
  db: Database,
  id: number,
  status: SuggestionRecord['status'],
): void {
  db.run('UPDATE suggestion SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
}

// -- API usage ----------------------------------------------------------------

export function recordUsage(
  db: Database,
  input: { endpoint: string; credits: number; cached: boolean; ok: boolean; detail?: string | null },
  timezone: string,
): void {
  const at = nowIso();
  db.run(
    'INSERT INTO api_usage (at, month, endpoint, credits, cached, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    at,
    localMonth(at, timezone),
    input.endpoint,
    input.credits,
    input.cached,
    input.ok,
    input.detail ?? null,
  );
}

export function creditsUsed(db: Database, month: string): number {
  return Number(db.value<number>('SELECT COALESCE(SUM(credits), 0) FROM api_usage WHERE month = ?', month) ?? 0);
}

export function usageSummary(
  db: Database,
  month: string,
): { calls: number; credits: number; cachedCalls: number; failures: number } {
  const row = db.get<Row>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(credits),0) AS credits,
            COALESCE(SUM(cached),0) AS cached_calls, COALESCE(SUM(1 - ok),0) AS failures
     FROM api_usage WHERE month = ?`,
    month,
  );
  return {
    calls: Number(row?.calls ?? 0),
    credits: Number(row?.credits ?? 0),
    cachedCalls: Number(row?.cached_calls ?? 0),
    failures: Number(row?.failures ?? 0),
  };
}

// -- tokens -------------------------------------------------------------------

export type StoredToken = {
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  region: string | null;
  scope: string | null;
};

export function getToken(db: Database, provider: string): StoredToken | null {
  const row = db.get<Row>('SELECT * FROM token WHERE provider = ?', provider);
  if (row === undefined) return null;
  const storedRefresh = text(row.refresh_token);
  const refreshToken = storedRefresh === null ? null : openSecret(storedRefresh, config.secret);
  if (storedRefresh !== null && refreshToken === null) {
    log.error(
      'the stored Tesla refresh token cannot be decrypted — MILE_LEDGER_SECRET has changed or is missing. Reconnect the car to store a new token.',
    );
  }
  return {
    provider: String(row.provider),
    accessToken: text(row.access_token),
    refreshToken,
    expiresAt: text(row.expires_at),
    region: text(row.region),
    scope: text(row.scope),
  };
}

export function saveToken(db: Database, token: StoredToken): void {
  db.run(
    `INSERT INTO token (provider, access_token, refresh_token, expires_at, region, scope, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, token.refresh_token),
       expires_at = excluded.expires_at,
       region = COALESCE(excluded.region, token.region),
       scope = COALESCE(excluded.scope, token.scope),
       updated_at = excluded.updated_at`,
    token.provider,
    token.accessToken,
    token.refreshToken === null ? null : seal(token.refreshToken, config.secret),
    token.expiresAt,
    token.region,
    token.scope,
    nowIso(),
  );
}

export function clearToken(db: Database, provider: string): void {
  db.run('DELETE FROM token WHERE provider = ?', provider);
}

// -- geocode cache ------------------------------------------------------------

export function getGeocode(db: Database, key: string): GeoInfo | null {
  const row = db.get<Row>('SELECT * FROM geocode_cache WHERE key = ?', key);
  if (row === undefined) return null;
  return {
    display: text(row.display),
    houseNumber: text(row.house_number),
    road: text(row.road),
    city: text(row.city),
    region: text(row.region),
    postal: text(row.postal),
  };
}

export function putGeocode(db: Database, key: string, info: GeoInfo & { country?: string | null }): void {
  db.run(
    `INSERT INTO geocode_cache (key, display, house_number, road, city, region, postal, country, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       display = excluded.display, house_number = excluded.house_number, road = excluded.road,
       city = excluded.city, region = excluded.region, postal = excluded.postal,
       country = excluded.country, fetched_at = excluded.fetched_at`,
    key,
    info.display ?? null,
    info.houseNumber ?? null,
    info.road ?? null,
    info.city ?? null,
    info.region ?? null,
    info.postal ?? null,
    info.country ?? null,
    nowIso(),
  );
}

// -- mileage rates ------------------------------------------------------------

export function seedRates(db: Database): void {
  for (const rate of IRS_RATES) {
    db.run(
      `INSERT OR IGNORE INTO mileage_rate (effective_from, effective_to, business_cents, medical_cents, charity_cents, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      rate.from,
      rate.to,
      rate.business,
      rate.medical,
      rate.charity,
      rate.note,
    );
  }
}

export function ratePeriods(db: Database): RatePeriod[] {
  const rows = db.all<Row>('SELECT * FROM mileage_rate ORDER BY effective_from');
  if (rows.length === 0) return IRS_RATES;
  return rows.map((row) => ({
    from: String(row.effective_from),
    to: String(row.effective_to),
    business: Number(row.business_cents),
    medical: Number(row.medical_cents),
    charity: Number(row.charity_cents),
    note: text(row.note) ?? '',
  }));
}

export function upsertRate(db: Database, rate: RatePeriod): void {
  db.run(
    `INSERT INTO mileage_rate (effective_from, effective_to, business_cents, medical_cents, charity_cents, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(effective_from) DO UPDATE SET
       effective_to = excluded.effective_to, business_cents = excluded.business_cents,
       medical_cents = excluded.medical_cents, charity_cents = excluded.charity_cents, note = excluded.note`,
    rate.from,
    rate.to,
    rate.business,
    rate.medical,
    rate.charity,
    rate.note,
  );
}

// -- share links --------------------------------------------------------------

export type ShareLink = { token: string; name: string; createdAt: string; lastUsedAt: string | null };

export function createShareLink(db: Database, token: string, name: string): ShareLink {
  db.run('INSERT INTO share_link (token, name, created_at) VALUES (?, ?, ?)', token, name, nowIso());
  return { token, name, createdAt: nowIso(), lastUsedAt: null };
}

export function listShareLinks(db: Database): ShareLink[] {
  return db
    .all<Row>('SELECT * FROM share_link WHERE revoked_at IS NULL ORDER BY created_at DESC')
    .map((row) => ({
      token: String(row.token),
      name: String(row.name),
      createdAt: String(row.created_at),
      lastUsedAt: text(row.last_used_at),
    }));
}

export function findShareLink(db: Database, token: string): ShareLink | null {
  const row = db.get<Row>('SELECT * FROM share_link WHERE token = ? AND revoked_at IS NULL', token);
  if (row === undefined) return null;
  db.run('UPDATE share_link SET last_used_at = ? WHERE token = ?', nowIso(), token);
  return {
    token: String(row.token),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastUsedAt: text(row.last_used_at),
  };
}

export function revokeShareLink(db: Database, token: string): void {
  db.run('UPDATE share_link SET revoked_at = ? WHERE token = ?', nowIso(), token);
}
