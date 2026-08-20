/**
 * Entry point.
 *
 * Starts the poller and the web server, prints where to find the app, and shuts
 * both down cleanly. There is nothing else to run: no database server, no queue,
 * no build step.
 */
import { createApp } from './app.ts';
import { createHttpServer } from './web/server.ts';
import { hasPasscode } from './web/auth.ts';
import { seedDemoData } from './tesla/demo.ts';
import { reclassifyAll } from './domain/pipeline.ts';
import { SETTING_KEYS } from './settings.ts';
import { config } from './config.ts';
import { log } from './lib/log.ts';

const app = createApp();

if (process.argv.includes('--seed-demo')) {
  app.db.putSetting(SETTING_KEYS.connector, 'demo');
  app.rewireConnector();
  const seeded = seedDemoData(app.db, { timezone: app.settings().timezone });
  reclassifyAll(app.db);
  log.info(`demo history ready: ${seeded.trips} trips from ${seeded.samples} readings`);
}

const server = createHttpServer(app);

server.listen(config.port, config.host, () => {
  const settings = app.settings();
  const where = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  log.info(`Mile Ledger is running at ${where}`);
  log.info(`ledger file: ${config.dbPath}`);
  log.info(`time zone: ${settings.timezone} · vehicle data: ${settings.connector}`);
  if (!hasPasscode(app.db)) {
    const local = config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1';
    log.info(
      local
        ? 'no passcode set — only this machine can open the app. Set one in Settings before exposing it to your network.'
        : 'no passcode set and listening beyond this machine: every request will be refused until you set MILE_LEDGER_PASSCODE.',
    );
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  app.poller.stop();
  server.close(() => {
    app.db.close();
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A background failure must not take the ledger offline. Requests are each
// wrapped in their own handler, and the poller retries on a backoff, so the
// useful thing to do with a stray error is record it and keep serving.
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
process.on('uncaughtException', (error) => {
  log.error('uncaught exception — the app is still serving; please report this', error);
});
