/**
 * Runtime configuration. Everything has a working default so the app boots with
 * no setup at all; anything sensitive comes from the environment (or a .env file
 * sitting next to this project, which is loaded below without a dependency).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..');

/** Default port. 8730 is unassigned and easy to remember as "87-30". */
const DEFAULT_PORT = 8730;

/** Minimal .env loader: `KEY=value` lines, `#` comments, optional quotes. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(join(projectRoot, '.env'));

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Which source of vehicle data the poller should use. */
export type ConnectorName = 'fleet' | 'owner' | 'demo' | 'manual';

function connector(): ConnectorName {
  const v = str('MILE_LEDGER_CONNECTOR', 'manual').toLowerCase();
  if (v === 'fleet' || v === 'owner' || v === 'demo' || v === 'manual') return v;
  return 'manual';
}

export const config = {
  port: int('PORT', DEFAULT_PORT),
  host: str('MILE_LEDGER_HOST', '127.0.0.1'),
  dbPath: resolve(str('MILE_LEDGER_DB', join(projectRoot, 'data', 'mileage.db'))),
  /** Used to build absolute links (CPA share link, OAuth redirect). */
  baseUrl: str('MILE_LEDGER_BASE_URL', ''),
  timezone: str('MILE_LEDGER_TZ', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  connector: connector(),
  passcode: str('MILE_LEDGER_PASSCODE', ''),
  /** Secret for signing session cookies and share tokens; generated per install if absent. */
  secret: str('MILE_LEDGER_SECRET', ''),

  tesla: {
    clientId: str('TESLA_CLIENT_ID', ''),
    clientSecret: str('TESLA_CLIENT_SECRET', ''),
    redirectUri: str('TESLA_REDIRECT_URI', ''),
    audience: str('TESLA_AUDIENCE', 'https://fleet-api.prd.na.vn.cloud.tesla.com'),
    refreshToken: str('TESLA_REFRESH_TOKEN', ''),
    scopes: str('TESLA_SCOPES', 'openid offline_access vehicle_device_data vehicle_location'),
  },

  /** Monthly Tesla API credit ceiling the poller will not exceed. */
  creditBudget: int('MILE_LEDGER_CREDIT_BUDGET', 8000),
  /** Reverse geocoding via OpenStreetMap Nominatim (free, rate limited, opt-in). */
  geocode: bool('MILE_LEDGER_GEOCODE', true),
  geocodeContact: str('MILE_LEDGER_GEOCODE_CONTACT', ''),
  logLevel: str('MILE_LEDGER_LOG', 'info'),
};

export type Config = typeof config;
