/**
 * A simulated car.
 *
 * This exists so the app can be opened, driven around, exported, and handed to
 * an accountant to look at before any Tesla is connected — and so the whole
 * pipeline can be exercised without spending a single API credit. The pattern is
 * an ordinary working week: a commute, a couple of client stops, an errand on
 * Saturday.
 */
import type { Connector, ReadResult, Reading, VehicleIdentity } from './types.ts';
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import { haversineMeters, metersToMiles } from '../lib/geo.ts';
import { partsInZone, zonedToUtcIso } from '../lib/time.ts';
import { rebuildTrips } from '../domain/pipeline.ts';
import { log } from '../lib/log.ts';

type Spot = { name: string; latitude: number; longitude: number; city: string; region: string };

export const DEMO_SPOTS: Record<string, Spot> = {
  home: { name: 'Home', latitude: 46.8772, longitude: -96.7898, city: 'Fargo', region: 'North Dakota' },
  office: { name: 'Main Office', latitude: 46.8654, longitude: -96.8291, city: 'Fargo', region: 'North Dakota' },
  northport: { name: 'Northport Job Site', latitude: 46.9022, longitude: -96.8009, city: 'Fargo', region: 'North Dakota' },
  supply: { name: 'Moorhead Supply', latitude: 46.8738, longitude: -96.742, city: 'Moorhead', region: 'Minnesota' },
  westFargo: { name: 'West Fargo Warehouse', latitude: 46.8747, longitude: -96.9003, city: 'West Fargo', region: 'North Dakota' },
  grocery: { name: 'Cash Wise Grocery', latitude: 46.86, longitude: -96.77, city: 'Fargo', region: 'North Dakota' },
};

type Leg = { fromMinute: number; toMinute: number; from: Spot; to: Spot };

const S = DEMO_SPOTS;

/** Legs for a given weekday, in local minutes since midnight. */
function planFor(weekday: number, dayIndex: number): Leg[] {
  if (weekday === 0) return []; // Sunday: the car stays put.
  if (weekday === 6) {
    return [
      { fromMinute: 10 * 60, toMinute: 10 * 60 + 12, from: S.home as Spot, to: S.grocery as Spot },
      { fromMinute: 11 * 60, toMinute: 11 * 60 + 12, from: S.grocery as Spot, to: S.home as Spot },
    ];
  }

  // Alternate the mid-day stops so the ledger has some variety in it.
  const midday = dayIndex % 3 === 0 ? (S.westFargo as Spot) : (S.supply as Spot);
  return [
    { fromMinute: 7 * 60 + 45, toMinute: 8 * 60 + 5, from: S.home as Spot, to: S.office as Spot },
    { fromMinute: 9 * 60 + 30, toMinute: 9 * 60 + 52, from: S.office as Spot, to: S.northport as Spot },
    { fromMinute: 12 * 60 + 15, toMinute: 12 * 60 + 40, from: S.northport as Spot, to: midday },
    { fromMinute: 14 * 60 + 30, toMinute: 14 * 60 + 55, from: midday, to: S.office as Spot },
    { fromMinute: 17 * 60 + 20, toMinute: 17 * 60 + 40, from: S.office as Spot, to: S.home as Spot },
  ];
}

/** Road miles for a leg: straight line plus the usual detour factor. */
function legMiles(leg: Leg): number {
  const straight = metersToMiles(haversineMeters(leg.from, leg.to));
  return Math.round(straight * 1.18 * 10) / 10;
}

function dayKey(iso: string, tz: string): { year: number; month: number; day: number; weekday: number } {
  const parts = partsInZone(iso, tz);
  return { year: parts.year, month: parts.month, day: parts.day, weekday: parts.weekday };
}

function minutesInto(iso: string, tz: string): number {
  const parts = partsInZone(iso, tz);
  return parts.hour * 60 + parts.minute + parts.second / 60;
}

/** Interpolate a position along a leg. */
function between(leg: Leg, fraction: number): { latitude: number; longitude: number } {
  const clamped = Math.min(1, Math.max(0, fraction));
  return {
    latitude: leg.from.latitude + (leg.to.latitude - leg.from.latitude) * clamped,
    longitude: leg.from.longitude + (leg.to.longitude - leg.from.longitude) * clamped,
  };
}

