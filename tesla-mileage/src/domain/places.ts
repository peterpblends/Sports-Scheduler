/**
 * Matching a coordinate to a place the owner has labeled.
 *
 * Three kinds of label, checked most-specific first:
 *   address — a geofence around a point ("Acme Warehouse, 200 m")
 *   city    — everything inside a city ("all of Fargo is business")
 *   region  — a state or wider area, as a catch-all
 *
 * An address label always wins over a city label, so "my house in Fargo" stays
 * personal even when the whole city is labeled business.
 */
import type { Place, PlaceLabel } from './types.ts';
import { haversineMeters, isPoint, type Point } from '../lib/geo.ts';

/** What a reverse geocode told us about a coordinate, if anything. */
export type GeoInfo = {
  display?: string | null;
  houseNumber?: string | null;
  road?: string | null;
  city?: string | null;
  region?: string | null;
  postal?: string | null;
};

export type PlaceMatch = {
  place: Place;
  distanceMeters: number | null;
  via: 'geofence' | 'city' | 'region';
};

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = norm(a);
  const right = norm(b);
  return left !== '' && left === right;
}

/** Default geofence for a newly labeled address, in meters. */
export const DEFAULT_RADIUS_METERS = 200;
/** Default radius used when a city label has no boundary, only a center point. */
export const DEFAULT_CITY_RADIUS_METERS = 12_000;

/**
 * Find the label that applies to a coordinate.
 *
 * `geo` is optional: without it, city and region labels can still match by
 * distance from their center point, so the app works with no network access.
 */
export function matchPlace(
  point: Point | null,
  geo: GeoInfo | null,
  places: Place[],
): PlaceMatch | null {
  const addresses: PlaceMatch[] = [];
  const cities: PlaceMatch[] = [];
  const regions: PlaceMatch[] = [];

  for (const place of places) {
    const center = isPoint({ latitude: place.latitude, longitude: place.longitude })
      ? { latitude: place.latitude as number, longitude: place.longitude as number }
      : null;
    const distance = point !== null && center !== null ? haversineMeters(point, center) : null;

    if (place.kind === 'address') {
      if (distance !== null && distance <= place.radiusMeters) {
        addresses.push({ place, distanceMeters: distance, via: 'geofence' });
      }
      continue;
    }

    if (place.kind === 'city') {
      if (geo !== null && sameText(geo.city, place.city)) {
        // A named-city match is authoritative; rank it ahead of radius matches.
        cities.push({ place, distanceMeters: distance, via: 'city' });
      } else if (distance !== null && distance <= place.radiusMeters) {
        cities.push({ place, distanceMeters: distance, via: 'city' });
      }
      continue;
    }

    if (geo !== null && sameText(geo.region, place.region)) {
      regions.push({ place, distanceMeters: distance, via: 'region' });
    } else if (distance !== null && distance <= place.radiusMeters) {
      regions.push({ place, distanceMeters: distance, via: 'region' });
    }
  }

  const nearest = (list: PlaceMatch[]): PlaceMatch | null => {
    if (list.length === 0) return null;
    return list.reduce((best, candidate) => {
      const a = best.distanceMeters ?? Number.POSITIVE_INFINITY;
      const b = candidate.distanceMeters ?? Number.POSITIVE_INFINITY;
      return b < a ? candidate : best;
    });
  };

  return nearest(addresses) ?? nearest(cities) ?? nearest(regions);
}

/** Human-readable endpoint description for the trip list and the CPA export. */
export function describeEndpoint(
  match: PlaceMatch | null,
  geo: GeoInfo | null,
  point: Point | null,
): string {
  if (match !== null && match.via === 'geofence') return match.place.name;
  const street = [geo?.houseNumber, geo?.road].filter((part) => (part ?? '') !== '').join(' ');
  const town = [geo?.city, geo?.region].filter((part) => (part ?? '') !== '').join(', ');
  const fromGeo = [street, town].filter((part) => part !== '').join(', ');
  if (fromGeo !== '') return fromGeo;
  if (match !== null) return match.place.name;
  if (point !== null) return `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;
  return 'Unknown location';
}

export function labelOf(match: PlaceMatch | null): PlaceLabel | null {
  return match === null ? null : match.place.label;
}
