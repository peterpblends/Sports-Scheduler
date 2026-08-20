/**
 * The running application: one database, one connector, one poller. Everything
 * else is a function of these.
 */
import { openDatabase, setDatabase, type Database } from './db/index.ts';
import * as repo from './db/repo.ts';
import { readSettings, SETTING_KEYS, type AppSettings } from './settings.ts';
import { config } from './config.ts';
import { credentialsFor, TeslaClient } from './tesla/client.ts';
import { DemoConnector } from './tesla/demo.ts';
import { Poller } from './tesla/poller.ts';
import type { Connector } from './tesla/types.ts';
import { nowIso } from './lib/time.ts';
import { log } from './lib/log.ts';

export type App = {
  db: Database;
  poller: Poller;
  settings: () => AppSettings;
  rewireConnector: () => void;
};

const DEMO_START_KEY = 'demo_start_iso';

/** Build the connector the settings ask for, or null when reading is off. */
export function makeConnector(db: Database, settings: AppSettings): Connector | null {
  if (settings.connector === 'demo') {
    let start = db.setting(DEMO_START_KEY);
    if (start === undefined) {
      start = new Date(Date.now() - 42 * 86_400_000).toISOString();
      db.putSetting(DEMO_START_KEY, start);
    }
    return new DemoConnector({ timezone: settings.timezone, startIso: start });
  }

  if (settings.connector === 'fleet' || settings.connector === 'owner') {
    const stored = repo.getToken(db, settings.connector);
    if (stored === null || stored.refreshToken === null) {
      log.warn(`the ${settings.connector} connector is selected but no token is stored yet`);
      return null;
    }
    return new TeslaClient(
      db,
      credentialsFor(settings.connector, {
        clientId: config.tesla.clientId,
        clientSecret: config.tesla.clientSecret,
        region: stored.region ?? 'na',
      }),
      settings.timezone,
    );
  }

  return null;
}

/** A connector that does nothing, so the poller can exist before setup. */
const IDLE_CONNECTOR: Connector = {
  name: 'manual',
  listVehicles: () => Promise.resolve([]),
  read: () => Promise.resolve({ ok: false, reason: 'error', detail: 'no connector configured', creditsSpent: 0 }),
};

export function createApp(): App {
  const db = openDatabase(config.dbPath);
  setDatabase(db);
  repo.seedRates(db);

  if (db.setting(SETTING_KEYS.timezone) === undefined) {
    db.putSetting(SETTING_KEYS.timezone, config.timezone);
  }
  if (config.baseUrl !== '') db.putSetting('base_url', config.baseUrl);
  if (db.setting('installed_at') === undefined) db.putSetting('installed_at', nowIso());

  const settings = () => readSettings(db);
  const initial = makeConnector(db, settings());
  const poller = new Poller(db, initial ?? IDLE_CONNECTOR);

  const rewireConnector = (): void => {
    const current = settings();
    const connector = makeConnector(db, current);
    poller.useConnector(connector ?? IDLE_CONNECTOR);
    if (connector === null) {
      poller.stop();
      log.info('no vehicle connector configured; live reading is off');
    } else {
      poller.start();
    }
  };

  if (initial !== null) poller.start();

  return { db, poller, settings, rewireConnector };
}
