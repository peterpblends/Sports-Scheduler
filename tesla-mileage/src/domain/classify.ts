/**
 * Deciding whether a trip was business or personal, and being able to say why.
 *
 * Precedence, highest first:
 *   1. The owner's own decision. Never overwritten by anything below.
 *   2. Rules, in priority order. Learned patterns are ordinary rules that the
 *      owner accepted, so they are visible and removable like any other.
 *   3. Commuting. A trip between home and the regular office is not deductible
 *      under IRS rules, so it is called out as its own category rather than
 *      being quietly counted as business.
 *   4. The labels on the trip's two endpoints.
 *   5. The configured fallback.
 *
 * Every outcome carries a plain-English reason. That string ends up in the CPA
 * export, so a human can audit any number in the report.
 */
import type { Classification, ClassificationSource, PlaceLabel } from './types.ts';
import { isClassification } from './types.ts';
import type { PlaceMatch } from './places.ts';
import { localMinutes, localWeekday } from '../lib/time.ts';

export type RuleConditions = {
  /** Match a specific labeled place at the start, the end, or either end. */
  startPlaceId?: number;
  endPlaceId?: number;
  anyPlaceId?: number;
  /** Match by the label on an endpoint rather than a specific place. */
  startLabel?: PlaceLabel;
  endLabel?: PlaceLabel;
  anyLabel?: PlaceLabel;
  /** Match by city or state/region name on either endpoint. */
  city?: string;
  region?: string;
  /** Local weekdays, 0 = Sunday. */
  weekdays?: number[];
  /** Local time-of-day window, minutes since midnight. */
  afterMinutes?: number;
  beforeMinutes?: number;
  /** Distance window in miles. */
  minMiles?: number;
  maxMiles?: number;
  /** Exact route signature — how accepted learned patterns are expressed. */
  signature?: string;
  /** Only trips reconstructed across a data gap (or only complete ones). */
  inferred?: boolean;
};

export type Rule = {
  id: number;
  name: string;
  priority: number;
  enabled: boolean;
  source: 'user' | 'learned' | 'builtin';
  conditions: RuleConditions;
  classification: Classification;
  purpose: string | null;
  client: string | null;
  /** How many trips this rule has decided. Display only. */
  hits?: number;
};

export type ClassifyInput = {
  startedAt: string;
  distanceMiles: number;
  inferred: boolean;
  signature: string | null;
  startMatch: PlaceMatch | null;
  endMatch: PlaceMatch | null;
  startCity: string | null;
  endCity: string | null;
  startRegion: string | null;
  endRegion: string | null;
};

export type ClassifySettings = {
  timezone: string;
  /** Used when nothing else matches. `unclassified` keeps it in the review queue. */
  fallback: Classification;
  /** How to treat home-to-regular-office driving. */
  commuteHandling: 'commute' | 'personal' | 'business';
  /** Trips at or below this distance from a business stop stay business (coffee run, etc.). */
  minimumBusinessMiles: number;
};

export const DEFAULT_SETTINGS: ClassifySettings = {
  timezone: 'UTC',
  fallback: 'unclassified',
  commuteHandling: 'commute',
  minimumBusinessMiles: 0,
};

export type ClassifyOutcome = {
  classification: Classification;
  source: ClassificationSource;
  reason: string;
  confidence: number;
  purpose: string | null;
  client: string | null;
  ruleId: number | null;
};

function textMatches(candidate: string | null, wanted: string | undefined): boolean {
  if (wanted === undefined || wanted.trim() === '') return true;
  return (candidate ?? '').trim().toLowerCase() === wanted.trim().toLowerCase();
}

/** Does a rule's condition set apply to this trip? Unset fields are wildcards. */
export function ruleMatches(
  conditions: RuleConditions,
  input: ClassifyInput,
  timezone: string,
): boolean {
  const startPlace = input.startMatch?.place ?? null;
  const endPlace = input.endMatch?.place ?? null;

  if (conditions.signature !== undefined && conditions.signature !== input.signature) return false;

  if (conditions.startPlaceId !== undefined && startPlace?.id !== conditions.startPlaceId) return false;
  if (conditions.endPlaceId !== undefined && endPlace?.id !== conditions.endPlaceId) return false;
  if (
    conditions.anyPlaceId !== undefined &&
    startPlace?.id !== conditions.anyPlaceId &&
    endPlace?.id !== conditions.anyPlaceId
  ) {
    return false;
  }

  if (conditions.startLabel !== undefined && startPlace?.label !== conditions.startLabel) return false;
  if (conditions.endLabel !== undefined && endPlace?.label !== conditions.endLabel) return false;
  if (
    conditions.anyLabel !== undefined &&
    startPlace?.label !== conditions.anyLabel &&
    endPlace?.label !== conditions.anyLabel
  ) {
    return false;
  }

  if (conditions.city !== undefined && conditions.city.trim() !== '') {
    if (!textMatches(input.startCity, conditions.city) && !textMatches(input.endCity, conditions.city)) {
      return false;
    }
  }
  if (conditions.region !== undefined && conditions.region.trim() !== '') {
    if (
      !textMatches(input.startRegion, conditions.region) &&
      !textMatches(input.endRegion, conditions.region)
    ) {
      return false;
    }
  }

  if (conditions.weekdays !== undefined && conditions.weekdays.length > 0) {
    if (!conditions.weekdays.includes(localWeekday(input.startedAt, timezone))) return false;
  }

  if (conditions.afterMinutes !== undefined || conditions.beforeMinutes !== undefined) {
    const minutes = localMinutes(input.startedAt, timezone);
    const after = conditions.afterMinutes ?? 0;
    const before = conditions.beforeMinutes ?? 24 * 60;
    if (after <= before) {
      if (minutes < after || minutes > before) return false;
    } else if (minutes < after && minutes > before) {
      // Window wraps past midnight (e.g. 22:00 to 05:00).
      return false;
    }
  }

  if (conditions.minMiles !== undefined && input.distanceMiles < conditions.minMiles) return false;
  if (conditions.maxMiles !== undefined && input.distanceMiles > conditions.maxMiles) return false;
  if (conditions.inferred !== undefined && conditions.inferred !== input.inferred) return false;

  return true;
}

