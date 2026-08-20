/**
 * The poller: how often to ask the car where it is.
 *
 * This is the part that decides whether the app is free to run. Reading a car
 * that is parked or asleep is served from Tesla's cache and costs nothing, so
 * the expensive reads are spent only while the car is actually moving — and even
 * then, inside a monthly ceiling the owner sets. If that ceiling is reached the
 * poller keeps recording, just coarsely: the odometer still reconciles, and the
 * affected trips are marked as reconstructed rather than silently approximated.
 *
 * It never sends a wake command. A sleeping car is left alone.
 */
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import type { Connector, VehicleIdentity } from './types.ts';
import { readSettings } from '../settings.ts';
import { ingestSamples, pruneOldSamples, rebuildTrips, reclassifyAll } from '../domain/pipeline.ts';
import { enrichAddresses } from './geocode.ts';
import { localMonth, nowIso } from '../lib/time.ts';
import { log } from '../lib/log.ts';
import { config } from '../config.ts';

export type BudgetState = 'ok' | 'tight' | 'exhausted';

export function budgetState(used: number, budget: number): BudgetState {
  if (budget <= 0) return 'ok';
  if (used >= budget) return 'exhausted';
  if (used >= budget * 0.85) return 'tight';
  return 'ok';
}

export type VehicleActivity = 'driving' | 'awake' | 'asleep';

export function activityOf(reading: {
  shiftState: string | null;
  speedMph: number | null;
  state: string | null;
}): VehicleActivity {
  const shift = (reading.shiftState ?? '').toUpperCase();
  if (shift === 'D' || shift === 'R' || shift === 'N') return 'driving';
  if ((reading.speedMph ?? 0) > 1) return 'driving';
  if ((reading.state ?? '').toLowerCase() === 'online') return 'awake';
  return 'asleep';
}

/**
 * How long to wait before the next read.
 *
 * A moving car is worth close attention; a parked one is not. When the budget is
 * tight the awake cadence relaxes toward the asleep cadence, and when it is
 * spent everything falls back to a slow, cache-only rhythm.
 */
export function nextDelaySeconds(
  activity: VehicleActivity,
  budget: BudgetState,
  settings: { pollDrivingSeconds: number; pollAwakeSeconds: number; pollAsleepSeconds: number },
): number {
  if (budget === 'exhausted') return Math.max(settings.pollAsleepSeconds, 1800);
  if (activity === 'driving') {
    return budget === 'tight' ? settings.pollDrivingSeconds * 3 : settings.pollDrivingSeconds;
  }
  if (activity === 'awake') {
    return budget === 'tight' ? settings.pollAwakeSeconds * 2 : settings.pollAwakeSeconds;
  }
  return settings.pollAsleepSeconds;
}

export type TickOutcome = {
  at: string;
  polled: number;
  stored: number;
  tripsCreated: number;
  creditsSpent: number;
  activity: VehicleActivity;
  budget: BudgetState;
  nextInSeconds: number;
  messages: string[];
};

export class Poller {
  private readonly db: Database;
  private connector: Connector;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private vehicles: VehicleIdentity[] = [];
  private vehiclesFetchedAt = 0;
  private lastOutcome: TickOutcome | null = null;
  private ticks = 0;

  constructor(db: Database, connector: Connector) {
    this.db = db;
    this.connector = connector;
  }

  status(): { running: boolean; last: TickOutcome | null; connector: string } {
    return { running: !this.stopped, last: this.lastOutcome, connector: this.connector.name };
  }

