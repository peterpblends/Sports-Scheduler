/**
 * The pipeline: readings in, classified trips out.
 *
 * Each pass re-stitches a recent window of readings and upserts the result, so
 * running it more often is harmless and a trip in progress becomes complete on
 * its own. Reclassification is separate and can be run over all history, which
 * is what makes labeling one address retroactively fix months of trips.
 */
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import { readSettings, type AppSettings } from '../settings.ts';
import { stitchTrips } from './stitch.ts';
import { classifyTrip, needsReview, type ClassifyInput, type ClassifySettings } from './classify.ts';
import { describeEndpoint, matchPlace, type GeoInfo, type PlaceMatch } from './places.ts';
import { buildSuggestions, ruleConditionsForSuggestion, tripSignature } from './learning.ts';
import type { Classification, Place, Sample, Trip } from './types.ts';
import { coordKey, isPoint, type Point } from '../lib/geo.ts';
import { nowIso, msOf } from '../lib/time.ts';
import { log } from '../lib/log.ts';

export type Endpoint = {
  point: Point | null;
  match: PlaceMatch | null;
  geo: GeoInfo | null;
  description: string;
};

function pointOf(latitude: number | null, longitude: number | null): Point | null {
  return isPoint({ latitude, longitude })
    ? { latitude: latitude as number, longitude: longitude as number }
    : null;
}

/** Resolve one end of a trip against labeled places and the geocode cache. */
export function resolveEndpoint(
  db: Database,
  latitude: number | null,
  longitude: number | null,
  places: Place[],
): Endpoint {
  const point = pointOf(latitude, longitude);
  const geo = point === null ? null : repo.getGeocode(db, coordKey(point, 4));
  const match = matchPlace(point, geo, places);
  return { point, match, geo, description: describeEndpoint(match, geo, point) };
}

function classifySettingsFrom(settings: AppSettings): ClassifySettings {
  return {
    timezone: settings.timezone,
    fallback: settings.fallback,
    commuteHandling: settings.commuteHandling,
    minimumBusinessMiles: 0,
  };
}

export function ingestSamples(db: Database, samples: Sample[]): number {
  let inserted = 0;
  for (const sample of samples) {
    if (repo.insertSample(db, sample)) inserted += 1;
  }
  const last = samples[samples.length - 1];
  if (last !== undefined) {
    repo.updateVehicleStatus(db, last.vehicleId, {
      odometerMiles: last.odometerMiles,
      sampleAt: last.at,
      state: last.state,
    });
  }
  return inserted;
}

export type RebuildResult = {
  created: number;
  updated: number;
  retired: number;
  discardedMiles: number;
};

/**
 * Re-derive trips for a vehicle from stored readings.
 *
 * `fromIso` defaults to the configured lookback window. Pass the epoch to
 * rebuild the entire history from the original readings.
 */
export function rebuildTrips(db: Database, vehicleId: number, fromIso?: string): RebuildResult {
  const settings = readSettings(db);
  const from =
    fromIso ??
    new Date(Date.now() - settings.stitchLookbackHours * 3600_000).toISOString();

  const samples = repo.samplesSince(db, vehicleId, from);
  if (samples.length === 0) {
    return { created: 0, updated: 0, retired: 0, discardedMiles: 0 };
  }

  const stitched = stitchTrips(samples, {
    parkGraceSeconds: settings.parkGraceSeconds,
    minTripMiles: settings.minTripMiles,
    maxGapSeconds: settings.maxGapSeconds,
  });

  const places = repo.listPlaces(db);
  const rules = repo.listRules(db, false);
  const classifySettings = classifySettingsFrom(settings);

  let created = 0;
  let updated = 0;

  db.transaction(() => {
    for (const trip of stitched.trips) {
      const start = resolveEndpoint(db, trip.startLatitude, trip.startLongitude, places);
      const end = resolveEndpoint(db, trip.endLatitude, trip.endLongitude, places);
      const signature = tripSignature(start.match, start.point, end.match, end.point);

      const input: ClassifyInput = {
        startedAt: trip.startedAt,
        distanceMiles: trip.distanceMiles,
        inferred: trip.inferred,
        signature,
        startMatch: start.match,
        endMatch: end.match,
        startCity: start.geo?.city ?? start.match?.place.city ?? null,
        endCity: end.geo?.city ?? end.match?.place.city ?? null,
        startRegion: start.geo?.region ?? start.match?.place.region ?? null,
        endRegion: end.geo?.region ?? end.match?.place.region ?? null,
      };
      const outcome = classifyTrip(input, rules, classifySettings);

      const result = repo.upsertTrip(db, {
        vehicleId,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        startLatitude: trip.startLatitude,
        startLongitude: trip.startLongitude,
        endLatitude: trip.endLatitude,
        endLongitude: trip.endLongitude,
        startOdometerMiles: trip.startOdometerMiles,
        endOdometerMiles: trip.endOdometerMiles,
        distanceMiles: trip.distanceMiles,
        durationSeconds: trip.durationSeconds,
        startPlaceId: start.match?.place.id ?? null,
        endPlaceId: end.match?.place.id ?? null,
        startDescription: start.description,
        endDescription: end.description,
        classification: outcome.classification,
        classificationSource: outcome.source,
        classificationReason: outcome.reason,
        confidence: outcome.confidence,
        purpose: outcome.purpose,
        client: outcome.client,
        notes: null,
        locked: false,
        inferred: trip.inferred,
        open: trip.open,
        distanceSource: trip.distanceSource,
        needsReview: needsReview(outcome, settings.reviewThreshold),
        signature,
      });

      if (result.created) {
        created += 1;
        if (outcome.ruleId !== null) repo.bumpRuleHits(db, outcome.ruleId);
        const visited = [start.match?.place.id, end.match?.place.id].filter(
          (id): id is number => typeof id === 'number',
        );
        repo.bumpVisits(db, visited);
      } else {
        updated += 1;
      }
    }
  });

  const retired = repo.retireStaleTrips(
    db,
    vehicleId,
    from,
    stitched.trips.map((trip) => trip.startedAt),
  );

  return { created, updated, retired, discardedMiles: stitched.discardedMiles };
}

