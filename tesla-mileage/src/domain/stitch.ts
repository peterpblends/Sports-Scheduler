/**
 * Turning vehicle readings into trips.
 *
 * The odometer is the source of truth for distance — never the GPS track. Two
 * consecutive readings whose odometer advanced mean the car drove that far,
 * regardless of how many readings were missed in between, so the ledger's total
 * always reconciles with the car's own odometer.
 *
 * Polling gaps are expected, not exceptional: the app deliberately reads cached
 * data while the car sleeps (that call is free), so it will regularly wake up to
 * find the car somewhere new with a higher odometer. That produces a trip marked
 * `inferred` — real miles, honest about the missing detail in between.
 */
import type { Sample, StitchedTrip } from './types.ts';
import { haversineMeters, isPoint, metersToMiles } from '../lib/geo.ts';
import { msOf } from '../lib/time.ts';

export type StitchOptions = {
  /** Stationary time that ends a trip. */
  parkGraceSeconds: number;
  /** Movements shorter than this are treated as parking-lot shuffle, not trips. */
  minTripMiles: number;
  /** A quiet stretch longer than this can hide stops, so the result is marked inferred. */
  maxGapSeconds: number;
  /** Odometer noise floor: below this, two readings count as the same place. */
  odometerEpsilonMiles: number;
  /** Straight-line factor used only when no odometer reading is available. */
  estimateRoadFactor: number;
};

export const DEFAULT_STITCH_OPTIONS: StitchOptions = {
  parkGraceSeconds: 300,
  minTripMiles: 0.15,
  maxGapSeconds: 900,
  odometerEpsilonMiles: 0.02,
  estimateRoadFactor: 1.2,
};

export type StitchResult = {
  trips: StitchedTrip[];
  /** Miles seen on the odometer that were too small to become trips. */
  discardedMiles: number;
  /** Total miles the odometer advanced across the samples supplied. */
  odometerMiles: number;
};

type Movement = {
  from: Sample;
  to: Sample;
  miles: number;
  gapSeconds: number;
  source: 'odometer' | 'estimated';
};

function odometerOf(sample: Sample): number | null {
  return typeof sample.odometerMiles === 'number' && Number.isFinite(sample.odometerMiles)
    ? sample.odometerMiles
    : null;
}

/** Does the car report itself as under way at this reading? */
function reportsDriving(sample: Sample): boolean {
  const shift = (sample.shiftState ?? '').toUpperCase();
  if (shift === 'D' || shift === 'R' || shift === 'N') return true;
  return typeof sample.speedMph === 'number' && sample.speedMph > 1;
}

function seconds(from: string, to: string): number {
  return Math.max(0, Math.round((msOf(to) - msOf(from)) / 1000));
}

/** Distance between two readings, preferring the odometer. */
function measure(from: Sample, to: Sample, options: StitchOptions): Movement {
  const gapSeconds = seconds(from.at, to.at);
  const a = odometerOf(from);
  const b = odometerOf(to);
  if (a !== null && b !== null) {
    // A decreasing odometer means a bad reading, not a reversed drive.
    const delta = b - a;
    return {
      from,
      to,
      miles: delta > 0 ? delta : 0,
      gapSeconds,
      source: 'odometer',
    };
  }
  if (isPoint({ latitude: from.latitude, longitude: from.longitude }) &&
      isPoint({ latitude: to.latitude, longitude: to.longitude })) {
    const straight = metersToMiles(
      haversineMeters(
        { latitude: from.latitude as number, longitude: from.longitude as number },
        { latitude: to.latitude as number, longitude: to.longitude as number },
      ),
    );
    return { from, to, miles: straight * options.estimateRoadFactor, gapSeconds, source: 'estimated' };
  }
  return { from, to, miles: 0, gapSeconds, source: 'odometer' };
}

type Builder = {
  start: Sample;
  end: Sample;
  miles: number;
  inferred: boolean;
  source: 'odometer' | 'estimated';
  lastMovementAt: string;
};

