import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrip, needsReview, ruleMatches, type Rule } from '../src/domain/classify.ts';
import type { ClassifyInput, ClassifySettings } from '../src/domain/classify.ts';
import { matchPlace, describeEndpoint } from '../src/domain/places.ts';
import type { Place } from '../src/domain/types.ts';

const TZ = 'America/Chicago';

const settings: ClassifySettings = {
  timezone: TZ,
  fallback: 'unclassified',
  commuteHandling: 'commute',
  minimumBusinessMiles: 0,
};

function place(overrides: Partial<Place> & { id: number; name: string }): Place {
  return {
    kind: 'address',
    label: 'business',
    purpose: null,
    client: null,
    address: null,
    city: null,
    region: null,
    postal: null,
    latitude: null,
    longitude: null,
    radiusMeters: 200,
    isHome: false,
    isPrimaryOffice: false,
    notes: null,
    visitCount: 0,
    ...overrides,
  };
}

const home = place({
  id: 1,
  name: 'Home',
  label: 'personal',
  isHome: true,
  latitude: 46.8772,
  longitude: -96.7898,
  city: 'Fargo',
  region: 'North Dakota',
});
const office = place({
  id: 2,
  name: 'Main Office',
  label: 'business',
  isPrimaryOffice: true,
  latitude: 46.8901,
  longitude: -96.8003,
  city: 'Fargo',
});
const warehouse = place({
  id: 3,
  name: 'Acme Warehouse',
  label: 'business',
  purpose: 'Client delivery',
  client: 'Acme',
  latitude: 46.95,
  longitude: -96.9,
});
const fargoCity = place({
  id: 4,
  name: 'All of Fargo',
  kind: 'city',
  label: 'business',
  city: 'Fargo',
  latitude: 46.8772,
  longitude: -96.7898,
  radiusMeters: 12_000,
});

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    startedAt: '2026-08-17T14:00:00Z',
    distanceMiles: 12,
    inferred: false,
    signature: 'p1>p3',
    startMatch: null,
    endMatch: null,
    startCity: null,
    endCity: null,
    startRegion: null,
    endRegion: null,
    ...overrides,
  };
}

function geofence(p: Place) {
  return { place: p, distanceMeters: 20, via: 'geofence' as const };
}