export function parseConditions(json: string): RuleConditions {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as RuleConditions;
  } catch {
    return {};
  }
}

function endpointName(place: { name: string } | null, fallback: string): string {
  return place === null ? fallback : place.name;
}

/** Classify one trip. Pure: same inputs, same answer, no database access. */
export function classifyTrip(
  input: ClassifyInput,
  rules: Rule[],
  settings: ClassifySettings = DEFAULT_SETTINGS,
): ClassifyOutcome {
  const ordered = rules
    .filter((rule) => rule.enabled)
    .sort((a, b) => (a.priority === b.priority ? a.id - b.id : a.priority - b.priority));

  for (const rule of ordered) {
    if (!ruleMatches(rule.conditions, input, settings.timezone)) continue;
    if (!isClassification(rule.classification)) continue;
    return {
      classification: rule.classification,
      source: rule.source === 'learned' ? 'learned' : 'rule',
      reason:
        rule.source === 'learned'
          ? `Learned pattern: ${rule.name}`
          : `Rule: ${rule.name}`,
      confidence: rule.source === 'learned' ? 0.9 : 1,
      purpose: rule.purpose,
      client: rule.client,
      ruleId: rule.id,
    };
  }

  const start = input.startMatch?.place ?? null;
  const end = input.endMatch?.place ?? null;

  // Commuting: home to the regular office and back. Not deductible.
  const homeToOffice =
    (start?.isHome === true && end?.isPrimaryOffice === true) ||
    (start?.isPrimaryOffice === true && end?.isHome === true);
  if (homeToOffice) {
    const classification: Classification =
      settings.commuteHandling === 'business'
        ? 'business'
        : settings.commuteHandling === 'personal'
          ? 'personal'
          : 'commute';
    return {
      classification,
      source: 'place',
      reason:
        settings.commuteHandling === 'commute'
          ? `Commute between ${endpointName(start, 'home')} and ${endpointName(end, 'the office')} — the IRS treats regular commuting as non-deductible`
          : `Home-to-office trip, recorded as ${classification} per your setting`,
      confidence: 0.95,
      purpose: null,
      client: null,
      ruleId: null,
    };
  }

  const startLabel: PlaceLabel | null = start?.label ?? null;
  const endLabel: PlaceLabel | null = end?.label ?? null;

  // Where the car went matters most: arriving at a business location makes the
  // trip business even when it started somewhere personal. Driving from home to
  // a client is ordinary deductible travel, not a commute.
  if (endLabel === 'business' && end !== null) {
    const bothBusiness = startLabel === 'business';
    return {
      classification: 'business',
      source: 'place',
      reason: bothBusiness
        ? `Business location at both ends (${endpointName(start, '?')} → ${end.name})`
        : `Ends at ${end.name}, labeled business`,
      confidence: bothBusiness ? 0.95 : 0.85,
      purpose: end.purpose,
      client: end.client,
      ruleId: null,
    };
  }

  // The return leg. Coming home from a business stop is normally deductible;
  // stopping somewhere personal on the way is not, so that stays personal.
  if (startLabel === 'business' && start !== null) {
    if (end === null || end.isHome) {
      return {
        classification: 'business',
        source: 'place',
        reason: `Return leg from ${start.name}, labeled business`,
        confidence: end === null ? 0.65 : 0.8,
        purpose: start.purpose,
        client: start.client,
        ruleId: null,
      };
    }
    return {
      classification: 'personal',
      source: 'place',
      reason: `Left ${start.name} but ended at ${end.name}, labeled personal`,
      confidence: 0.6,
      purpose: null,
      client: null,
      ruleId: null,
    };
  }

  if (startLabel === 'personal' && endLabel === 'personal') {
    return {
      classification: 'personal',
      source: 'place',
      reason: `Both ends are personal locations (${endpointName(start, '?')} → ${endpointName(end, '?')})`,
      confidence: 0.9,
      purpose: null,
      client: null,
      ruleId: null,
    };
  }

  if (startLabel === 'personal' || endLabel === 'personal') {
    const personal = startLabel === 'personal' ? start : end;
    return {
      classification: 'personal',
      source: 'place',
      reason: `One end is ${endpointName(personal, 'a personal location')}, labeled personal; the other end is not labeled yet`,
      confidence: 0.55,
      purpose: null,
      client: null,
      ruleId: null,
    };
  }

  return {
    classification: settings.fallback,
    source: settings.fallback === 'unclassified' ? 'none' : 'default',
    reason:
      settings.fallback === 'unclassified'
        ? 'Neither end is labeled yet — label an address or city to teach it'
        : `No rule or label matched; recorded as ${settings.fallback} by default`,
    confidence: settings.fallback === 'unclassified' ? 0 : 0.3,
    purpose: null,
    client: null,
    ruleId: null,
  };
}

/** A trip needs a human look when nothing confident decided it. */
export function needsReview(outcome: ClassifyOutcome, reviewThreshold = 0.75): boolean {
  if (outcome.source === 'user') return false;
  if (outcome.classification === 'unclassified') return true;
  return outcome.confidence < reviewThreshold;
}