/**
 * Re-run labeling and classification over stored trips. Called whenever a place
 * or rule changes, which is how one new label fixes every past trip at once.
 * Trips the owner decided on are left exactly as they are.
 */
export function reclassifyAll(db: Database): { examined: number; changed: number } {
  const settings = readSettings(db);
  const places = repo.listPlaces(db);
  const rules = repo.listRules(db, false);
  const classifySettings = classifySettingsFrom(settings);
  const trips = repo.allTripsForReclassify(db);

  let changed = 0;
  db.transaction(() => {
    for (const trip of trips) {
      const start = resolveEndpoint(db, trip.startLatitude, trip.startLongitude, places);
      const end = resolveEndpoint(db, trip.endLatitude, trip.endLongitude, places);
      const signature = tripSignature(start.match, start.point, end.match, end.point);

      repo.setTripPlaces(db, trip.id, {
        startPlaceId: start.match?.place.id ?? null,
        endPlaceId: end.match?.place.id ?? null,
        startDescription: start.description,
        endDescription: end.description,
        signature,
      });

      if (trip.locked) continue;

      const outcome = classifyTrip(
        {
          startedAt: trip.startedAt,
          distanceMiles: trip.distanceMiles,
          inferred: trip.inferred,
          signature,
          startMatch: start.match,
          endMatch: end.match,
          startCity: start.geo?.city ?? start.match?.place.city ?? null,
          endCity: end.geo?.city ?? end.match?.place.city ?? null,
          startRegion: start.geo?.region ?? start.match?.place.region ?? null,
          endRegion: end.geo?.region ?? end.match?.place.region ?? null,
        },
        rules,
        classifySettings,
      );

      const differs =
        outcome.classification !== trip.classification ||
        outcome.reason !== trip.classificationReason;

      repo.applyClassification(db, trip.id, {
        classification: outcome.classification,
        source: outcome.source,
        reason: outcome.reason,
        confidence: outcome.confidence,
        purpose: outcome.purpose,
        client: outcome.client,
        needsReview: needsReview(outcome, settings.reviewThreshold),
      });

      if (differs) changed += 1;
    }
  });

  return { examined: trips.length, changed };
}

/**
 * Record the owner's decision on a trip and learn from it.
 *
 * The decision itself is final for that trip. The learning half only ever
 * produces proposals unless the owner turned on automatic application.
 */
export function decideTrip(
  db: Database,
  tripId: number,
  decision: {
    classification: Classification;
    purpose?: string | null;
    client?: string | null;
    notes?: string | null;
  },
): Trip | null {
  const trip = repo.getTrip(db, tripId);
  if (trip === null) return null;

  const updated = repo.setTripDecision(db, tripId, decision);
  if (trip.signature !== null) {
    repo.addFeedback(db, {
      tripId,
      signature: trip.signature,
      classification: decision.classification,
      purpose: decision.purpose ?? trip.purpose,
      client: decision.client ?? trip.client,
    });
    refreshSuggestions(db);
  }
  db.audit('owner', 'trip.classify', 'trip', tripId, decision.classification);
  return updated;
}