function finish(builder: Builder, open: boolean, options: StitchOptions): StitchedTrip | null {
  if (builder.miles < options.minTripMiles) return null;
  const startOdo = odometerOf(builder.start);
  const endOdo = odometerOf(builder.end);
  return {
    startedAt: builder.start.at,
    endedAt: builder.end.at,
    startLatitude: builder.start.latitude,
    startLongitude: builder.start.longitude,
    endLatitude: builder.end.latitude,
    endLongitude: builder.end.longitude,
    startOdometerMiles: startOdo,
    endOdometerMiles: endOdo,
    distanceMiles: Math.round(builder.miles * 1000) / 1000,
    durationSeconds: seconds(builder.start.at, builder.end.at),
    inferred: builder.inferred,
    open,
    distanceSource: builder.source,
  };
}

/**
 * Fold an ordered run of samples into trips.
 *
 * Samples must be ascending by `at`; duplicates on the same timestamp are
 * ignored. The last trip is returned with `open: true` when the car had not yet
 * settled at the final reading, so a drive in progress shows up immediately and
 * is completed on a later pass.
 */
export function stitchTrips(
  input: Sample[],
  overrides: Partial<StitchOptions> = {},
): StitchResult {
  const options = { ...DEFAULT_STITCH_OPTIONS, ...overrides };
  const samples = input
    .filter((s) => Number.isFinite(msOf(s.at)))
    .sort((a, b) => msOf(a.at) - msOf(b.at))
    .filter((s, i, arr) => i === 0 || s.at !== arr[i - 1]?.at);

  const trips: StitchedTrip[] = [];
  let discardedMiles = 0;
  let odometerMiles = 0;
  let builder: Builder | null = null;

  const close = (open: boolean): void => {
    if (builder === null) return;
    const trip = finish(builder, open, options);
    if (trip === null) discardedMiles += builder.miles;
    else trips.push(trip);
    builder = null;
  };

  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (previous === undefined || current === undefined) continue;

    const movement = measure(previous, current, options);
    if (movement.source === 'odometer') odometerMiles += movement.miles;

    const moved = movement.miles > options.odometerEpsilonMiles;
    const acrossGap = movement.gapSeconds > options.maxGapSeconds;

    if (moved && acrossGap) {
      // The car moved while we were not watching. If it is still under way at
      // this reading, the drive is simply continuing and the gap is part of it;
      // otherwise it has already arrived somewhere and this stands alone. Either
      // way the result is marked inferred, because the route in between is not
      // known — only the miles, which come from the odometer.
      if (reportsDriving(current)) {
        if (builder === null) {
          builder = {
            start: previous,
            end: current,
            miles: movement.miles,
            inferred: true,
            source: movement.source,
            lastMovementAt: current.at,
          };
        } else {
          builder.end = current;
          builder.miles += movement.miles;
          builder.inferred = true;
          builder.lastMovementAt = current.at;
          if (movement.source === 'estimated') builder.source = 'estimated';
        }
        continue;
      }

      close(false);
      const jump: Builder = {
        start: previous,
        end: current,
        miles: movement.miles,
        inferred: true,
        source: movement.source,
        lastMovementAt: current.at,
      };
      const trip = finish(jump, false, options);
      if (trip === null) discardedMiles += movement.miles;
      else trips.push(trip);
      continue;
    }

    if (moved) {
      if (builder === null) {
        builder = {
          start: previous,
          end: current,
          miles: movement.miles,
          inferred: false,
          source: movement.source,
          lastMovementAt: current.at,
        };
      } else {
        builder.end = current;
        builder.miles += movement.miles;
        builder.lastMovementAt = current.at;
        if (movement.source === 'estimated') builder.source = 'estimated';
      }
      continue;
    }

    if (builder === null) continue;

    // Standing still. Close the trip once the car has been settled long enough,
    // or immediately if it reports Park — that is an unambiguous arrival.
    const settledFor = seconds(builder.lastMovementAt, current.at);
    const parked = (current.shiftState ?? '').toUpperCase() === 'P';
    if (parked || settledFor >= options.parkGraceSeconds) close(false);
  }

  if (builder !== null) {
    const last = samples[samples.length - 1];
    const stillDriving =
      last !== undefined &&
      (reportsDriving(last) || seconds(builder.lastMovementAt, last.at) < options.parkGraceSeconds);
    close(stillDriving);
  }

  return {
    trips,
    discardedMiles: Math.round(discardedMiles * 1000) / 1000,
    odometerMiles: Math.round(odometerMiles * 1000) / 1000,
  };
}