  useConnector(connector: Connector): void {
    this.connector = connector;
    this.vehicles = [];
    this.vehiclesFetchedAt = 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    log.info(`poller started using the ${this.connector.name} connector`);
    this.schedule(1);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(seconds: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().catch((error: unknown) => log.error('poll failed', error));
    }, Math.max(1, seconds) * 1000);
    // Do not hold the process open just for the next poll.
    this.timer.unref?.();
  }

  /** Read every vehicle once, store what came back, and reschedule. */
  async tick(): Promise<TickOutcome> {
    if (this.running) {
      return (
        this.lastOutcome ?? {
          at: nowIso(),
          polled: 0,
          stored: 0,
          tripsCreated: 0,
          creditsSpent: 0,
          activity: 'asleep',
          budget: 'ok',
          nextInSeconds: 60,
          messages: ['a poll was already in progress'],
        }
      );
    }
    this.running = true;
    const messages: string[] = [];
    const settings = readSettings(this.db);
    const month = localMonth(nowIso(), settings.timezone);
    let creditsSpent = 0;
    let stored = 0;
    let tripsCreated = 0;
    let activity: VehicleActivity = 'asleep';

    try {
      const used = repo.creditsUsed(this.db, month);
      let budget = budgetState(used, settings.creditBudget);
      if (budget === 'exhausted') {
        messages.push(
          `This month's estimated Tesla API usage (${used} credits) has reached your ceiling of ${settings.creditBudget}. Still recording, just less often.`,
        );
      }

      if (this.vehicles.length === 0 || Date.now() - this.vehiclesFetchedAt > 6 * 3600_000) {
        this.vehicles = await this.connector.listVehicles();
        this.vehiclesFetchedAt = Date.now();
      }

      for (const identity of this.vehicles) {
        const vehicle = repo.upsertVehicle(this.db, {
          vin: identity.vin,
          teslaId: identity.teslaId,
          displayName: identity.displayName,
          model: identity.model,
        });

        const result = await this.connector.read(identity);
        creditsSpent += result.creditsSpent;

        if (!result.ok) {
          if (result.reason === 'asleep') {
            repo.updateVehicleStatus(this.db, vehicle.id, { state: 'asleep' });
          } else {
            messages.push(`${identity.displayName}: ${result.detail}`);
          }
          continue;
        }

        stored += ingestSamples(this.db, [
          {
            vehicleId: vehicle.id,
            at: result.reading.at,
            odometerMiles: result.reading.odometerMiles,
            latitude: result.reading.latitude,
            longitude: result.reading.longitude,
            shiftState: result.reading.shiftState,
            speedMph: result.reading.speedMph,
            state: result.reading.state,
            chargingState: result.reading.chargingState,
            batteryLevel: result.reading.batteryLevel,
            cached: result.reading.cached,
            source: this.connector.name,
          },
        ]);

        const rebuilt = rebuildTrips(this.db, vehicle.id);
        tripsCreated += rebuilt.created;

        const vehicleActivity = activityOf(result.reading);
        if (vehicleActivity === 'driving') activity = 'driving';
        else if (vehicleActivity === 'awake' && activity !== 'driving') activity = 'awake';
      }

      budget = budgetState(repo.creditsUsed(this.db, month), settings.creditBudget);

      // Housekeeping, spread out so a poll stays quick.
      this.ticks += 1;
      if (settings.geocodeEnabled && this.ticks % 2 === 0) {
        const resolved = await enrichAddresses(this.db, {
          contact: config.geocodeContact,
          limit: 4,
        });
        if (resolved > 0) reclassifyAll(this.db);
      }
      if (this.ticks % 240 === 0) pruneOldSamples(this.db);

      const nextInSeconds = nextDelaySeconds(activity, budget, settings);
      const outcome: TickOutcome = {
        at: nowIso(),
        polled: this.vehicles.length,
        stored,
        tripsCreated,
        creditsSpent,
        activity,
        budget,
        nextInSeconds,
        messages,
      };
      this.lastOutcome = outcome;
      this.schedule(nextInSeconds);
      return outcome;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      messages.push(detail);
      log.warn('poll error', detail);
      const outcome: TickOutcome = {
        at: nowIso(),
        polled: 0,
        stored,
        tripsCreated,
        creditsSpent,
        activity,
        budget: 'ok',
        // Back off after a failure; a broken token should not become a hot loop.
        nextInSeconds: Math.max(settings.pollAwakeSeconds, 300),
        messages,
      };
      this.lastOutcome = outcome;
      this.schedule(outcome.nextInSeconds);
      return outcome;
    } finally {
      this.running = false;
    }
  }
}
