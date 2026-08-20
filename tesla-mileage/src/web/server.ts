/**
 * The HTTP layer: one route table, plain forms, no client framework.
 *
 * Reads are GETs that render a page; every change is a POST that does the work
 * and redirects back where you were, so the back button and a refresh always
 * behave. Share links are handled first and are strictly read-only.
 */
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import * as repo from '../db/repo.ts';
import { SETTING_KEYS, writeSettings, readSettings } from '../settings.ts';
import { config } from '../config.ts';
import { isClassification, type Classification, type PlaceKind, type PlaceLabel } from '../domain/types.ts';
import type { RuleConditions } from '../domain/classify.ts';
import {
  acceptSuggestion,
  decideTrip,
  pruneOldSamples,
  rebuildTrips,
  reclassifyAll,
} from '../domain/pipeline.ts';
import { summarize } from '../export/summary.ts';
import { backupJson, summaryCsv, tripsCsv } from '../export/csv.ts';
import { renderReport } from '../export/report.ts';
import { importCsv } from '../tesla/importer.ts';
import { seedDemoData } from '../tesla/demo.ts';
import { storeRefreshToken } from '../tesla/client.ts';
import { authorizeUrl, exchangeCode, registerPartnerAccount } from '../tesla/oauth.ts';
import * as auth from './auth.ts';
import { clientKey, RateLimiter, sameOrigin } from './guard.ts';
import { SCRIPT, STYLESHEET, escape } from './ui.ts';
import { dashboardPage, navFor, statusStrip, tripsPage, type ViewContext } from './views.ts';
import {
  connectPage,
  exportPage,
  loginPage,
  morePage,
  placesPage,
  rulesPage,
  settingsPage,
} from './views-manage.ts';
import { resolvePeriod } from './period.ts';
import {
  download,
  html,
  intParam,
  isSecureRequest,
  json,
  notFound,
  parseCookies,
  readForm,
  redirect,
  setCookie,
  text,
  type Ctx,
} from './http.ts';
import { localDate, nowIso } from '../lib/time.ts';
import { log } from '../lib/log.ts';

const PUBLIC_PATHS = new Set(['/login', '/app.css', '/app.js', '/healthz']);

function viewContext(app: App, ctx: Ctx): ViewContext {
  const settings = app.settings();
  const status = app.poller.status();
  return {
    db: app.db,
    settings,
    status: statusStrip(app.db, settings, { running: status.running, connector: status.connector }),
    flash: ctx.query.get('flash'),
    poller: {
      running: status.running,
      connector: status.connector,
      lastAt: status.last?.at ?? null,
      messages: status.last?.messages ?? [],
    },
  };
}

function number(form: URLSearchParams, name: string): number | null {
  const raw = (form.get(name) ?? '').trim();
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(form: URLSearchParams, name: string): string | null {
  const raw = (form.get(name) ?? '').trim();
  return raw === '' ? null : raw;
}

function minutesFromTime(value: string | null): number | undefined {
  if (value === null) return undefined;
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours)) return undefined;
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function classificationFrom(form: URLSearchParams, name = 'classification'): Classification | null {
  const raw = form.get(name);
  return raw !== null && isClassification(raw) ? raw : null;
}

/**
 * Only ever redirect to a path on this app.
 *
 * `//host` is protocol-relative, and browsers normalise a backslash to a slash,
 * so `/\\host` escapes just as well. Control characters can smuggle a newline
 * into the header. Anything but a plain single-slash path is refused.
 */
