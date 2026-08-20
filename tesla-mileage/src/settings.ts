/**
 * Settings live in the database so they can be changed from the browser without
 * touching a file or restarting. Environment variables only supply the initial
 * defaults (and the secrets, which never get stored in a form).
 */
import type { Database } from './db/index.ts';
import type { Classification } from './domain/types.ts';
import { isClassification } from './domain/types.ts';
import { config } from './config.ts';
import { isValidTimezone } from './lib/time.ts';
import { log } from './lib/log.ts';

export type AppSettings = {
  timezone: string;
  /** Follow the device, or override it. */
  appearance: 'system' | 'light' | 'dark';
  /** Full colour, or black and white. Independent of light/dark. */
  colour: 'colour' | 'mono';
  businessName: string;
  ownerName: string;
  vehicleDescription: string;
  /** What to do with a trip nothing else explains. */
  fallback: Classification;
  commuteHandling: 'commute' | 'personal' | 'business';
  /** Confidence at or above which a trip is considered settled. */
  reviewThreshold: number;
  parkGraceSeconds: number;
  minTripMiles: number;
  maxGapSeconds: number;
  learnMinObservations: number;
  learnAgreement: number;
  /** Apply a learned pattern automatically instead of proposing it first. */
  autoApplyLearned: boolean;
  geocodeEnabled: boolean;
  creditBudget: number;
  pollDrivingSeconds: number;
  pollAwakeSeconds: number;
  pollAsleepSeconds: number;
  /** How long raw readings are kept. Trips are kept forever. */
  sampleRetentionDays: number;
  stitchLookbackHours: number;
  connector: string;
};

export const SETTING_KEYS = {
  timezone: 'timezone',
  appearance: 'appearance',
  colour: 'colour_mode',
  businessName: 'business_name',
  ownerName: 'owner_name',
  vehicleDescription: 'vehicle_description',
  fallback: 'fallback_classification',
  commuteHandling: 'commute_handling',
  reviewThreshold: 'review_threshold',
  parkGraceSeconds: 'park_grace_seconds',
  minTripMiles: 'min_trip_miles',
  maxGapSeconds: 'max_gap_seconds',
  learnMinObservations: 'learn_min_observations',
  learnAgreement: 'learn_agreement',
  autoApplyLearned: 'auto_apply_learned',
  geocodeEnabled: 'geocode_enabled',
  creditBudget: 'credit_budget',
  pollDrivingSeconds: 'poll_driving_seconds',
  pollAwakeSeconds: 'poll_awake_seconds',
  pollAsleepSeconds: 'poll_asleep_seconds',
  sampleRetentionDays: 'sample_retention_days',
  stitchLookbackHours: 'stitch_lookback_hours',
  connector: 'connector',
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A usable zone, whatever is stored. Falls back rather than throwing. */
function safeTimezone(stored: string): string {
  if (isValidTimezone(stored)) return stored;
  log.warn(`stored time zone "${stored}" is not one Intl recognises; falling back to ${config.timezone}`);
  if (isValidTimezone(config.timezone)) return config.timezone;
  return 'UTC';
}

export function readSettings(db: Database): AppSettings {
  const fallbackRaw = db.settingOr(SETTING_KEYS.fallback, 'unclassified');
  const commuteRaw = db.settingOr(SETTING_KEYS.commuteHandling, 'commute');
  const appearanceRaw = db.settingOr(SETTING_KEYS.appearance, 'system');
  const colourRaw = db.settingOr(SETTING_KEYS.colour, 'colour');
  return {
    timezone: safeTimezone(db.settingOr(SETTING_KEYS.timezone, config.timezone)),
    appearance: appearanceRaw === 'light' || appearanceRaw === 'dark' ? appearanceRaw : 'system',
    colour: colourRaw === 'mono' ? 'mono' : 'colour',
    businessName: db.settingOr(SETTING_KEYS.businessName, ''),
    ownerName: db.settingOr(SETTING_KEYS.ownerName, ''),
    vehicleDescription: db.settingOr(SETTING_KEYS.vehicleDescription, ''),
    fallback: isClassification(fallbackRaw) ? fallbackRaw : 'unclassified',
    commuteHandling:
      commuteRaw === 'personal' || commuteRaw === 'business' ? commuteRaw : 'commute',
    reviewThreshold: clamp(db.settingNumber(SETTING_KEYS.reviewThreshold, 0.75), 0, 1),
    parkGraceSeconds: clamp(db.settingNumber(SETTING_KEYS.parkGraceSeconds, 300), 30, 3600),
    minTripMiles: clamp(db.settingNumber(SETTING_KEYS.minTripMiles, 0.15), 0, 5),
    maxGapSeconds: clamp(db.settingNumber(SETTING_KEYS.maxGapSeconds, 900), 120, 86_400),
    learnMinObservations: clamp(db.settingNumber(SETTING_KEYS.learnMinObservations, 2), 1, 50),
    learnAgreement: clamp(db.settingNumber(SETTING_KEYS.learnAgreement, 0.8), 0.5, 1),
    autoApplyLearned: db.settingBool(SETTING_KEYS.autoApplyLearned, false),
    geocodeEnabled: db.settingBool(SETTING_KEYS.geocodeEnabled, config.geocode),
    creditBudget: clamp(db.settingNumber(SETTING_KEYS.creditBudget, config.creditBudget), 0, 10_000_000),
    pollDrivingSeconds: clamp(db.settingNumber(SETTING_KEYS.pollDrivingSeconds, 90), 30, 3600),
    pollAwakeSeconds: clamp(db.settingNumber(SETTING_KEYS.pollAwakeSeconds, 300), 60, 7200),
    pollAsleepSeconds: clamp(db.settingNumber(SETTING_KEYS.pollAsleepSeconds, 1200), 300, 21_600),
    sampleRetentionDays: clamp(db.settingNumber(SETTING_KEYS.sampleRetentionDays, 400), 30, 10_000),
    stitchLookbackHours: clamp(db.settingNumber(SETTING_KEYS.stitchLookbackHours, 72), 2, 8760),
    connector: db.settingOr(SETTING_KEYS.connector, config.connector),
  };
}

/**
 * Write settings, ignoring keys that are not ours and values that would break
 * the app. Returns a message for anything refused, so the UI can say so instead
 * of silently keeping the old value.
 */
export function writeSettings(db: Database, patch: Record<string, string>): string[] {
  const allowed = new Set<string>(Object.values(SETTING_KEYS));
  const refused: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) continue;
    if (key === SETTING_KEYS.timezone && !isValidTimezone(value)) {
      refused.push(`"${value}" is not a time zone name. Keeping ${db.settingOr(SETTING_KEYS.timezone, config.timezone)}. Use a name like America/Chicago.`);
      continue;
    }
    db.putSetting(key, value);
  }
  return refused;
}