/** Look for patterns worth automating. Returns how many proposals are open. */
export function refreshSuggestions(db: Database): number {
  const settings = readSettings(db);
  const feedback = repo.listFeedback(db);
  const describe = endpointDescriber(db);

  const suggestions = buildSuggestions(
    feedback,
    { minObservations: settings.learnMinObservations, agreement: settings.learnAgreement },
    describe,
  );

  for (const suggestion of suggestions) {
    repo.upsertSuggestion(db, {
      signature: suggestion.key,
      classification: suggestion.classification,
      purpose: suggestion.purpose,
      client: suggestion.client,
      observations: suggestion.observations,
      description: suggestion.description,
    });

    if (settings.autoApplyLearned && suggestion.kind === 'route') {
      const conditions = ruleConditionsForSuggestion(suggestion);
      if (conditions === null) continue;
      const already = repo
        .listRules(db)
        .some((rule) => rule.conditions.signature === conditions.signature);
      if (already) continue;
      repo.createRule(db, {
        name: suggestion.description,
        priority: 60,
        enabled: true,
        source: 'learned',
        conditions,
        classification: suggestion.classification,
        purpose: suggestion.purpose,
        client: suggestion.client,
      });
      const open = repo.listSuggestions(db).find((s) => s.signature === suggestion.key);
      if (open !== undefined) repo.setSuggestionStatus(db, open.id, 'accepted');
      log.info(`learned pattern applied automatically: ${suggestion.description}`);
    }
  }

  if (settings.autoApplyLearned) reclassifyAll(db);
  return repo.listSuggestions(db).length;
}

/**
 * Turn an endpoint key back into something a person recognizes, for suggestion
 * text. Place keys resolve to the place name; coordinate keys fall back to the
 * description already stored on a trip that ended there.
 */
export function endpointDescriber(db: Database): (key: string) => string {
  const places = new Map(repo.listPlaces(db).map((place) => [`p${place.id}`, place.name]));
  const cache = new Map<string, string>();
  return (key: string): string => {
    const named = places.get(key);
    if (named !== undefined) return named;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const row = db.get<{ end_description?: string }>(
      "SELECT end_description FROM trip WHERE signature LIKE ? AND end_description IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      `%>${key}`,
    );
    const description = row?.end_description ?? key.replace(/^c/, '');
    cache.set(key, description);
    return description;
  };
}

/** Accept a proposal: create the rule (or hand back the place to create). */
export function acceptSuggestion(
  db: Database,
  id: number,
): { kind: 'route'; ruleId: number } | { kind: 'place'; latitude: number; longitude: number } | null {
  const suggestion = repo.getSuggestion(db, id);
  if (suggestion === null) return null;

  if (suggestion.signature.startsWith('route:')) {
    const signature = suggestion.signature.slice('route:'.length);
    const rule = repo.createRule(db, {
      name: suggestion.description,
      priority: 60,
      enabled: true,
      source: 'learned',
      conditions: { signature },
      classification: suggestion.classification,
      purpose: suggestion.purpose,
      client: suggestion.client,
    });
    repo.setSuggestionStatus(db, id, 'accepted');
    reclassifyAll(db);
    db.audit('owner', 'suggestion.accept', 'rule', rule.id, suggestion.description);
    return { kind: 'route', ruleId: rule.id };
  }

  const key = suggestion.signature.slice('place:'.length);
  const [lat, lon] = key.replace(/^c/, '').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { kind: 'place', latitude: lat as number, longitude: lon as number };
}

/** Drop readings past the retention window. Trips and decisions are untouched. */
export function pruneOldSamples(db: Database): number {
  const settings = readSettings(db);
  const cutoff = new Date(Date.now() - settings.sampleRetentionDays * 86_400_000).toISOString();
  const removed = repo.pruneSamples(db, cutoff);
  if (removed > 0) log.info(`pruned ${removed} readings older than ${settings.sampleRetentionDays} days`);
  return removed;
}

/** Newest reading across all vehicles, for the live status strip. */
export function lastActivity(db: Database): { at: string | null; ageMinutes: number | null } {
  const at = db.value<string>('SELECT MAX(at) FROM sample');
  if (at === undefined || at === null) return { at: null, ageMinutes: null };
  return { at, ageMinutes: Math.round((msOf(nowIso()) - msOf(at)) / 60_000) };
}
