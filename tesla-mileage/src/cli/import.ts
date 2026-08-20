/**
 * Import a CSV from the command line:
 *   npm run import -- ~/Downloads/teslafi-2026.csv
 *
 * The same importer the web page uses, for people who would rather not paste a
 * large file into a browser.
 */
import { readFileSync } from 'node:fs';
import { createApp } from '../app.ts';
import * as repo from '../db/repo.ts';
import { importCsv } from '../tesla/importer.ts';
import { reclassifyAll } from '../domain/pipeline.ts';
import { log } from '../lib/log.ts';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: npm run import -- <file.csv>\n');
  process.exit(1);
}

const app = createApp();
app.poller.stop();

const settings = app.settings();
const vehicle =
  repo.listVehicles(app.db)[0] ?? repo.upsertVehicle(app.db, { displayName: 'Imported vehicle' });

const report = importCsv(app.db, vehicle.id, readFileSync(file, 'utf8'), {
  timezone: settings.timezone,
  source: 'import',
});
reclassifyAll(app.db);

log.info(
  `read ${report.rowsSeen} rows as ${report.kind}: imported ${report.imported}, skipped ${report.skipped}, ${report.tripsCreated} trips created`,
);
for (const problem of report.problems) log.warn(problem);
app.db.close();
