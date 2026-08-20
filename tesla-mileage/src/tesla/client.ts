/**
 * Talking to Tesla.
 *
 * Two shapes of the same conversation are supported:
 *
 *   fleet — Tesla's official Fleet API. Needs a developer app and a domain you
 *           control. Usage is metered; the monthly allowance Tesla includes is
 *           enough for one personal car if the app is careful, which is what the
 *           poller's budget governor exists to guarantee.
 *
 *   owner — the older owner API that community tools have used for years. No
 *           app registration, but it is not an officially supported interface
 *           and Tesla can change it without notice.
 *
 * Two rules hold in both modes, and they are what keep this free:
 *   1. Never send a wake command. Waking a car is the single most expensive
 *      call there is, and a sleeping car still reports its odometer from cache.
 *   2. Read no more often than the situation needs. Cadence is decided by the
 *      poller, not here.
 */
import type { Connector, ReadResult, Reading, VehicleIdentity } from './types.ts';
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import { nowIso } from '../lib/time.ts';
import { log } from '../lib/log.ts';

export const FLEET_AUTH_BASE = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3';
export const OWNER_AUTH_BASE = 'https://auth.tesla.com/oauth2/v3';
export const OWNER_API_BASE = 'https://owner-api.teslamotors.com';

/** Regional Fleet API hosts. Tesla routes accounts to one region. */
export const FLEET_REGIONS: Record<string, string> = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn',
};

/**
 * Credit costs, as an estimate only.
 *
 * Tesla's billing page is the authority and these numbers can change; they are
 * here so the app can hold itself to a budget, and every screen that shows them
 * says "estimated". A response served from Tesla's cache is not billed, which is
 * why the poller leans on cached reads whenever the car is not moving.
 */
export const CREDIT_COST = {
  vehicleDataFresh: 2,
  vehicleDataCached: 0,
  vehicleList: 0,
  wake: 20,
};

/** A reading older than this is treated as a cached snapshot, not a live read. */
const CACHE_STALENESS_MS = 120_000;

/**
 * Give up on a request rather than let it hang.
 *
 * Without this a stalled connection would leave the poller's in-flight flag set
 * forever, and the app would quietly stop recording — the worst possible failure
 * mode for a mileage log, because nothing looks broken.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export type TeslaMode = 'fleet' | 'owner';

export type TeslaCredentials = {
  mode: TeslaMode;
  clientId: string;
  clientSecret: string;
  apiBase: string;
  authBase: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickNumber(source: unknown, key: string): number | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Tesla sends epoch milliseconds; some fields send seconds. Normalize both. */