export type DemoState = {
  at: string;
  latitude: number;
  longitude: number;
  odometerMiles: number;
  shiftState: string;
  speedMph: number;
  driving: boolean;
};

/**
 * Where the simulated car is at a given instant, and what its odometer reads.
 * Deterministic: the same instant always produces the same state, so restarting
 * the app never rewrites history.
 */
export function demoStateAt(
  iso: string,
  options: { timezone: string; startIso: string; startOdometer: number },
): DemoState {
  const { timezone, startIso, startOdometer } = options;
  let odometer = startOdometer;
  let position = { latitude: (S.home as Spot).latitude, longitude: (S.home as Spot).longitude };
  let shift = 'P';
  let speed = 0;
  let driving = false;

  const startDay = dayKey(startIso, timezone);
  let cursor = zonedToUtcIso(startDay.year, startDay.month, startDay.day, 0, 0, 0, timezone);
  const targetMs = new Date(iso).getTime();
  let dayIndex = 0;

  // Walk day by day, accumulating miles until we reach the instant asked for.
  while (new Date(cursor).getTime() <= targetMs && dayIndex < 4000) {
    const key = dayKey(cursor, timezone);
    const legs = planFor(key.weekday, dayIndex);
    const sameDay = dayKey(iso, timezone);
    const isTargetDay =
      key.year === sameDay.year && key.month === sameDay.month && key.day === sameDay.day;

    for (const leg of legs) {
      const miles = legMiles(leg);
      if (!isTargetDay) {
        odometer += miles;
        position = { latitude: leg.to.latitude, longitude: leg.to.longitude };
        continue;
      }

      const minute = minutesInto(iso, timezone);
      if (minute >= leg.toMinute) {
        odometer += miles;
        position = { latitude: leg.to.latitude, longitude: leg.to.longitude };
        continue;
      }
      if (minute > leg.fromMinute) {
        const fraction = (minute - leg.fromMinute) / (leg.toMinute - leg.fromMinute);
        odometer += Math.round(miles * fraction * 100) / 100;
        position = between(leg, fraction);
        shift = 'D';
        speed = Math.round((miles / ((leg.toMinute - leg.fromMinute) / 60)) * 10) / 10;
        driving = true;
        break;
      }
      // Not departed yet: sitting at the origin of this leg.
      position = { latitude: leg.from.latitude, longitude: leg.from.longitude };
      break;
    }

    if (isTargetDay) break;
    const next = new Date(new Date(cursor).getTime() + 26 * 3600_000);
    const nextKey = dayKey(next.toISOString(), timezone);
    cursor = zonedToUtcIso(nextKey.year, nextKey.month, nextKey.day, 0, 0, 0, timezone);
    dayIndex += 1;
  }

  return {
    at: iso,
    latitude: Math.round(position.latitude * 1e6) / 1e6,
    longitude: Math.round(position.longitude * 1e6) / 1e6,
    odometerMiles: Math.round(odometer * 100) / 100,
    shiftState: shift,
    speedMph: speed,
    driving,
  };
}

export const DEMO_IDENTITY: VehicleIdentity = {
  teslaId: 'demo-1',
  vin: '5YJ3DEMO000000001',
  displayName: 'Demo Model Y',
  model: 'model3',
  state: 'online',
};

export class DemoConnector implements Connector {
  readonly name = 'demo';
  private readonly timezone: string;
  private readonly startIso: string;
  private readonly startOdometer: number;

  constructor(options: { timezone: string; startIso: string; startOdometer?: number }) {
    this.timezone = options.timezone;
    this.startIso = options.startIso;
    this.startOdometer = options.startOdometer ?? 12_480;
  }

  listVehicles(): Promise<VehicleIdentity[]> {
    return Promise.resolve([DEMO_IDENTITY]);
  }