export function safeReturn(form: URLSearchParams, fallback: string): string {
  const target = form.get('return');
  if (target === null || target === '') return fallback;
  if (!target.startsWith('/')) return fallback;
  if (target.length > 1 && (target[1] === '/' || target[1] === '\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return fallback;
  return target;
}

function periodFromQuery(ctx: Ctx, timezone: string) {
  return resolvePeriod(
    { period: ctx.query.get('period'), from: ctx.query.get('from'), to: ctx.query.get('to') },
    timezone,
  );
}

/**
 * Settings that must never leave the machine in an export. The backup is a file
 * people email to themselves and hand to accountants; the session-signing
 * secret, the passcode hash and any stored credential have no business in it.
 */
const SECRET_SETTING = /secret|passcode|token|credential|password|oauth/i;

export function publishableSettings(all: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (SECRET_SETTING.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

/** Everything the JSON backup contains. */
function backupPayload(app: App): unknown {
  const db = app.db;
  return {
    exportedAt: nowIso(),
    settings: publishableSettings(db.allSettings()),
    vehicles: repo.listVehicles(db, true),
    places: repo.listPlaces(db),
    rules: repo.listRules(db),
    rates: repo.ratePeriods(db),
    trips: repo.tripsForExport(db, {}),
    feedback: repo.listFeedback(db),
    suggestions: repo.listSuggestions(db, 'all'),
  };
}

function reportFor(app: App, period: ReturnType<typeof resolvePeriod>, includePersonal: boolean): string {
  const settings = app.settings();
  const rates = repo.ratePeriods(app.db);
  const trips = repo.tripsForExport(app.db, { from: period.from, to: period.to });
  const summary = summarize(trips, { timezone: settings.timezone, rates });
  return renderReport(trips, summary, {
    timezone: settings.timezone,
    rates,
    businessName: settings.businessName,
    ownerName: settings.ownerName,
    vehicleDescription: settings.vehicleDescription,
    periodLabel: period.label,
    includeDetail: true,
    includePersonal,
    // The report is the owner's document, so it follows their colour choice —
    // which also happens to be the friendlier thing to send to a printer.
    monochrome: settings.colour === 'mono',
  });
}

/** Content hash, computed once, so a browser can revalidate an asset cheaply. */
function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 20)}"`;
}

const ASSETS: Record<string, { body: string; type: string; etag: string }> = {
  '/app.css': { body: STYLESHEET, type: 'text/css; charset=utf-8', etag: etagOf(STYLESHEET) },
  '/app.js': { body: SCRIPT, type: 'text/javascript; charset=utf-8', etag: etagOf(SCRIPT) },
};

export function createHttpServer(app: App): Server {
  // Wrong passcodes, writes, and share-link reads each get their own allowance.
  const loginLimiter = new RateLimiter(8, 5 * 60_000);
  const writeLimiter = new RateLimiter(240, 60_000);
  const shareLimiter = new RateLimiter(120, 60_000);

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log.error('request failed', error);
      if (!response.headersSent) {
        html(response, '<h1>Something went wrong</h1><p>The details are in the server log.</p>', 500);
      } else {
        response.end();
      }
    });

    async function handle(req: typeof request, res: typeof response): Promise<void> {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const ctx: Ctx = {
        request: req,
        response: res,
        method: (req.method ?? 'GET').toUpperCase(),
        path: url.pathname.replace(/\/+$/, '') === '' ? '/' : url.pathname.replace(/\/+$/, ''),
        query: url.searchParams,
        cookies: parseCookies(req.headers.cookie),
        viewer: 'anonymous',
        shareToken: null,
      };

      // Static assets and health, no auth needed.
      const asset = ASSETS[ctx.path];
      if (asset !== undefined) {
        if (req.headers['if-none-match'] === asset.etag) {
          res.writeHead(304, { etag: asset.etag, 'cache-control': 'max-age=300, must-revalidate' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': asset.type,
          'cache-control': 'max-age=300, must-revalidate',
          etag: asset.etag,
          'x-content-type-options': 'nosniff',
        });
        res.end(asset.body);
        return;
      }
      if (ctx.path === '/healthz') {
        text(res, 'ok');
        return;
      }

      // Share links: read-only, and handled before any session check. Managing
      // them (creating, revoking) is the owner's business and stays behind the
      // session below, so only GETs are served here.
      if (ctx.path.startsWith('/share/') && ctx.method === 'GET') {
        if (!shareLimiter.allow(clientKey(req))) {
          text(res, 'Too many requests. Try again shortly.', 429);
          return;
        }
        await handleShare(ctx);
        return;
      }

      if (ctx.method === 'POST') {
        if (!sameOrigin(req)) {
          log.warn(`refused a cross-origin POST to ${ctx.path}`);
          text(res, 'This request did not come from the app.', 403);
          return;
        }
        if (!writeLimiter.allow(clientKey(req))) {
          res.setHeader('retry-after', String(writeLimiter.retryAfterSeconds(clientKey(req))));
          text(res, 'Too many requests. Try again shortly.', 429);
          return;
        }
      }

      const sessionOk =
        auth.sessionValid(app.db, ctx.cookies[auth.sessionCookieName]) || auth.openAccessAllowed(app.db);
      ctx.viewer = sessionOk ? 'owner' : 'anonymous';

      if (!sessionOk && !PUBLIC_PATHS.has(ctx.path)) {
        redirect(res, '/login');
        return;
      }

      if (ctx.path === '/login') {
        if (ctx.method === 'GET') {
          html(res, loginPage({ error: ctx.query.get('error') }));
          return;
        }
        const form = await readForm(req);
        const key = clientKey(req);
        if (!loginLimiter.allow(key)) {
          app.db.audit('anonymous', 'auth.login.throttled', 'session', undefined, key);
          html(
            res,
            loginPage({
              error: `Too many attempts. Try again in ${loginLimiter.retryAfterSeconds(key)} seconds.`,
            }),
            429,
          );
          return;
        }
        if (auth.checkPasscode(app.db, form.get('passcode') ?? '')) {
          loginLimiter.reset(key);
          setCookie(res, auth.sessionCookieName, auth.issueSession(app.db), {
            maxAgeSeconds: auth.sessionTtlSeconds,
            secure: isSecureRequest(req),
          });
          app.db.audit('owner', 'auth.login');
          redirect(res, '/');
          return;
        }
        app.db.audit('anonymous', 'auth.login.failed', 'session', undefined, key);
        html(res, loginPage({ error: 'That passcode did not match.' }), 401);
        return;
      }

      if (ctx.path === '/logout' && ctx.method === 'POST') {
        setCookie(res, auth.sessionCookieName, '', { maxAgeSeconds: 0, secure: isSecureRequest(req) });
        app.db.audit('owner', 'auth.logout');
        redirect(res, '/login');
        return;
      }

      if (ctx.method === 'GET') {
        await handleGet(ctx);
        return;
      }
      if (ctx.method === 'POST') {
        await handlePost(ctx);
        return;
      }
      notFound(res);
    }

    async function handleShare(ctx: Ctx): Promise<void> {
      const parts = ctx.path.split('/').filter((part) => part !== '');
      const token = parts[1];
      if (token === undefined) {
        notFound(ctx.response);
        return;
      }
      const link = repo.findShareLink(app.db, token);
      if (link === null) {
        html(ctx.response, '<h1>This link is no longer active</h1><p>Ask the owner for a new one.</p>', 404);
        return;
      }
      const settings = app.settings();
      const period = periodFromQuery(ctx, settings.timezone);
      const tail = parts.slice(2).join('/');
      const rates = repo.ratePeriods(app.db);
      const trips = repo.tripsForExport(app.db, { from: period.from, to: period.to });

      if (tail === 'trips.csv') {
        download(
          ctx.response,
          tripsCsv(trips, { timezone: settings.timezone, rates }),
          `mileage-detail-${period.fileTag}.csv`,
          'text/csv',
        );
        return;
      }
      if (tail === 'summary.csv') {
        download(
          ctx.response,
          summaryCsv(summarize(trips, { timezone: settings.timezone, rates })),
          `mileage-summary-${period.fileTag}.csv`,
          'text/csv',
        );
        return;
      }
      if (tail === '') {
        const report = reportFor(app, period, ctx.query.get('personal') === '1');
        const banner = `<div style="max-width:8.5in;margin:0 auto 14px;padding:10px 14px;border:1px solid #ccc;border-radius:8px;font:13px system-ui;background:#f7f7f7;color:#222">
          Read-only mileage log shared by the taxpayer · showing <strong>${escape(period.label)}</strong> ·
          <a href="/share/${escape(token)}?period=ytd">this year</a> ·
          <a href="/share/${escape(token)}?period=last-year">last year</a> ·
          <a href="/share/${escape(token)}?period=all">all time</a> ·
          <a href="/share/${escape(token)}/trips.csv?${escape(ctx.query.toString())}">trip detail CSV</a> ·
          <a href="/share/${escape(token)}/summary.csv?${escape(ctx.query.toString())}">summary CSV</a>
        </div>`;
        html(ctx.response, report.replace('<div class="sheet">', `${banner}<div class="sheet">`));
        return;
      }
      notFound(ctx.response);
    }

    async function handleGet(ctx: Ctx): Promise<void> {
      const settings = app.settings();
      const view = viewContext(app, ctx);
      const path = ctx.path;

      if (path === '/') {
        html(ctx.response, dashboardPage(view));
        return;
      }

      if (path === '/api/status') {
        const strip = statusStrip(app.db, settings, {
          running: app.poller.status().running,
          connector: app.poller.status().connector,
        });
        json(ctx.response, { label: strip.label, activityClass: strip.activityClass, at: nowIso() });
        return;
      }

      if (path === '/trips') {
        const placeId = intParam(ctx.query, 'place', 0);
        const place = placeId > 0 ? repo.getPlace(app.db, placeId) : null;
        const category = ctx.query.get('category') ?? 'all';
        html(
          ctx.response,
          tripsPage(view, {
            // A place filter is most useful across all of history, so it widens
            // the period unless one was asked for explicitly.
            period:
              place !== null && ctx.query.get('period') === null && ctx.query.get('from') === null
                ? resolvePeriod({ period: 'all' }, settings.timezone)
                : periodFromQuery(ctx, settings.timezone),
            classification: isClassification(category) ? category : 'all',
            reviewOnly: ctx.query.get('review') === '1',
            search: (ctx.query.get('q') ?? '').trim(),
            page: intParam(ctx.query, 'page', 1, 1, 10_000),
            placeId: place === null ? undefined : place.id,
            placeName: place === null ? undefined : place.name,
          }),
        );
        return;
      }

      if (path === '/places') {
        html(ctx.response, placesPage(view, { editing: intParam(ctx.query, 'edit', 0) || undefined }));
        return;
      }

      if (path === '/places/new') {
        const lat = Number(ctx.query.get('lat'));
        const lon = Number(ctx.query.get('lon'));
        html(
          ctx.response,
          placesPage(view, {
            prefill: {
              name: ctx.query.get('name') ?? '',
              latitude: Number.isFinite(lat) ? lat : null,
              longitude: Number.isFinite(lon) ? lon : null,
              radiusMeters: 200,
              kind: 'address',
              label: 'business',
            },
          }),
        );
        return;
      }

      if (path === '/rules') {
        html(ctx.response, rulesPage(view));
        return;
      }

      if (path === '/export') {
        html(ctx.response, exportPage(view, periodFromQuery(ctx, settings.timezone)));
        return;
      }

      if (path === '/export/report') {
        html(
          ctx.response,
          reportFor(app, periodFromQuery(ctx, settings.timezone), ctx.query.get('personal') === '1'),
        );
        return;
      }

      if (path === '/export/trips.csv') {
        const period = periodFromQuery(ctx, settings.timezone);
        const rates = repo.ratePeriods(app.db);
        download(
          ctx.response,
          tripsCsv(repo.tripsForExport(app.db, { from: period.from, to: period.to }), {
            timezone: settings.timezone,
            rates,
          }),
          `mileage-detail-${period.fileTag}.csv`,
          'text/csv',
        );
        return;
      }

      if (path === '/export/summary.csv') {
        const period = periodFromQuery(ctx, settings.timezone);
        const rates = repo.ratePeriods(app.db);
        const trips = repo.tripsForExport(app.db, { from: period.from, to: period.to });
        download(
          ctx.response,
          summaryCsv(summarize(trips, { timezone: settings.timezone, rates })),
          `mileage-summary-${period.fileTag}.csv`,
          'text/csv',
        );
        return;
      }

      if (path === '/export/backup.json') {
        download(
          ctx.response,
          backupJson(backupPayload(app)),
          `mile-ledger-backup-${localDate(nowIso(), settings.timezone)}.json`,
          'application/json',
        );
        return;
      }

      if (path === '/more') {
        html(ctx.response, morePage(view, { passcodeSet: auth.hasPasscode(app.db) }));
        return;
      }

      if (path === '/settings') {
        html(ctx.response, settingsPage(view, { passcodeSet: auth.hasPasscode(app.db) }));
        return;
      }

      if (path === '/connect') {
        html(
          ctx.response,
          connectPage(view, {
            baseUrl: (app.db.setting('base_url') ?? config.baseUrl).replace(/\/$/, ''),
            hasFleetApp: config.tesla.clientId !== '' && config.tesla.clientSecret !== '',
          }),
        );
        return;
      }

      if (path === '/connect/oauth/start') {
        if (config.tesla.clientId === '') {
          redirect(ctx.response, '/connect', 'No Tesla client ID is configured yet.');
          return;
        }
        const state = auth.newShareToken();
        app.db.putSetting('oauth_state', state);
        redirect(
          ctx.response,
          authorizeUrl(
            {
              clientId: config.tesla.clientId,
              clientSecret: config.tesla.clientSecret,
              redirectUri:
                config.tesla.redirectUri === ''
                  ? `${(app.db.setting('base_url') ?? '').replace(/\/$/, '')}/callback`
                  : config.tesla.redirectUri,
              scopes: config.tesla.scopes,
              audience: config.tesla.audience,
            },
            state,
          ),
        );
        return;
      }

      if (path === '/callback') {
        const code = ctx.query.get('code');
        const state = ctx.query.get('state');
        if (code === null || state === null || state !== app.db.setting('oauth_state')) {
          redirect(ctx.response, '/connect', 'That sign-in did not complete. Please start again.');
          return;
        }
        try {
          const tokens = await exchangeCode(
            {
              clientId: config.tesla.clientId,
              clientSecret: config.tesla.clientSecret,
              redirectUri:
                config.tesla.redirectUri === ''
                  ? `${(app.db.setting('base_url') ?? '').replace(/\/$/, '')}/callback`
                  : config.tesla.redirectUri,
              scopes: config.tesla.scopes,
              audience: config.tesla.audience,
            },
            code,
          );
          if (tokens.refreshToken === null) {
            redirect(ctx.response, '/connect', 'Tesla did not return a refresh token. Ask for the offline_access scope.');
            return;
          }
          storeRefreshToken(app.db, 'fleet', tokens.refreshToken, 'na');
          app.db.putSetting(SETTING_KEYS.connector, 'fleet');
          app.rewireConnector();
          redirect(ctx.response, '/', 'Connected to Tesla. The first reading will arrive shortly.');
        } catch (error) {
          redirect(ctx.response, '/connect', error instanceof Error ? error.message : 'Connection failed.');
        }
        return;
      }

      notFound(ctx.response);
    }

    async function handlePost(ctx: Ctx): Promise<void> {
      const form = await readForm(ctx.request);
      const path = ctx.path;
      const settings = app.settings();

      const tripMatch = /^\/trips\/(\d+)\/(classify|details|unlock)$/.exec(path);
      if (tripMatch !== null) {
        const id = Number(tripMatch[1]);
        const action = tripMatch[2];
        const back = safeReturn(form, '/trips');

        if (action === 'classify') {
          const classification = classificationFrom(form);
          if (classification === null) {
            redirect(ctx.response, back, 'That category is not one I know.');
            return;
          }
          decideTrip(app.db, id, {
            classification,
            purpose: str(form, 'purpose'),
            client: str(form, 'client'),
          });
          redirect(ctx.response, back);
          return;
        }
        if (action === 'details') {
          repo.setTripFields(app.db, id, {
            purpose: str(form, 'purpose'),
            client: str(form, 'client'),
            notes: str(form, 'notes'),
          });
          redirect(ctx.response, back, 'Saved.');
          return;
        }
        repo.unlockTrip(app.db, id);
        reclassifyAll(app.db);
        redirect(ctx.response, back, 'That trip is back to being decided automatically.');
        return;
      }

      if (path === '/trips/bulk') {
        const classification = classificationFrom(form);
        if (classification === null) {
          redirect(ctx.response, safeReturn(form, '/trips'), 'That category is not one I know.');
          return;
        }
        const category = form.get('category') ?? 'all';
        const trips = repo.tripsForExport(app.db, {
          from: str(form, 'from') ?? undefined,
          to: str(form, 'to') ?? undefined,
          classification: isClassification(category) ? category : undefined,
          needsReview: form.get('review') === '1' ? true : undefined,
          search: str(form, 'q') ?? undefined,
        });
        for (const trip of trips) decideTrip(app.db, trip.id, { classification });
        redirect(
          ctx.response,
          safeReturn(form, '/trips'),
          `${trips.length} trip${trips.length === 1 ? '' : 's'} recorded as ${classification}.`,
        );
        return;
      }

      const placeMatch = /^\/places(?:\/(\d+)(\/delete)?)?$/.exec(path);
      if (placeMatch !== null) {
        const id = placeMatch[1] === undefined ? null : Number(placeMatch[1]);
        const deleting = placeMatch[2] !== undefined;

        if (deleting && id !== null) {
          repo.deletePlace(app.db, id);
          reclassifyAll(app.db);
          redirect(ctx.response, '/places', 'Label removed and trips re-checked.');
          return;
        }

        const kindRaw = form.get('kind') ?? 'address';
        const labelRaw = form.get('label') ?? 'business';
        const kind: PlaceKind = kindRaw === 'city' || kindRaw === 'region' ? kindRaw : 'address';
        const label: PlaceLabel = labelRaw === 'personal' || labelRaw === 'neutral' ? labelRaw : 'business';
        const defaultRadius = kind === 'address' ? 200 : kind === 'city' ? 12_000 : 120_000;

        const input = {
          name: str(form, 'name') ?? 'Unnamed place',
          kind,
          label,
          purpose: str(form, 'purpose'),
          client: str(form, 'client'),
          address: str(form, 'address'),
          city: str(form, 'city'),
          region: str(form, 'region'),
          postal: str(form, 'postal'),
          latitude: number(form, 'latitude'),
          longitude: number(form, 'longitude'),
          radiusMeters: Math.max(25, Math.round(number(form, 'radiusMeters') ?? defaultRadius)),
          isHome: form.get('isHome') === '1',
          isPrimaryOffice: form.get('isPrimaryOffice') === '1',
          notes: str(form, 'notes'),
        };

        if (id === null) repo.createPlace(app.db, input);
        else repo.updatePlace(app.db, id, input);

        reclassifyAll(app.db);
        redirect(ctx.response, safeReturn(form, '/places'), `Saved "${input.name}" and re-checked every trip.`);
        return;
      }

      if (path === '/rules') {
        const conditions: RuleConditions = {};
        const startPlace = number(form, 'startPlaceId');
        const endPlace = number(form, 'endPlaceId');
        if (startPlace !== null) conditions.startPlaceId = startPlace;
        if (endPlace !== null) conditions.endPlaceId = endPlace;
        const city = str(form, 'city');
        if (city !== null) conditions.city = city;
        const region = str(form, 'region');
        if (region !== null) conditions.region = region;
        const weekdays = form
          .getAll('weekdays')
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value >= 0 && value <= 6);
        if (weekdays.length > 0) conditions.weekdays = weekdays;
        const after = minutesFromTime(str(form, 'after'));
        if (after !== undefined) conditions.afterMinutes = after;
        const before = minutesFromTime(str(form, 'before'));
        if (before !== undefined) conditions.beforeMinutes = before;
        const minMiles = number(form, 'minMiles');
        if (minMiles !== null) conditions.minMiles = minMiles;
        const maxMiles = number(form, 'maxMiles');
        if (maxMiles !== null) conditions.maxMiles = maxMiles;

        const classification = classificationFrom(form) ?? 'business';
        repo.createRule(app.db, {
          name: str(form, 'name') ?? 'Unnamed rule',
          priority: Math.round(number(form, 'priority') ?? 100),
          enabled: true,
          source: 'user',
          conditions,
          classification,
          purpose: str(form, 'purpose'),
          client: str(form, 'client'),
        });
        reclassifyAll(app.db);
        redirect(ctx.response, '/rules', 'Rule added and applied to past trips.');
        return;
      }

      const ruleMatch = /^\/rules\/(\d+)\/(toggle|delete)$/.exec(path);
      if (ruleMatch !== null) {
        const id = Number(ruleMatch[1]);
        const rule = repo.getRule(app.db, id);
        if (rule === null) {
          redirect(ctx.response, '/rules', 'That rule is already gone.');
          return;
        }
        if (ruleMatch[2] === 'delete') repo.deleteRule(app.db, id);
        else {
          repo.updateRule(app.db, id, {
            name: rule.name,
            priority: rule.priority,
            enabled: !rule.enabled,
            source: rule.source,
            conditions: rule.conditions,
            classification: rule.classification,
            purpose: rule.purpose,
            client: rule.client,
          });
        }
        reclassifyAll(app.db);
        redirect(ctx.response, '/rules', 'Done, and past trips were re-checked.');
        return;
      }

      const suggestionMatch = /^\/suggestions\/(\d+)\/(accept|dismiss)$/.exec(path);
      if (suggestionMatch !== null) {
        const id = Number(suggestionMatch[1]);
        if (suggestionMatch[2] === 'dismiss') {
          repo.setSuggestionStatus(app.db, id, 'dismissed');
          redirect(ctx.response, safeReturn(form, '/rules'), 'Dismissed.');
          return;
        }
        const result = acceptSuggestion(app.db, id);
        if (result === null) {
          redirect(ctx.response, '/rules', 'That suggestion is no longer available.');
          return;
        }
        if (result.kind === 'place') {
          repo.setSuggestionStatus(app.db, id, 'accepted');
          redirect(ctx.response, `/places/new?lat=${result.latitude}&lon=${result.longitude}`);
          return;
        }
        redirect(ctx.response, '/rules', 'Learned. Trips on that route will be handled for you from now on.');
        return;
      }

      if (path === '/settings') {
        const patch: Record<string, string> = {};
        for (const key of Object.values(SETTING_KEYS)) {
          const value = form.get(key);
          if (value !== null) patch[key] = value.trim();
        }
        const refused = writeSettings(app.db, patch);
        const updated = readSettings(app.db);
        if (updated.timezone !== settings.timezone) reclassifyAll(app.db);
        app.rewireConnector();
        redirect(
          ctx.response,
          '/settings',
          refused.length === 0 ? 'Settings saved.' : `Saved, except: ${refused.join(' ')}`,
        );
        return;
      }

      if (path === '/settings/rates') {
        const from = str(form, 'from');
        const to = str(form, 'to');
        const business = number(form, 'business');
        if (from === null || to === null || business === null) {
          redirect(ctx.response, '/settings', 'A rate needs a start date, an end date and a business rate.');
          return;
        }
        repo.upsertRate(app.db, {
          from,
          to,
          business,
          medical: number(form, 'medical') ?? 0,
          charity: number(form, 'charity') ?? 0,
          note: str(form, 'note') ?? 'Entered by hand',
        });
        redirect(ctx.response, '/settings', 'Rate saved. Exports will use it right away.');
        return;
      }

      if (path === '/appearance') {
        const appearance = form.get('appearance');
        const colour = form.get('colour');
        const patch: Record<string, string> = {};
        if (appearance === 'system' || appearance === 'light' || appearance === 'dark') {
          patch[SETTING_KEYS.appearance] = appearance;
        }
        if (colour === 'colour' || colour === 'mono') patch[SETTING_KEYS.colour] = colour;
        writeSettings(app.db, patch);
        const now = readSettings(app.db);
        redirect(
          ctx.response,
          safeReturn(form, '/settings'),
          `Appearance saved: ${now.appearance === 'system' ? 'following your device' : now.appearance}, ${
            now.colour === 'mono' ? 'black and white' : 'full colour'
          }.`,
        );
        return;
      }

      if (path === '/settings/passcode') {
        auth.setPasscode(app.db, form.get('passcode') ?? '');
        redirect(ctx.response, '/settings', (form.get('passcode') ?? '') === '' ? 'Passcode removed.' : 'Passcode set.');
        return;
      }

      if (path === '/import') {
        const csv = form.get('csv') ?? '';
        if (csv.trim() === '') {
          redirect(ctx.response, '/settings', 'There was nothing to import.');
          return;
        }
        const vehicle =
          repo.listVehicles(app.db)[0] ??
          repo.upsertVehicle(app.db, { displayName: settings.vehicleDescription === '' ? 'Imported vehicle' : settings.vehicleDescription });
        const report = importCsv(app.db, vehicle.id, csv, { timezone: settings.timezone, source: 'import' });
        reclassifyAll(app.db);
        const detail =
          report.problems.length === 0
            ? ''
            : ` Problems: ${report.problems.slice(0, 3).join('; ')}`;
        redirect(
          ctx.response,
          '/settings',
          `Read ${report.rowsSeen} rows as ${report.kind}: imported ${report.imported}, skipped ${report.skipped}, ${report.tripsCreated} trips created.${detail}`,
        );
        return;
      }

      if (path === '/rebuild') {
        let created = 0;
        for (const vehicle of repo.listVehicles(app.db)) {
          created += rebuildTrips(app.db, vehicle.id, '1970-01-01T00:00:00.000Z').created;
        }
        pruneOldSamples(app.db);
        redirect(ctx.response, '/settings', `Rebuilt from raw readings. ${created} trip${created === 1 ? '' : 's'} added.`);
        return;
      }

      if (path === '/reclassify') {
        const result = reclassifyAll(app.db);
        redirect(
          ctx.response,
          safeReturn(form, '/places'),
          `Checked ${result.examined} trips; ${result.changed} changed.`,
        );
        return;
      }

      if (path === '/poll-now') {
        const outcome = await app.poller.tick();
        const message =
          outcome.messages.length > 0
            ? outcome.messages.join(' · ')
            : `Read the car: ${outcome.stored} new reading${outcome.stored === 1 ? '' : 's'}, ${outcome.tripsCreated} new trip${outcome.tripsCreated === 1 ? '' : 's'}.`;
        redirect(ctx.response, '/', message);
        return;
      }

      if (path === '/connect/token') {
        const token = str(form, 'refreshToken');
        const mode = form.get('mode') === 'fleet' ? 'fleet' : 'owner';
        if (token === null) {
          redirect(ctx.response, '/connect', 'Paste the refresh token first.');
          return;
        }
        storeRefreshToken(app.db, mode, token, str(form, 'region') ?? 'na');
        app.db.putSetting(SETTING_KEYS.connector, mode);
        app.rewireConnector();
        redirect(ctx.response, '/', 'Token saved. Reading the car now.');
        return;
      }

      if (path === '/connect/demo') {
        app.db.putSetting(SETTING_KEYS.connector, 'demo');
        app.rewireConnector();
        const seeded = seedDemoData(app.db, { timezone: settings.timezone });
        reclassifyAll(app.db);
        redirect(
          ctx.response,
          '/',
          `Demo car switched on with ${seeded.trips} trips of history. Everything you see from here is simulated.`,
        );
        return;
      }

      if (path === '/connect/disconnect') {
        app.db.putSetting(SETTING_KEYS.connector, 'manual');
        app.rewireConnector();
        redirect(ctx.response, '/connect', 'Live reading is off. Your trips are untouched.');
        return;
      }

      if (path === '/connect/register') {
        const domain = str(form, 'domain');
        if (domain === null) {
          redirect(ctx.response, '/connect', 'Enter the domain that serves your public key.');
          return;
        }
        try {
          const result = await registerPartnerAccount(
            {
              clientId: config.tesla.clientId,
              clientSecret: config.tesla.clientSecret,
              redirectUri: config.tesla.redirectUri,
              scopes: config.tesla.scopes,
              audience: config.tesla.audience,
            },
            domain,
            str(form, 'region') ?? 'na',
          );
          redirect(
            ctx.response,
            '/connect',
            result.ok ? `Registered ${domain} with Tesla.` : `Tesla refused the registration (${result.status}): ${result.detail}`,
          );
        } catch (error) {
          redirect(ctx.response, '/connect', error instanceof Error ? error.message : 'Registration failed.');
        }
        return;
      }

      if (path === '/share') {
        const token = auth.newShareToken();
        repo.createShareLink(app.db, token, str(form, 'name') ?? 'Accountant link');
        redirect(ctx.response, '/export', 'Link created. Copy it below and send it on.');
        return;
      }

      const revokeMatch = /^\/share\/([^/]+)\/revoke$/.exec(path);
      if (revokeMatch !== null && revokeMatch[1] !== undefined) {
        repo.revokeShareLink(app.db, decodeURIComponent(revokeMatch[1]));
        redirect(ctx.response, '/export', 'Link revoked.');
        return;
      }

      notFound(ctx.response);
    }
  });
}
