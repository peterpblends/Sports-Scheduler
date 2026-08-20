/** Shared vocabulary for the ledger. */

/** How a trip counts at tax time. */
export type Classification =
  | 'business'
  | 'personal'
  | 'commute'
  | 'medical'
  | 'charity'
  | 'unclassified';

export const CLASSIFICATIONS: Classification[] = [
  'business',
  'personal',
  'commute',
  'medical',
  'charity',
  'unclassified',
];

/** Only these count toward a deduction, each at its own IRS rate. */
export const DEDUCTIBLE: Classification[] = ['business', 'medical', 'charity'];

export function isClassification(value: unknown): value is Classification {
  return typeof value === 'string' && (CLASSIFICATIONS as string[]).includes(value);
}

/** What decided a trip's classification. Shown to the CPA as the audit trail. */
export type ClassificationSource =
  | 'user' // the owner said so
  | 'rule' // an explicit rule matched
  | 'learned' // an accepted learned pattern matched
  | 'place' // inferred from a labeled address/city
  | 'default' // fell through to the default setting
  | 'none';

export type PlaceLabel = 'business' | 'personal' | 'neutral';
export type PlaceKind = 'address' | 'city' | 'region';

export type Sample = {
  id?: number;
  vehicleId: number;
  at: string;
  odometerMiles: number | null;
  latitude: number | null;
  longitude: number | null;
  shiftState: string | null;
  speedMph: number | null;
  state: string | null;
  chargingState: string | null;
  batteryLevel: number | null;
  cached: boolean;
  source: string;
};

export type Place = {
  id: number;
  name: string;
  kind: PlaceKind;
  label: PlaceLabel;
  purpose: string | null;
  client: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
  isHome: boolean;
  isPrimaryOffice: boolean;
  notes: string | null;
  visitCount: number;
};

export type Trip = {
  id: number;
  vehicleId: number;
  startedAt: string;
  endedAt: string;
  startLatitude: number | null;
  startLongitude: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
  startOdometerMiles: number | null;
  endOdometerMiles: number | null;
  distanceMiles: number;
  durationSeconds: number;
  startPlaceId: number | null;
  endPlaceId: number | null;
  startDescription: string | null;
  endDescription: string | null;
  classification: Classification;
  classificationSource: ClassificationSource;
  classificationReason: string | null;
  confidence: number;
  purpose: string | null;
  client: string | null;
  notes: string | null;
  locked: boolean;
  inferred: boolean;
  open: boolean;
  distanceSource: 'odometer' | 'estimated';
  needsReview: boolean;
  signature: string | null;
};

/** A trip as produced by the stitcher, before it is matched and classified. */
export type StitchedTrip = {
  startedAt: string;
  endedAt: string;
  startLatitude: number | null;
  startLongitude: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
  startOdometerMiles: number | null;
  endOdometerMiles: number | null;
  distanceMiles: number;
  durationSeconds: number;
  /** True when the trip was reconstructed from an odometer jump across a data gap. */
  inferred: boolean;
  /** True while the car is still on this trip. */
  open: boolean;
  distanceSource: 'odometer' | 'estimated';
};
