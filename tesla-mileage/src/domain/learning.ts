/**
 * Learning from corrections.
 *
 * Every time the owner classifies a trip by hand, that decision is recorded
 * against a route "signature". Once the same route has been decided the same way
 * enough times, the app proposes automating it — as a visible, editable rule,
 * never as a silent guess. The same evidence also proposes labeling an address
 * that keeps getting the same treatment, which is usually the better fix
 * because it generalizes to every route touching that address.
 */
import type { Classification } from './types.ts';
import type { PlaceMatch } from './places.ts';
import { coordKey, type Point } from '../lib/geo.ts';

/** Stable key for one end of a trip: a labeled place, or a rounded coordinate. */
export function endpointKey(match: PlaceMatch | null, point: Point | null): string {
  if (match !== null && match.via === 'geofence') return `p${match.place.id}`;
  if (point !== null) return `c${coordKey(point, 3)}`;
  return 'unknown';
}

/** Route signature: where it started, where it ended. Direction matters. */
export function tripSignature(
  startMatch: PlaceMatch | null,
  startPoint: Point | null,
  endMatch: PlaceMatch | null,
  endPoint: Point | null,
): string | null {
  const from = endpointKey(startMatch, startPoint);
  const to = endpointKey(endMatch, endPoint);
  if (from === 'unknown' && to === 'unknown') return null;
  return `${from}>${to}`;
}

export function signatureEnds(signature: string): { from: string; to: string } {
  const [from = 'unknown', to = 'unknown'] = signature.split('>');
  return { from, to };
}

export function isCoordKey(key: string): boolean {
  return key.startsWith('c');
}

export function coordFromKey(key: string): Point | null {
  if (!isCoordKey(key)) return null;
  const [lat, lon] = key.slice(1).split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { latitude: lat as number, longitude: lon as number };
}

export type FeedbackRow = {
  signature: string;
  classification: Classification;
  purpose: string | null;
  client: string | null;
  at: string;
};

export type LearnOptions = {
  /** How many consistent corrections before the app proposes anything. */
  minObservations: number;
  /** Share of corrections that must agree, 0-1. */
  agreement: number;
};

export const DEFAULT_LEARN_OPTIONS: LearnOptions = {
  minObservations: 2,
  agreement: 0.8,
};

export type Suggestion = {
  /** Unique key: `route:<signature>` or `place:<coordinate>`. */
  key: string;
  kind: 'route' | 'place';
  classification: Classification;
  purpose: string | null;
  client: string | null;
  observations: number;
  description: string;
  /** Set for place suggestions, so the UI can offer to create the place. */
  coordinate: Point | null;
};

type Tally = {
  counts: Map<Classification, number>;
  purposes: Map<string, number>;
  clients: Map<string, number>;
  total: number;
};

function emptyTally(): Tally {
  return { counts: new Map(), purposes: new Map(), clients: new Map(), total: 0 };
}

function bump<K>(map: Map<K, number>, key: K | null): void {
  if (key === null) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function dominant<K>(map: Map<K, number>): { key: K; count: number } | null {
  let best: { key: K; count: number } | null = null;
  for (const [key, count] of map) {
    if (best === null || count > best.count) best = { key, count };
  }
  return best;
}

function record(tally: Tally, row: FeedbackRow): void {
  bump(tally.counts, row.classification);
  bump(tally.purposes, row.purpose !== null && row.purpose.trim() !== '' ? row.purpose.trim() : null);
  bump(tally.clients, row.client !== null && row.client.trim() !== '' ? row.client.trim() : null);
  tally.total += 1;
}

/**
 * Turn recorded corrections into proposals.
 *
 * `describe` renders an endpoint key as something a person recognizes; without
 * it, the raw key is used.
 */
export function buildSuggestions(
  rows: FeedbackRow[],
  options: Partial<LearnOptions> = {},
  describe: (key: string) => string = (key) => key,
): Suggestion[] {
  const settings = { ...DEFAULT_LEARN_OPTIONS, ...options };
  const routes = new Map<string, Tally>();
  const destinations = new Map<string, Tally>();

  for (const row of rows) {
    if (row.classification === 'unclassified') continue;
    const route = routes.get(row.signature) ?? emptyTally();
    record(route, row);
    routes.set(row.signature, route);

    const { to } = signatureEnds(row.signature);
    if (isCoordKey(to)) {
      const destination = destinations.get(to) ?? emptyTally();
      record(destination, row);
      destinations.set(to, destination);
    }
  }

  const suggestions: Suggestion[] = [];

  const consider = (
    tally: Tally,
    make: (classification: Classification, tally: Tally) => Suggestion,
  ): void => {
    if (tally.total < settings.minObservations) return;
    const top = dominant(tally.counts);
    if (top === null) return;
    if (top.count / tally.total < settings.agreement) return;
    suggestions.push(make(top.key, tally));
  };

  for (const [signature, tally] of routes) {
    consider(tally, (classification) => {
      const { from, to } = signatureEnds(signature);
      return {
        key: `route:${signature}`,
        kind: 'route',
        classification,
        purpose: dominant(tally.purposes)?.key ?? null,
        client: dominant(tally.clients)?.key ?? null,
        observations: tally.total,
        description: `${describe(from)} → ${describe(to)} has been ${classification} ${tally.total} times`,
        coordinate: null,
      };
    });
  }

  for (const [key, tally] of destinations) {
    consider(tally, (classification) => ({
      key: `place:${key}`,
      kind: 'place',
      classification,
      purpose: dominant(tally.purposes)?.key ?? null,
      client: dominant(tally.clients)?.key ?? null,
      observations: tally.total,
      description: `Trips ending at ${describe(key)} have been ${classification} ${tally.total} times — label that address so every route there is handled`,
      coordinate: coordFromKey(key),
    }));
  }

  // Labeling an address beats memorizing a route, so offer those first, then
  // the most-observed patterns.
  return suggestions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'place' ? -1 : 1;
    return b.observations - a.observations;
  });
}

/** Conditions for the rule created when a route suggestion is accepted. */
export function ruleConditionsForSuggestion(suggestion: Suggestion): { signature: string } | null {
  if (suggestion.kind !== 'route') return null;
  return { signature: suggestion.key.slice('route:'.length) };
}
