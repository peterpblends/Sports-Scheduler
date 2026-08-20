import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSuggestions,
  endpointKey,
  tripSignature,
  coordFromKey,
  ruleConditionsForSuggestion,
  type FeedbackRow,
} from '../src/domain/learning.ts';
import type { Place } from '../src/domain/types.ts';

function geofence(id: number, name: string) {
  const place = { id, name } as unknown as Place;
  return { place, distanceMeters: 10, via: 'geofence' as const };
}

function feedback(signature: string, classification: FeedbackRow['classification'], extra: Partial<FeedbackRow> = {}): FeedbackRow {
  return { signature, classification, purpose: null, client: null, at: '2026-08-17T12:00:00Z', ...extra };
}

test('a labeled place makes a stable endpoint key; an unlabeled one uses its coordinate', () => {
  assert.equal(endpointKey(geofence(7, 'Warehouse'), { latitude: 46.9, longitude: -96.9 }), 'p7');
  assert.equal(endpointKey(null, { latitude: 46.87721, longitude: -96.78984 }), 'c46.877,-96.790');
  assert.equal(endpointKey(null, null), 'unknown');
});

test('signatures are directional', () => {
  const a = geofence(1, 'Home');
  const b = geofence(2, 'Client');
  assert.equal(tripSignature(a, null, b, null), 'p1>p2');
  assert.notEqual(tripSignature(a, null, b, null), tripSignature(b, null, a, null));
});

test('a trip with no known endpoints has no signature', () => {
  assert.equal(tripSignature(null, null, null, null), null);
});

test('nothing is suggested from a single correction', () => {
  const suggestions = buildSuggestions([feedback('p1>p2', 'business')]);
  assert.equal(suggestions.length, 0);
});

test('two consistent corrections propose automating the route', () => {
  const suggestions = buildSuggestions([
    feedback('p1>p2', 'business', { client: 'Acme', purpose: 'Delivery' }),
    feedback('p1>p2', 'business', { client: 'Acme', purpose: 'Delivery' }),
  ]);
  const route = suggestions.find((s) => s.kind === 'route');
  assert.ok(route);
  assert.equal(route.classification, 'business');
  assert.equal(route.observations, 2);
  assert.equal(route.client, 'Acme');
  assert.deepEqual(ruleConditionsForSuggestion(route), { signature: 'p1>p2' });
});

test('contradictory corrections are not automated', () => {
  const suggestions = buildSuggestions([
    feedback('p1>p2', 'business'),
    feedback('p1>p2', 'personal'),
  ]);
  assert.equal(suggestions.length, 0);
});

test('an occasional exception does not block a strong pattern', () => {
  const rows = [
    feedback('p1>p2', 'business'),
    feedback('p1>p2', 'business'),
    feedback('p1>p2', 'business'),
    feedback('p1>p2', 'business'),
    feedback('p1>p2', 'personal'),
  ];
  const route = buildSuggestions(rows).find((s) => s.kind === 'route');
  assert.ok(route);
  assert.equal(route.classification, 'business');
  assert.equal(route.observations, 5);
});

test('repeat trips to an unlabeled address propose labeling the address itself', () => {
  const rows = [
    feedback('p1>c46.950,-96.900', 'business'),
    feedback('p3>c46.950,-96.900', 'business'),
  ];
  const suggestions = buildSuggestions(rows);
  const placeSuggestion = suggestions.find((s) => s.kind === 'place');
  assert.ok(placeSuggestion);
  assert.equal(placeSuggestion.classification, 'business');
  assert.deepEqual(placeSuggestion.coordinate, { latitude: 46.95, longitude: -96.9 });
  assert.match(placeSuggestion.description, /label that address/i);
  // Labeling an address is the better fix, so it is offered first.
  assert.equal(suggestions[0]?.kind, 'place');
});

test('a destination that is already a labeled place needs no place suggestion', () => {
  const rows = [feedback('p1>p2', 'business'), feedback('p1>p2', 'business')];
  assert.equal(buildSuggestions(rows).some((s) => s.kind === 'place'), false);
});

test('descriptions use human names when a resolver is supplied', () => {
  const rows = [feedback('p1>p2', 'business'), feedback('p1>p2', 'business')];
  const names: Record<string, string> = { p1: 'Home', p2: 'Acme Warehouse' };
  const route = buildSuggestions(rows, {}, (key) => names[key] ?? key)[0];
  assert.ok(route);
  assert.equal(route.description, 'Home → Acme Warehouse has been business 2 times');
});

test('unclassified corrections are ignored as training signal', () => {
  const rows = [feedback('p1>p2', 'unclassified'), feedback('p1>p2', 'unclassified')];
  assert.equal(buildSuggestions(rows).length, 0);
});

test('the learning threshold is configurable', () => {
  const rows = [feedback('p1>p2', 'business'), feedback('p1>p2', 'business')];
  assert.equal(buildSuggestions(rows, { minObservations: 5 }).length, 0);
});

test('coordinate keys round-trip', () => {
  assert.deepEqual(coordFromKey('c46.950,-96.900'), { latitude: 46.95, longitude: -96.9 });
  assert.equal(coordFromKey('p7'), null);
});