  read(): Promise<ReadResult> {
    const state = demoStateAt(new Date().toISOString(), {
      timezone: this.timezone,
      startIso: this.startIso,
      startOdometer: this.startOdometer,
    });
    const reading: Reading = {
      at: state.at,
      odometerMiles: state.odometerMiles,
      latitude: state.latitude,
      longitude: state.longitude,
      shiftState: state.shiftState,
      speedMph: state.speedMph,
      state: 'online',
      chargingState: state.driving ? 'Disconnected' : 'Complete',
      batteryLevel: 72,
      cached: false,
    };
    return Promise.resolve({ ok: true, reading, creditsSpent: 0 });
  }
}

/**
 * Fill the ledger with a few weeks of plausible history, plus the labeled places
 * that make the classification visible. Existing places are left alone.
 */
export function seedDemoData(
  db: Database,
  options: { timezone: string; days?: number },
): { samples: number; trips: number } {
  const days = options.days ?? 42;
  const timezone = options.timezone;
  const vehicle = repo.upsertVehicle(db, {
    vin: DEMO_IDENTITY.vin,
    teslaId: DEMO_IDENTITY.teslaId,
    displayName: DEMO_IDENTITY.displayName,
    model: DEMO_IDENTITY.model,
  });

  const startIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const existing = new Map(repo.listPlaces(db).map((place) => [place.name, place]));

  const wanted: {
    spot: Spot;
    label: 'business' | 'personal';
    isHome?: boolean;
    isPrimaryOffice?: boolean;
    purpose?: string;
    client?: string;
    radius?: number;
  }[] = [
    { spot: S.home as Spot, label: 'personal', isHome: true },
    { spot: S.office as Spot, label: 'business', isPrimaryOffice: true, purpose: 'Office' },
    { spot: S.northport as Spot, label: 'business', purpose: 'Site supervision', client: 'Northport LLC' },
    { spot: S.supply as Spot, label: 'business', purpose: 'Materials pickup', client: 'Moorhead Supply' },
    { spot: S.grocery as Spot, label: 'personal' },
  ];

  for (const entry of wanted) {
    if (existing.has(entry.spot.name)) continue;
    repo.createPlace(db, {
      name: entry.spot.name,
      kind: 'address',
      label: entry.label,
      purpose: entry.purpose ?? null,
      client: entry.client ?? null,
      address: null,
      city: entry.spot.city,
      region: entry.spot.region,
      postal: null,
      latitude: entry.spot.latitude,
      longitude: entry.spot.longitude,
      radiusMeters: entry.radius ?? 250,
      isHome: entry.isHome ?? false,
      isPrimaryOffice: entry.isPrimaryOffice ?? false,
      notes: 'Created by the demo data seeder',
    });
  }

  // Note the West Fargo stop is deliberately left unlabeled, so the review
  // queue and the learning suggestions have something real to work on.

  let samples = 0;
  const startOdometer = 12_480;
  const stepMinutes = 5;
  const from = new Date(startIso).getTime();
  const to = Date.now();

  db.transaction(() => {
    for (let ms = from; ms <= to; ms += stepMinutes * 60_000) {
      const iso = new Date(ms).toISOString();
      const state = demoStateAt(iso, { timezone, startIso, startOdometer });
      // Skip the long parked stretches overnight to keep the table small; a real
      // poller does the same thing by backing off when the car is asleep.
      const parts = partsInZone(iso, timezone);
      if (!state.driving && (parts.hour < 6 || parts.hour > 20) && parts.minute !== 0) continue;

      const inserted = repo.insertSample(db, {
        vehicleId: vehicle.id,
        at: iso,
        odometerMiles: state.odometerMiles,
        latitude: state.latitude,
        longitude: state.longitude,
        shiftState: state.shiftState,
        speedMph: state.driving ? state.speedMph : null,
        state: 'online',
        chargingState: state.driving ? 'Disconnected' : 'Complete',
        batteryLevel: 72,
        cached: false,
        source: 'demo',
      });
      if (inserted) samples += 1;
    }
  });

  const rebuilt = rebuildTrips(db, vehicle.id, startIso);
  log.info(`demo data seeded: ${samples} readings, ${rebuilt.created} trips`);
  return { samples, trips: rebuilt.created };
}