test('a trip to a business address is business, with the place purpose attached', () => {
  const outcome = classifyTrip(
    input({ startMatch: geofence(home), endMatch: geofence(warehouse) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'business');
  assert.equal(outcome.source, 'place');
  assert.equal(outcome.client, 'Acme');
  assert.equal(outcome.purpose, 'Client delivery');
  assert.match(outcome.reason, /Acme Warehouse/);
  assert.equal(needsReview(outcome), false);
});

test('home to the regular office is flagged as a non-deductible commute', () => {
  const outcome = classifyTrip(
    input({ startMatch: geofence(home), endMatch: geofence(office) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'commute');
  assert.match(outcome.reason, /non-deductible/);
});

test('office to home is a commute in the other direction too', () => {
  const outcome = classifyTrip(
    input({ startMatch: geofence(office), endMatch: geofence(home) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'commute');
});

test('office to a client is business, not a commute', () => {
  const outcome = classifyTrip(
    input({ startMatch: geofence(office), endMatch: geofence(warehouse) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'business');
  assert.ok(outcome.confidence >= 0.9);
});

test('both ends personal is personal', () => {
  const grocery = place({ id: 9, name: 'Grocery', label: 'personal' });
  const outcome = classifyTrip(
    input({ startMatch: geofence(home), endMatch: geofence(grocery) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'personal');
});

test('an unlabeled trip stays unclassified and lands in the review queue', () => {
  const outcome = classifyTrip(input(), [], settings);
  assert.equal(outcome.classification, 'unclassified');
  assert.equal(needsReview(outcome), true);
  assert.match(outcome.reason, /label an address/i);
});

test('one labeled personal end with an unknown other end is low confidence', () => {
  const outcome = classifyTrip(input({ startMatch: geofence(home) }), [], settings);
  assert.equal(outcome.classification, 'personal');
  assert.equal(needsReview(outcome), true);
});

test('coming home from a client site is still business', () => {
  const outcome = classifyTrip(
    input({ startMatch: geofence(warehouse), endMatch: geofence(home) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'business');
  assert.match(outcome.reason, /Return leg/);
});

test('leaving a business stop for a personal errand is personal', () => {
  const grocery = place({ id: 11, name: 'Grocery', label: 'personal' });
  const outcome = classifyTrip(
    input({ startMatch: geofence(warehouse), endMatch: geofence(grocery) }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'personal');
  assert.match(outcome.reason, /ended at Grocery/);
});

test('a rule outranks the labels on the endpoints', () => {
  const rule: Rule = {
    id: 1,
    name: 'Saturday driving is personal',
    priority: 10,
    enabled: true,
    source: 'user',
    conditions: { weekdays: [6] },
    classification: 'personal',
    purpose: null,
    client: null,
  };
  // 2026-08-22T15:00Z is a Saturday morning in Chicago.
  const outcome = classifyTrip(
    input({
      startedAt: '2026-08-22T15:00:00Z',
      startMatch: geofence(home),
      endMatch: geofence(warehouse),
    }),
    [rule],
    settings,
  );
  assert.equal(outcome.classification, 'personal');
  assert.equal(outcome.source, 'rule');
  assert.match(outcome.reason, /Saturday driving is personal/);
});

test('rules are applied in priority order', () => {
  const base = { enabled: true, source: 'user' as const, purpose: null, client: null };
  const rules: Rule[] = [
    { ...base, id: 1, name: 'low priority', priority: 200, conditions: {}, classification: 'personal' },
    { ...base, id: 2, name: 'high priority', priority: 5, conditions: {}, classification: 'business' },
  ];
  const outcome = classifyTrip(input(), rules, settings);
  assert.equal(outcome.classification, 'business');
  assert.match(outcome.reason, /high priority/);
});

test('a disabled rule is ignored', () => {
  const rules: Rule[] = [
    {
      id: 1,
      name: 'off',
      priority: 1,
      enabled: false,
      source: 'user',
      conditions: {},
      classification: 'business',
      purpose: null,
      client: null,
    },
  ];
  assert.equal(classifyTrip(input(), rules, settings).classification, 'unclassified');
});

test('an accepted learned pattern is reported as learned', () => {
  const rules: Rule[] = [
    {
      id: 4,
      name: 'Home → Acme Warehouse is business',
      priority: 50,
      enabled: true,
      source: 'learned',
      conditions: { signature: 'p1>p3' },
      classification: 'business',
      purpose: 'Delivery',
      client: 'Acme',
    },
  ];
  const outcome = classifyTrip(input({ signature: 'p1>p3' }), rules, settings);
  assert.equal(outcome.source, 'learned');
  assert.equal(outcome.classification, 'business');
  assert.equal(outcome.client, 'Acme');
});

test('a learned pattern does not leak onto a different route', () => {
  const rules: Rule[] = [
    {
      id: 4,
      name: 'learned',
      priority: 50,
      enabled: true,
      source: 'learned',
      conditions: { signature: 'p1>p3' },
      classification: 'business',
      purpose: null,
      client: null,
    },
  ];
  const outcome = classifyTrip(input({ signature: 'p1>p9' }), rules, settings);
  assert.equal(outcome.classification, 'unclassified');
});

test('time-of-day windows that wrap past midnight still match', () => {
  const conditions = { afterMinutes: 22 * 60, beforeMinutes: 5 * 60 };
  // 03:30 local
  assert.equal(ruleMatches(conditions, input({ startedAt: '2026-08-17T08:30:00Z' }), TZ), true);
  // 14:00 local
  assert.equal(ruleMatches(conditions, input({ startedAt: '2026-08-17T19:00:00Z' }), TZ), false);
});

test('distance windows bound a rule', () => {
  assert.equal(ruleMatches({ minMiles: 20 }, input({ distanceMiles: 12 }), TZ), false);
  assert.equal(ruleMatches({ maxMiles: 20 }, input({ distanceMiles: 12 }), TZ), true);
});

test('a city label makes trips in that city business', () => {
  const point = { latitude: 46.88, longitude: -96.79 };
  const match = matchPlace(point, { city: 'Fargo' }, [fargoCity]);
  assert.ok(match);
  assert.equal(match.place.id, fargoCity.id);
  assert.equal(match.via, 'city');

  const outcome = classifyTrip(
    input({ endMatch: match, endCity: 'Fargo' }),
    [],
    settings,
  );
  assert.equal(outcome.classification, 'business');
});

test('a specific address label beats the city label around it', () => {
  // Home sits inside the business-labeled city, and must stay personal.
  const match = matchPlace(
    { latitude: 46.8772, longitude: -96.7898 },
    { city: 'Fargo' },
    [fargoCity, home],
  );
  assert.ok(match);
  assert.equal(match.place.id, home.id);
  assert.equal(match.via, 'geofence');
});

test('a coordinate outside every geofence matches nothing', () => {
  assert.equal(matchPlace({ latitude: 40.0, longitude: -80.0 }, null, [home, office, warehouse]), null);
});

test('city labels still work with no network geocoding, by radius', () => {
  const match = matchPlace({ latitude: 46.9, longitude: -96.82 }, null, [fargoCity]);
  assert.ok(match);
  assert.equal(match.place.id, fargoCity.id);
});

test('endpoint descriptions prefer the place name, then the street address', () => {
  assert.equal(describeEndpoint(geofence(warehouse), null, null), 'Acme Warehouse');
  assert.equal(
    describeEndpoint(null, { houseNumber: '1420', road: 'Main Ave', city: 'Fargo', region: 'ND' }, null),
    '1420 Main Ave, Fargo, ND',
  );
  assert.equal(
    describeEndpoint(null, null, { latitude: 46.87721, longitude: -96.78981 }),
    '46.8772, -96.7898',
  );
});

test('the fallback setting can record unlabeled trips as personal', () => {
  const outcome = classifyTrip(input(), [], { ...settings, fallback: 'personal' });
  assert.equal(outcome.classification, 'personal');
  assert.equal(outcome.source, 'default');
});

test('commute handling can be switched to personal', () => {
  const outcome = classifyTrip(
    input({ startMatch: geofence(home), endMatch: geofence(office) }),
    [],
    { ...settings, commuteHandling: 'personal' },
  );
  assert.equal(outcome.classification, 'personal');
});