function epochToIso(value: number | null): string | null {
  if (value === null) return null;
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Shape a `vehicle_data` payload into a reading. */
export function parseVehicleData(payload: unknown, receivedAt = nowIso()): Reading | null {
  if (!isRecord(payload)) return null;
  const response = isRecord(payload.response) ? payload.response : payload;
  const drive = response.drive_state;
  const vehicle = response.vehicle_state;
  const charge = response.charge_state;

  const odometer = pickNumber(vehicle, 'odometer');
  const latitude = pickNumber(drive, 'latitude') ?? pickNumber(drive, 'native_latitude');
  const longitude = pickNumber(drive, 'longitude') ?? pickNumber(drive, 'native_longitude');

  const dataStamp =
    epochToIso(pickNumber(drive, 'timestamp')) ?? epochToIso(pickNumber(vehicle, 'timestamp'));
  const at = dataStamp ?? receivedAt;
  const cached = dataStamp !== null && Date.now() - new Date(dataStamp).getTime() > CACHE_STALENESS_MS;

  if (odometer === null && latitude === null) return null;

  return {
    at,
    odometerMiles: odometer,
    latitude,
    longitude,
    shiftState: pickString(drive, 'shift_state'),
    speedMph: pickNumber(drive, 'speed'),
    state: pickString(response, 'state'),
    chargingState: pickString(charge, 'charging_state'),
    batteryLevel: pickNumber(charge, 'battery_level'),
    cached,
  };
}

export class TeslaClient implements Connector {
  readonly name: string;
  private readonly db: Database;
  private readonly credentials: TeslaCredentials;
  private readonly timezone: string;
  private accessToken: string | null = null;
  private accessExpiresAt = 0;

  constructor(db: Database, credentials: TeslaCredentials, timezone: string) {
    this.db = db;
    this.credentials = credentials;
    this.timezone = timezone;
    this.name = credentials.mode;
  }

  private record(endpoint: string, credits: number, cached: boolean, ok: boolean, detail?: string): void {
    repo.recordUsage(this.db, { endpoint, credits, cached, ok, detail }, this.timezone);
  }

  /** Exchange the stored refresh token for a usable access token. */
  private async authorize(): Promise<string> {
    if (this.accessToken !== null && Date.now() < this.accessExpiresAt - 60_000) {
      return this.accessToken;
    }

    const stored = repo.getToken(this.db, this.credentials.mode);
    if (stored?.refreshToken === null || stored?.refreshToken === undefined) {
      throw new Error('not connected to Tesla yet — no refresh token stored');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.credentials.clientId,
      refresh_token: stored.refreshToken,
    });
    if (this.credentials.mode === 'owner') body.set('scope', 'openid email offline_access');

    const response = await fetch(`${this.credentials.authBase}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text();
      this.record('oauth/token', 0, false, false, `${response.status} ${detail.slice(0, 200)}`);
      throw new Error(`token refresh failed (${response.status})`);
    }

    const json: unknown = await response.json();
    const access = pickString(json, 'access_token');
    const refresh = pickString(json, 'refresh_token');
    const expiresIn = pickNumber(json, 'expires_in') ?? 28_800;
    if (access === null) throw new Error('token refresh returned no access token');

    this.accessToken = access;
    this.accessExpiresAt = Date.now() + expiresIn * 1000;
    repo.saveToken(this.db, {
      provider: this.credentials.mode,
      accessToken: access,
      // Tesla rotates the refresh token; keep the newest one.
      refreshToken: refresh ?? stored.refreshToken,
      expiresAt: new Date(this.accessExpiresAt).toISOString(),
      region: stored.region,
      scope: pickString(json, 'scope') ?? stored.scope,
    });
    this.record('oauth/token', 0, false, true);
    return access;
  }

  private async call(path: string): Promise<{ status: number; json: unknown; text: string }> {
    const token = await this.authorize();
    const response = await fetch(`${this.credentials.apiBase}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  async listVehicles(): Promise<VehicleIdentity[]> {
    const { status, json, text } = await this.call('/api/1/vehicles');
    if (status !== 200) {
      this.record('vehicles', CREDIT_COST.vehicleList, false, false, `${status} ${text.slice(0, 200)}`);
      throw new Error(`could not list vehicles (${status})`);
    }
    this.record('vehicles', CREDIT_COST.vehicleList, false, true);

    const list = isRecord(json) && Array.isArray(json.response) ? json.response : [];
    return list.filter(isRecord).map((entry) => ({
      teslaId: String(entry.id ?? entry.vehicle_id ?? entry.id_s ?? ''),
      vin: pickString(entry, 'vin'),
      displayName: pickString(entry, 'display_name') ?? 'Tesla',
      model: pickString(entry, 'model') ?? null,
      state: pickString(entry, 'state'),
    }));
  }

  /**
   * Read one vehicle.
   *
   * A sleeping car answers with 408 on the owner API and with cached data on the
   * Fleet API. Both are fine: neither costs a wake, and the odometer in a cached
   * reading is still the odometer.
   */
  async read(vehicle: VehicleIdentity): Promise<ReadResult> {
    const endpoints = ['location_data', 'drive_state', 'vehicle_state', 'charge_state'].join(';');
    const path = `/api/1/vehicles/${encodeURIComponent(vehicle.teslaId)}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`;

    let status = 0;
    let json: unknown = null;
    let text = '';
    try {
      ({ status, json, text } = await this.call(path));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      this.record('vehicle_data', 0, false, false, detail);
      return {
        ok: false,
        reason: timedOut ? 'error' : 'unauthorized',
        detail: timedOut ? 'Tesla did not answer in time' : detail,
        creditsSpent: 0,
      };
    }

    if (status === 408 || status === 503) {
      // Asleep or briefly unavailable. Not an error, and not billable.
      this.record('vehicle_data', 0, true, true, 'vehicle asleep or unavailable');
      return { ok: false, reason: 'asleep', detail: 'vehicle asleep or unavailable', creditsSpent: 0 };
    }
    if (status === 401 || status === 403) {
      this.accessToken = null;
      this.record('vehicle_data', 0, false, false, `${status}`);
      return { ok: false, reason: 'unauthorized', detail: `Tesla rejected the token (${status})`, creditsSpent: 0 };
    }
    if (status === 429) {
      this.record('vehicle_data', 0, false, false, 'rate limited');
      return { ok: false, reason: 'rate_limited', detail: 'Tesla rate limited this app', creditsSpent: 0 };
    }
    if (status !== 200) {
      this.record('vehicle_data', 0, false, false, `${status} ${text.slice(0, 200)}`);
      return { ok: false, reason: 'error', detail: `unexpected status ${status}`, creditsSpent: 0 };
    }

    const reading = parseVehicleData(json);
    if (reading === null) {
      this.record('vehicle_data', 0, false, false, 'response had no usable data');
      return { ok: false, reason: 'error', detail: 'response had no usable data', creditsSpent: 0 };
    }

    const credits = reading.cached ? CREDIT_COST.vehicleDataCached : CREDIT_COST.vehicleDataFresh;
    this.record('vehicle_data', credits, reading.cached, true);
    return { ok: true, reading, creditsSpent: credits };
  }
}

export function credentialsFor(
  mode: TeslaMode,
  options: { clientId: string; clientSecret: string; region: string },
): TeslaCredentials {
  if (mode === 'owner') {
    return {
      mode,
      clientId: 'ownerapi',
      clientSecret: '',
      apiBase: OWNER_API_BASE,
      authBase: OWNER_AUTH_BASE,
    };
  }
  const apiBase = FLEET_REGIONS[options.region] ?? FLEET_REGIONS.na ?? '';
  return {
    mode,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    apiBase,
    authBase: FLEET_AUTH_BASE,
  };
}

/** Store a refresh token obtained elsewhere (the paste-a-token path). */
export function storeRefreshToken(
  db: Database,
  mode: TeslaMode,
  refreshToken: string,
  region: string,
): void {
  repo.saveToken(db, {
    provider: mode,
    accessToken: null,
    refreshToken,
    expiresAt: null,
    region,
    scope: null,
  });
  db.audit('owner', 'tesla.token.store', 'token', mode);
  log.info(`stored a Tesla refresh token for the ${mode} connector`);
}
