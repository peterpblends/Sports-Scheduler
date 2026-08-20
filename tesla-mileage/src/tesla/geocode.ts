/**
 * Turning coordinates into street addresses.
 *
 * Uses OpenStreetMap's Nominatim service, which is free and needs no API key.
 * In exchange it asks callers to be polite, so this module:
 *   - caches every lookup permanently (a street corner never moves),
 *   - never sends more than one request at a time, spaced out,
 *   - identifies itself in the User-Agent,
 *   - and can be switched off entirely, in which case the app falls back to
 *     coordinates and whatever names the owner has given their places.
 *
 * Location data never leaves the machine except as these coordinate lookups.
 */
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import type { GeoInfo } from '../domain/places.ts';
import { coordKey, type Point } from '../lib/geo.ts';
import { log } from '../lib/log.ts';

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
/** Nominatim's usage policy allows one request per second; leave headroom. */
const MIN_SPACING_MS = 1500;

let lastRequestAt = 0;

function userAgent(contact: string): string {
  const suffix = contact.trim() === '' ? '' : `; ${contact.trim()}`;
  return `MileLedger/1.0 (self-hosted personal mileage log${suffix})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Nominatim names the same field differently by locality size. */
function cityOf(address: Record<string, unknown>): string | null {
  return (
    str(address, 'city') ??
    str(address, 'town') ??
    str(address, 'village') ??
    str(address, 'hamlet') ??
    str(address, 'municipality') ??
    str(address, 'suburb')
  );
}

export type GeocodeResult = GeoInfo & { country: string | null };

export async function reverseGeocode(
  point: Point,
  contact: string,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  const wait = Math.max(0, lastRequestAt + MIN_SPACING_MS - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const url = `${ENDPOINT}?format=jsonv2&addressdetails=1&zoom=18&lat=${point.latitude}&lon=${point.longitude}`;
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent(contact), 'accept-language': 'en' },
    signal,
  });
  if (!response.ok) {
    log.warn(`reverse geocode failed with status ${response.status}`);
    return null;
  }

  const json: unknown = await response.json();
  if (!isRecord(json)) return null;
  const address = isRecord(json.address) ? json.address : {};

  return {
    display: str(json, 'display_name'),
    houseNumber: str(address, 'house_number'),
    road: str(address, 'road') ?? str(address, 'pedestrian') ?? str(address, 'footway'),
    city: cityOf(address),
    region: str(address, 'state') ?? str(address, 'province'),
    postal: str(address, 'postcode'),
    country: str(address, 'country_code'),
  };
}

/** Trip endpoints that have no cached address yet, newest trips first. */
export function pendingLookups(db: Database, limit: number): Point[] {
  const rows = db.all<{ latitude: number | null; longitude: number | null }>(
    `SELECT start_latitude AS latitude, start_longitude AS longitude FROM trip
       WHERE deleted_at IS NULL AND start_latitude IS NOT NULL
     UNION
     SELECT end_latitude AS latitude, end_longitude AS longitude FROM trip
       WHERE deleted_at IS NULL AND end_latitude IS NOT NULL`,
  );

  const seen = new Set<string>();
  const pending: Point[] = [];
  for (const row of rows) {
    if (row.latitude === null || row.longitude === null) continue;
    const point = { latitude: row.latitude, longitude: row.longitude };
    const key = coordKey(point, 4);
    if (seen.has(key)) continue;
    seen.add(key);
    if (repo.getGeocode(db, key) !== null) continue;
    pending.push(point);
    if (pending.length >= limit) break;
  }
  return pending;
}

/**
 * Fill in a few missing addresses. Returns how many were resolved, so the
 * caller can re-resolve trip descriptions only when something changed.
 */
export async function enrichAddresses(
  db: Database,
  options: { contact: string; limit: number; signal?: AbortSignal },
): Promise<number> {
  const pending = pendingLookups(db, options.limit);
  const aborted = (): boolean => options.signal?.aborted ?? false;
  let resolved = 0;
  for (const point of pending) {
    if (aborted()) break;
    try {
      const result = await reverseGeocode(point, options.contact, options.signal);
      if (result === null) continue;
      repo.putGeocode(db, coordKey(point, 4), result);
      resolved += 1;
    } catch (error) {
      if (aborted()) break;
      log.warn('reverse geocode error', error);
      break; // Back off rather than hammering a service that is unhappy.
    }
  }
  return resolved;
}
