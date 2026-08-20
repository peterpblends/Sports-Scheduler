/** Geographic helpers. Distances in meters unless a name says otherwise. */

export type Point = { latitude: number; longitude: number };

const EARTH_RADIUS_M = 6_371_008.8;
export const METERS_PER_MILE = 1609.344;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters. */
export function haversineMeters(a: Point, b: Point): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

export function milesToMeters(miles: number): number {
  return miles * METERS_PER_MILE;
}

export function isPoint(value: {
  latitude?: number | null;
  longitude?: number | null;
}): value is Point {
  return (
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    !(value.latitude === 0 && value.longitude === 0)
  );
}

/**
 * Stable key for a coordinate, used for the geocode cache and for trip
 * signatures. 4 decimals is roughly an 11 m cell — tight enough that two
 * parkings at the same address collapse to one key, loose enough that GPS
 * scatter does not split them.
 */
export function coordKey(point: Point, decimals = 4): string {
  return `${point.latitude.toFixed(decimals)},${point.longitude.toFixed(decimals)}`;
}

export function formatCoords(point: Point): string {
  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}

/** Link out to a free map for a coordinate — no API key, no cost. */
export function mapUrl(point: Point): string {
  return `https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=17/${point.latitude}/${point.longitude}`;
}
