/**
 * Places, rules, exports, settings and the Tesla connection wizard.
 *
 * The wording here matters as much as the code: these are the screens where
 * someone decides what counts as business, and where they find out what the
 * official Tesla API is going to ask of them.
 */
import * as repo from '../db/repo.ts';
import type { Place, Classification } from '../domain/types.ts';
import type { Rule } from '../domain/classify.ts';
import { summarize } from '../export/summary.ts';
import { badge, card, emptyState, escape, layout, milesText, money, stat } from './ui.ts';
import { PERIOD_CHOICES, periodQuery, resolvePeriod, type Period } from './period.ts';
import type { ViewContext } from './views.ts';
import { localMonth, nowIso, humanAgo } from '../lib/time.ts';
import { ratesCoverThrough } from '../domain/rates.ts';
import { FLEET_REGIONS } from '../tesla/client.ts';
import { config } from '../config.ts';

const LABEL_HELP: Record<string, string> = {
  business: 'Trips to here count as business',
  personal: 'Trips to here are personal',
  neutral: 'No opinion — let rules decide',
};

function placeForm(place: Partial<Place>, options: { action: string; returnTo: string; heading: string; submit: string }): string {
  const kind = place.kind ?? 'address';
  const label = place.label ?? 'business';
  return `<form method="post" action="${escape(options.action)}">
    <input type="hidden" name="return" value="${escape(options.returnTo)}">
    <div class="fields two">
      <div><label>Name</label><input name="name" required value="${escape(place.name ?? '')}" placeholder="Acme Warehouse, Home, all of Fargo"></div>
      <div>
        <label>What is this?</label>
        <select name="kind">
          <option value="address" ${kind === 'address' ? 'selected' : ''}>A specific address or site</option>
          <option value="city" ${kind === 'city' ? 'selected' : ''}>A whole city or town</option>
          <option value="region" ${kind === 'region' ? 'selected' : ''}>A whole state or region</option>
        </select>
      </div>
    </div>
    <div class="fields two">
      <div>
        <label>How should trips here be treated?</label>
        <select name="label">
          ${(['business', 'personal', 'neutral'] as const)
            .map((option) => `<option value="${option}" ${label === option ? 'selected' : ''}>${escape(option)} — ${escape(LABEL_HELP[option] ?? '')}</option>`)
            .join('')}
        </select>
      </div>
      <div><label>Default business purpose <span class="small">(optional)</span></label><input name="purpose" value="${escape(place.purpose ?? '')}" placeholder="Site supervision"></div>
    </div>
    <div class="fields two">
      <div><label>Client or project <span class="small">(optional)</span></label><input name="client" value="${escape(place.client ?? '')}"></div>
      <div><label>Street address <span class="small">(optional, for the report)</span></label><input name="address" value="${escape(place.address ?? '')}"></div>
    </div>
    <div class="fields three">
      <div><label>City</label><input name="city" value="${escape(place.city ?? '')}" placeholder="Fargo"></div>
      <div><label>State or region</label><input name="region" value="${escape(place.region ?? '')}" placeholder="North Dakota"></div>
      <div><label>Postal code</label><input name="postal" value="${escape(place.postal ?? '')}"></div>
    </div>
    <div class="fields three">
      <div><label>Latitude</label><input name="latitude" value="${escape(place.latitude ?? '')}" placeholder="46.8772"></div>
      <div><label>Longitude</label><input name="longitude" value="${escape(place.longitude ?? '')}" placeholder="-96.7898"></div>
      <div>
        <label>How close counts as "here"? (meters)</label>
        <input name="radiusMeters" value="${escape(place.radiusMeters ?? 200)}">
      </div>
    </div>
    <div class="row" style="margin:4px 0 12px">
      <div class="inline"><input type="checkbox" id="isHome" name="isHome" value="1" ${place.isHome === true ? 'checked' : ''}><label for="isHome">This is home</label></div>
      <div class="inline"><input type="checkbox" id="isOffice" name="isPrimaryOffice" value="1" ${place.isPrimaryOffice === true ? 'checked' : ''}><label for="isOffice">This is my regular office</label></div>
    </div>
    <div class="field"><label>Notes</label><input name="notes" value="${escape(place.notes ?? '')}"></div>
    <p class="small">Marking home and a regular office lets the app separate commuting, which the IRS does not allow as a deduction, from business driving that it does.</p>
    <button class="primary" type="submit">${escape(options.submit)}</button>
  </form>`;
}

export function placesPage(context: ViewContext, params: { editing?: number; prefill?: Partial<Place> }): string {
  const { db, settings } = context;
  const places = repo.listPlaces(db);
  const editing = params.editing === undefined ? null : places.find((place) => place.id === params.editing) ?? null;

  const groups: { kind: Place['kind']; title: string; hint: string }[] = [
    { kind: 'address', title: 'Addresses', hint: 'Specific sites. These win over city labels.' },
    { kind: 'city', title: 'Cities and towns', hint: 'Everything inside, unless a specific address says otherwise.' },
    { kind: 'region', title: 'States and regions', hint: 'A broad catch-all.' },
  ];

  const list = groups
    .map((group) => {
      const rows = places.filter((place) => place.kind === group.kind);
      if (rows.length === 0) return '';
      return `<h3>${escape(group.title)}</h3>
        <p class="small">${escape(group.hint)}</p>
        ${rows
          .map(
            (place) => `<div class="trip">
              <div class="row between">
                <div>
                  <strong>${escape(place.name)}</strong> ${badge(place.label)}
                  ${place.isHome ? '<span class="badge ghost">home</span>' : ''}
                  ${place.isPrimaryOffice ? '<span class="badge ghost">regular office</span>' : ''}
                  <div class="small">${escape(
                    [place.address, place.city, place.region].filter((part) => (part ?? '') !== '').join(', ') || 'no address recorded',
                  )}${place.kind === 'address' && place.latitude !== null ? ` · within ${place.radiusMeters} m` : ''} · seen on ${place.visitCount} trip${place.visitCount === 1 ? '' : 's'}</div>
                  ${place.purpose === null && place.client === null ? '' : `<div class="small">Default purpose: ${escape([place.purpose, place.client].filter((p) => p !== null).join(' — '))}</div>`}
                </div>
                <div class="row">
                  <a class="btn small" href="/places?edit=${place.id}">Edit</a>
                  <a class="btn small" href="/trips?place=${place.id}">Trips</a>
                  <form method="post" action="/places/${place.id}/delete" class="inlineform">
                    <button class="small danger" type="submit" onclick="return confirm('Remove this label? Past trips keep their categories unless you re-run the classifier.')">Remove</button>
                  </form>
                </div>
              </div>
            </div>`,
          )
          .join('')}`;
    })
    .join('<hr>');

  const body = `
    <div class="head"><h1>Places</h1><div class="small">Labeling where you go is what teaches the app. One address can settle months of trips at once.</div></div>
    ${
      places.length === 0
        ? card(emptyState('⌖', 'No places labeled yet', 'Add home first, then the places you drive to for work.'))
        : card(list)
    }
    ${card(
      editing === null
        ? placeForm(params.prefill ?? { radiusMeters: 200 }, {
            action: '/places',
            returnTo: '/places',
            heading: 'Add a place',
            submit: 'Add this place',
          })
        : placeForm(editing, {
            action: `/places/${editing.id}`,
            returnTo: '/places',
            heading: 'Edit place',
            submit: 'Save changes',
          }),
      { title: editing === null ? 'Add a place' : `Edit ${editing.name}` },
    )}
    ${
      places.length === 0
        ? ''
        : card(
            `<p class="small">Re-running the classifier applies your current labels and rules to every trip you have not decided by hand.</p>
             <form method="post" action="/reclassify"><button class="primary" type="submit">Re-check every trip</button></form>`,
            { title: 'Apply labels to past trips' },
          )
    }
  `;
  return layout({ title: 'Places', nav: 'places', body, status: context.status, flash: context.flash });
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeConditions(rule: Rule, places: Place[]): string {
  const parts: string[] = [];
  const nameOf = (id: number): string => places.find((place) => place.id === id)?.name ?? `place ${id}`;
  const c = rule.conditions;
  if (c.signature !== undefined) parts.push('one specific route you confirmed');
  if (c.startPlaceId !== undefined) parts.push(`starts at ${nameOf(c.startPlaceId)}`);
  if (c.endPlaceId !== undefined) parts.push(`ends at ${nameOf(c.endPlaceId)}`);
  if (c.anyPlaceId !== undefined) parts.push(`touches ${nameOf(c.anyPlaceId)}`);
  if (c.startLabel !== undefined) parts.push(`starts somewhere labeled ${c.startLabel}`);
  if (c.endLabel !== undefined) parts.push(`ends somewhere labeled ${c.endLabel}`);
  if (c.anyLabel !== undefined) parts.push(`either end is labeled ${c.anyLabel}`);
  if (c.city !== undefined && c.city !== '') parts.push(`in ${c.city}`);
  if (c.region !== undefined && c.region !== '') parts.push(`in ${c.region}`);
  if (c.weekdays !== undefined && c.weekdays.length > 0) {
    parts.push(`on ${c.weekdays.map((day) => WEEKDAY_NAMES[day] ?? day).join(', ')}`);
  }
  if (c.afterMinutes !== undefined || c.beforeMinutes !== undefined) {
    const fmt = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    parts.push(`between ${fmt(c.afterMinutes ?? 0)} and ${fmt(c.beforeMinutes ?? 1439)}`);
  }
  if (c.minMiles !== undefined) parts.push(`at least ${c.minMiles} mi`);
  if (c.maxMiles !== undefined) parts.push(`at most ${c.maxMiles} mi`);
  if (c.inferred === true) parts.push('only reconstructed trips');
  return parts.length === 0 ? 'every trip' : parts.join(', ');
}

export function rulesPage(context: ViewContext): string {
  const { db } = context;
  const rules = repo.listRules(db);
  const places = repo.listPlaces(db);
  const suggestions = repo.listSuggestions(db);

  const ruleRows = rules
    .map(
      (rule) => `<div class="trip">
        <div class="row between">
          <div>
            <strong>${escape(rule.name)}</strong> ${badge(rule.classification)}
            ${rule.source === 'learned' ? '<span class="badge ghost">learned</span>' : ''}
            ${rule.enabled ? '' : '<span class="badge ghost">off</span>'}
            <div class="small">When ${escape(describeConditions(rule, places))} · priority ${rule.priority} · used ${rule.hits ?? 0} time${(rule.hits ?? 0) === 1 ? '' : 's'}</div>
            ${rule.purpose === null && rule.client === null ? '' : `<div class="small">Sets purpose: ${escape([rule.purpose, rule.client].filter((p) => p !== null).join(' — '))}</div>`}
          </div>
          <div class="row">
            <form method="post" action="/rules/${rule.id}/toggle" class="inlineform">
              <button class="small" type="submit">${rule.enabled ? 'Turn off' : 'Turn on'}</button>
            </form>
            <form method="post" action="/rules/${rule.id}/delete" class="inlineform">
              <button class="small danger" type="submit" onclick="return confirm('Delete this rule?')">Delete</button>
            </form>
          </div>
        </div>
      </div>`,
    )
    .join('');

  const placeOptions = places
    .map((place) => `<option value="${place.id}">${escape(place.name)}</option>`)
    .join('');

  const suggestionRows = suggestions
    .map(
      (suggestion) => `<div class="trip">
        <div class="row between">
          <div><strong>${escape(suggestion.description)}</strong> ${badge(suggestion.classification)}</div>
          <div class="row">
            <form method="post" action="/suggestions/${suggestion.id}/accept" class="inlineform">
              <button class="primary small" type="submit">${suggestion.signature.startsWith('place:') ? 'Label that address' : 'Automate it'}</button>
            </form>
            <form method="post" action="/suggestions/${suggestion.id}/dismiss" class="inlineform">
              <button class="small" type="submit">Dismiss</button>
            </form>
          </div>
        </div>
      </div>`,
    )
    .join('');

  const body = `
    <div class="head"><h1>Rules</h1><div class="small">Rules run before labels and settle the cases a label alone cannot. The first matching rule wins.</div></div>

    ${suggestions.length === 0 ? '' : card(suggestionRows, { title: 'Waiting for your approval' })}

    ${rules.length === 0 ? card(emptyState('⚙', 'No rules yet', 'Most people never need one — labels on places do the work. Add a rule for the exceptions, like "Saturdays are always personal".')) : card(ruleRows)}

    ${card(
      `<form method="post" action="/rules">
        <div class="fields two">
          <div><label>Name this rule</label><input name="name" required placeholder="Saturdays are personal"></div>
          <div>
            <label>Then record the trip as</label>
            <select name="classification">
              ${(['business', 'personal', 'commute', 'medical', 'charity'] as Classification[])
                .map((option) => `<option value="${option}">${escape(option)}</option>`)
                .join('')}
            </select>
          </div>
        </div>
        <h3 style="margin-top:14px">Only when…</h3>
        <div class="fields two">
          <div><label>Starts at</label><select name="startPlaceId"><option value="">anywhere</option>${placeOptions}</select></div>
          <div><label>Ends at</label><select name="endPlaceId"><option value="">anywhere</option>${placeOptions}</select></div>
        </div>
        <div class="fields two">
          <div><label>City is</label><input name="city" placeholder="Fargo"></div>
          <div><label>State or region is</label><input name="region" placeholder="North Dakota"></div>
        </div>
        <div class="field">
          <label>Days of the week</label>
          <div class="chips">
            ${WEEKDAY_NAMES.map(
              (day, index) =>
                `<span class="inline"><input type="checkbox" id="wd${index}" name="weekdays" value="${index}"><label for="wd${index}">${day}</label></span>`,
            ).join('')}
          </div>
        </div>
        <div class="fields three">
          <div><label>Not before (local time)</label><input name="after" type="time"></div>
          <div><label>Not after (local time)</label><input name="before" type="time"></div>
          <div><label>Priority <span class="small">(lower runs first)</span></label><input name="priority" value="100"></div>
        </div>
        <div class="fields two">
          <div><label>At least this many miles</label><input name="minMiles" placeholder=""></div>
          <div><label>At most this many miles</label><input name="maxMiles" placeholder=""></div>
        </div>
        <div class="fields two">
          <div><label>Set business purpose to</label><input name="purpose"></div>
          <div><label>Set client or project to</label><input name="client"></div>
        </div>
        <button class="primary" type="submit">Add this rule</button>
      </form>`,
      { title: 'Add a rule' },
    )}
  `;
  return layout({ title: 'Rules', nav: 'rules', body, status: context.status, flash: context.flash });
}

export function exportPage(context: ViewContext, period: Period): string {
  const { db, settings } = context;
  const rates = repo.ratePeriods(db);
  const trips = repo.tripsForExport(db, { from: period.from, to: period.to });
  const summary = summarize(trips, { timezone: settings.timezone, rates });
  const query = periodQuery(period);
  const shares = repo.listShareLinks(db);

  const periodChips = PERIOD_CHOICES.map(
    (choice) => `<a class="chip ${period.key === choice.key ? 'on' : ''}" href="/export?period=${choice.key}">${escape(choice.label)}</a>`,
  ).join('');

  const shareRows =
    shares.length === 0
      ? '<p class="small">No link has been created yet.</p>'
      : shares
          .map(
            (share) => `<div class="trip">
              <div class="row between">
                <div>
                  <strong>${escape(share.name)}</strong>
                  <div class="small">Created ${escape(humanAgo(share.createdAt))}${share.lastUsedAt === null ? ' · never opened' : ` · last opened ${escape(humanAgo(share.lastUsedAt))}`}</div>
                </div>
                <form method="post" action="/share/${escape(share.token)}/revoke" class="inlineform">
                  <button class="small danger" type="submit" onclick="return confirm('Revoke this link? Anyone holding it loses access immediately.')">Revoke</button>
                </form>
              </div>
              <div class="copy" style="margin-top:8px">
                <input id="share-${escape(share.token)}" readonly value="${escape(shareUrl(context, share.token))}">
                <button class="small" type="button" onclick="mlCopy('share-${escape(share.token)}', this)">Copy</button>
              </div>
            </div>`,
          )
          .join('');

  const staleRates = ratesCoverThrough(rates) < (period.to ?? nowIso()).slice(0, 10);

  const body = `
    <div class="head"><h1>Export</h1><div class="small">Everything here is generated from the current ledger, so it is always up to date.</div></div>

    <section class="card tight"><div class="chips">${periodChips}</div>
      <form method="get" action="/export" class="row" style="margin-top:10px">
        <input type="hidden" name="period" value="custom">
        <div><label>From</label><input type="date" name="from" value="${escape(period.rawFrom ?? '')}"></div>
        <div><label>To</label><input type="date" name="to" value="${escape(period.rawTo ?? '')}"></div>
        <div style="align-self:end"><button class="small" type="submit">Use these dates</button></div>
      </form>
    </section>

    <div class="stats" style="margin-bottom:14px">
      ${stat('Business miles', milesText(summary.byClassification.business?.miles ?? 0), escape(period.label), true)}
      ${stat('Estimated deduction', money(summary.deduction), 'IRS standard rates', true)}
      ${stat('Trips', String(summary.totalTrips), `${milesText(summary.totalMiles)} mi total`)}
      ${stat('Still undecided', String(summary.unclassifiedTrips), 'excluded from the total')}
    </div>

    ${
      summary.unclassifiedTrips === 0
        ? ''
        : `<div class="notice warn">${summary.unclassifiedTrips} trip${summary.unclassifiedTrips === 1 ? '' : 's'} in this period have no category yet, so their miles are not counted above. <a href="/trips?review=1">Sort them out first</a>.</div>`
    }
    ${staleRates ? '<div class="notice warn">The built-in IRS rate table does not cover the end of this period yet. Add the current rate under <a href="/settings">Settings</a> so the deduction is right.</div>' : ''}

    ${card(
      `<p class="small">The report is a printable mileage log: totals by month, business miles by client, the trip detail, and a plain statement of how the numbers were produced. Open it and use your browser's Print to save a PDF — no extra software.</p>
       <div class="row">
         <a class="btn primary" href="/export/report?${escape(query)}" target="_blank" rel="noreferrer">Open printable report</a>
         <a class="btn" href="/export/report?${escape(query)}&personal=1" target="_blank" rel="noreferrer">Include personal trips</a>
       </div>`,
      { title: 'For the accountant' },
    )}

    ${card(
      `<div class="row">
        <a class="btn" href="/export/trips.csv?${escape(query)}">Trip detail (CSV)</a>
        <a class="btn" href="/export/summary.csv?${escape(query)}">Monthly summary (CSV)</a>
        <a class="btn" href="/export/backup.json">Full backup (JSON)</a>
      </div>
      <p class="small" style="margin-top:10px">The trip detail is one row per drive with date, miles, both ends, purpose, client, the odometer readings, and a note on what decided the category. The backup contains everything the app knows, for safekeeping or moving to another machine.</p>`,
      { title: 'Spreadsheets and backups' },
    )}

    ${card(
      `<p class="small">A link your accountant can open any time to see the current report and download the spreadsheets. It is read-only: it cannot change a category, and it shows nothing else in the app. Revoke it whenever you like.</p>
       ${shareRows}
       <form method="post" action="/share" class="row" style="margin-top:12px">
         <input name="name" placeholder="Name it, e.g. CPA — tax year 2026" style="flex:1;min-width:200px">
         <button class="primary small" type="submit">Create a link</button>
       </form>
       ${
         context.settings.connector === 'demo'
           ? '<p class="small">Heads up: this ledger is currently full of demo data.</p>'
           : ''
       }`,
      { title: 'A standing link for your CPA' },
    )}
  `;
  return layout({ title: 'Export', nav: 'export', body, status: context.status, flash: context.flash });
}

/**
 * Absolute link when a base URL is configured, otherwise a relative one — which
 * still works when copied out of the browser's address bar.
 */
function shareUrl(context: ViewContext, token: string): string {
  const configured = (context.db.setting('base_url') ?? config.baseUrl).replace(/\/$/, '');
  return `${configured}/share/${token}`;
}

export function settingsPage(context: ViewContext, options: { passcodeSet: boolean }): string {
  const { db, settings } = context;
  const rates = repo.ratePeriods(db);
  const vehicles = repo.listVehicles(db, true);
  const month = localMonth(nowIso(), settings.timezone);
  const usage = repo.usageSummary(db, month);

  const rateRows = rates
    .map(
      (rate) => `<tr>
        <td>${escape(rate.from)}</td><td>${escape(rate.to)}</td>
        <td class="n">${rate.business.toFixed(1)}</td>
        <td class="n">${rate.medical.toFixed(1)}</td>
        <td class="n">${rate.charity.toFixed(1)}</td>
        <td class="small">${escape(rate.note)}</td>
      </tr>`,
    )
    .join('');

  const body = `
    <div class="head"><h1>Settings</h1><div class="small">Everything is stored on this machine, in one file.</div></div>

    ${card(
      `<form method="post" action="/settings">
        <div class="fields two">
          <div><label>Business name <span class="small">(printed on the report)</span></label><input name="business_name" value="${escape(settings.businessName)}"></div>
          <div><label>Your name</label><input name="owner_name" value="${escape(settings.ownerName)}"></div>
        </div>
        <div class="fields two">
          <div><label>Vehicle description</label><input name="vehicle_description" value="${escape(settings.vehicleDescription)}" placeholder="2024 Tesla Model Y"></div>
          <div><label>Time zone <span class="small">(decides which day a trip lands on)</span></label><input name="timezone" value="${escape(settings.timezone)}" placeholder="America/Chicago"></div>
        </div>
        <h3 style="margin-top:16px">How to treat a trip nothing explains</h3>
        <div class="fields two">
          <div>
            <label>Unmatched trips become</label>
            <select name="fallback_classification">
              ${(['unclassified', 'personal', 'business'] as Classification[])
                .map((option) => `<option value="${option}" ${settings.fallback === option ? 'selected' : ''}>${escape(option === 'unclassified' ? 'unclassified — ask me' : option)}</option>`)
                .join('')}
            </select>
          </div>
          <div>
            <label>Home to the regular office is</label>
            <select name="commute_handling">
              <option value="commute" ${settings.commuteHandling === 'commute' ? 'selected' : ''}>commute — tracked, not deducted (IRS treatment)</option>
              <option value="personal" ${settings.commuteHandling === 'personal' ? 'selected' : ''}>personal</option>
              <option value="business" ${settings.commuteHandling === 'business' ? 'selected' : ''}>business — only if your accountant says so</option>
            </select>
          </div>
        </div>
        <h3 style="margin-top:16px">Learning</h3>
        <div class="fields three">
          <div><label>Corrections before a pattern is proposed</label><input name="learn_min_observations" value="${settings.learnMinObservations}"></div>
          <div><label>Agreement required (0–1)</label><input name="learn_agreement" value="${settings.learnAgreement}"></div>
          <div>
            <label>Apply learned patterns</label>
            <select name="auto_apply_learned">
              <option value="0" ${settings.autoApplyLearned ? '' : 'selected'}>only after I approve them</option>
              <option value="1" ${settings.autoApplyLearned ? 'selected' : ''}>automatically, without asking</option>
            </select>
          </div>
        </div>
        <h3 style="margin-top:16px">Reading the car</h3>
        <div class="fields three">
          <div><label>While driving, read every (seconds)</label><input name="poll_driving_seconds" value="${settings.pollDrivingSeconds}"></div>
          <div><label>While parked and awake (seconds)</label><input name="poll_awake_seconds" value="${settings.pollAwakeSeconds}"></div>
          <div><label>While asleep (seconds)</label><input name="poll_asleep_seconds" value="${settings.pollAsleepSeconds}"></div>
        </div>
        <div class="fields three">
          <div><label>Monthly API credit ceiling</label><input name="credit_budget" value="${settings.creditBudget}"></div>
          <div>
            <label>Look up street addresses</label>
            <select name="geocode_enabled">
              <option value="1" ${settings.geocodeEnabled ? 'selected' : ''}>yes — use OpenStreetMap (free)</option>
              <option value="0" ${settings.geocodeEnabled ? '' : 'selected'}>no — coordinates only, nothing leaves this machine</option>
            </select>
          </div>
          <div><label>Keep raw readings for (days)</label><input name="sample_retention_days" value="${settings.sampleRetentionDays}"></div>
        </div>
        <p class="small">Reads while the car is asleep come from Tesla's cache and are not billed, which is why the asleep interval can stay slow without losing miles — the odometer still tells the whole story. Estimated usage this month: ${usage.credits} credits over ${usage.calls} reads.</p>
        <button class="primary" type="submit">Save settings</button>
      </form>`,
      { title: 'How the ledger behaves' },
    )}

    ${card(
      `<p class="small">Connector in use: <strong>${escape(settings.connector)}</strong>${
        vehicles.length === 0 ? '' : ` · ${vehicles.map((vehicle) => escape(vehicle.displayName)).join(', ')}`
      }</p>
      <div class="row">
        <a class="btn primary" href="/connect">Change how the car is read</a>
        <form method="post" action="/rebuild" class="inlineform"><button type="submit">Rebuild trips from raw readings</button></form>
        <form method="post" action="/reclassify" class="inlineform"><button type="submit">Re-check every category</button></form>
      </div>`,
      { title: 'The car' },
    )}

    ${card(
      `<div class="scroll"><table>
        <thead><tr><th>From</th><th>To</th><th class="n">Business ¢/mi</th><th class="n">Medical</th><th class="n">Charity</th><th>Source</th></tr></thead>
        <tbody>${rateRows}</tbody>
      </table></div>
      <form method="post" action="/settings/rates" style="margin-top:12px">
        <div class="fields three">
          <div><label>Effective from</label><input type="date" name="from" required></div>
          <div><label>Effective to</label><input type="date" name="to" required></div>
          <div><label>Business cents per mile</label><input name="business" required placeholder="76"></div>
        </div>
        <div class="fields three">
          <div><label>Medical cents</label><input name="medical" placeholder="23.5"></div>
          <div><label>Charity cents</label><input name="charity" placeholder="14"></div>
          <div><label>Note</label><input name="note" placeholder="IRS Notice"></div>
        </div>
        <button type="submit">Add or update a rate</button>
      </form>
      <p class="small">Rates ship with the app but are editable, because the IRS changes them — sometimes in the middle of a year. Confirm against irs.gov or with your accountant.</p>`,
      { title: 'IRS standard mileage rates' },
    )}

    ${card(
      `<form method="post" action="/settings/passcode">
        <div class="fields two">
          <div><label>${options.passcodeSet ? 'New passcode' : 'Set a passcode'}</label><input type="password" name="passcode" placeholder="${options.passcodeSet ? 'leave blank to remove' : 'protects the ledger'}"></div>
          <div style="align-self:end"><button class="primary" type="submit">${options.passcodeSet ? 'Change passcode' : 'Set passcode'}</button></div>
        </div>
      </form>
      <p class="small">${
        options.passcodeSet
          ? 'A passcode is set. Clearing it leaves the app open to anyone who can reach it, which is only sensible on a machine nobody else touches.'
          : 'With no passcode the app only accepts connections from this machine. Set one before exposing it to your network.'
      }</p>`,
      { title: 'Access' },
    )}

    ${card(
      `<form method="post" action="/import">
        <div class="field">
          <label>Load a CSV file</label>
          <input type="file" accept=".csv,text/csv" onchange="mlReadFile(this, 'csv-body')">
          <div class="small" id="csv-body-name"></div>
        </div>
        <div class="field">
          <label>…or paste the rows here</label>
          <textarea id="csv-body" name="csv" placeholder="timestamp,odometer,latitude,longitude&#10;2026-01-04 08:12:00,41230.4,46.8772,-96.7898"></textarea>
        </div>
        <button class="primary" type="submit">Import</button>
      </form>
      <p class="small">Two shapes are understood, and the file is inspected to work out which: a log of <strong>readings</strong> (a timestamp and an odometer, optionally coordinates), or one row per <strong>completed trip</strong> (start, end, distance, and a category if you have one). Readings go through the same processing as live data. Times without a zone are read in ${escape(settings.timezone)}.</p>`,
      { title: 'Bring in history from elsewhere' },
    )}
  `;
  return layout({ title: 'Settings', nav: 'settings', body, status: context.status, flash: context.flash });
}

export function connectPage(context: ViewContext, options: { baseUrl: string; hasFleetApp: boolean }): string {
  const { settings, db } = context;
  const fleetToken = repo.getToken(db, 'fleet');
  const ownerToken = repo.getToken(db, 'owner');
  const regions = Object.keys(FLEET_REGIONS);

  const body = `
    <div class="head"><h1>Reading your Tesla</h1><div class="small">Mileage comes from the car's own odometer. Pick how the app gets to it.</div></div>

    <div class="notice">Currently using: <strong>${escape(settings.connector)}</strong>${
      settings.connector === 'fleet' && fleetToken?.refreshToken !== null && fleetToken !== null ? ' — connected' : ''
    }${settings.connector === 'owner' && ownerToken?.refreshToken !== null && ownerToken !== null ? ' — connected' : ''}</div>

    ${card(
      `<p>Tesla's supported interface. It needs a free developer application and a domain you control, because Tesla verifies the domain before it will talk to an app. Usage is metered, and Tesla includes a monthly allowance; this app is built to stay inside it by reading cached data while the car is parked and never waking it.</p>
       <ol class="small" style="padding-left:20px">
         <li>Create an application at <code>developer.tesla.com</code>. Ask for the scopes <code>vehicle_device_data</code> and <code>vehicle_location</code>, plus <code>offline_access</code>.</li>
         <li>Put your public key at <code>https://your-domain/.well-known/appspecific/com.tesla.3p.public-key.pem</code>.</li>
         <li>Set the redirect URI to <code>${escape(options.baseUrl === '' ? 'https://your-domain/callback' : `${options.baseUrl}/callback`)}</code>.</li>
         <li>Put the client ID and secret in the app's <code>.env</code> file, then register the domain below.</li>
       </ol>
       ${
         options.hasFleetApp
           ? `<div class="row">
                <a class="btn primary" href="/connect/oauth/start">Sign in with Tesla</a>
                <form method="post" action="/connect/register" class="row inlineform">
                  <input name="domain" placeholder="your-domain.com" style="width:auto">
                  <select name="region" style="width:auto">${regions.map((region) => `<option value="${region}">${escape(region.toUpperCase())}</option>`).join('')}</select>
                  <button type="submit">Register the domain</button>
                </form>
              </div>`
           : `<div class="notice warn">No client ID is configured yet. Add <code>TESLA_CLIENT_ID</code> and <code>TESLA_CLIENT_SECRET</code> to <code>.env</code> and restart, or use one of the options below.</div>`
       }`,
      { title: 'Option 1 — the official Fleet API' },
    )}

    ${card(
      `<p>If you already have a Tesla refresh token from another tool, paste it here. Nothing else is needed: no domain, no developer application. This route uses Tesla's older owner interface, which community tools have relied on for years but which Tesla does not officially support and could change.</p>
       <form method="post" action="/connect/token">
         <div class="fields two">
           <div><label>Refresh token</label><input name="refreshToken" required placeholder="eyJ..."></div>
           <div>
             <label>Which interface is this token for?</label>
             <select name="mode">
               <option value="owner">Owner API (tokens from third-party token apps)</option>
               <option value="fleet">Fleet API (a token from your own developer app)</option>
             </select>
           </div>
         </div>
         <div class="field"><label>Region</label><select name="region" style="width:auto">${regions.map((region) => `<option value="${region}">${escape(region.toUpperCase())}</option>`).join('')}</select></div>
         <button class="primary" type="submit">Save the token and start reading</button>
       </form>`,
      { title: 'Option 2 — paste a refresh token' },
    )}

    ${card(
      `<p>No car needed. A simulated Model Y with a few weeks of realistic driving, so you can see the trip list, the review queue, the learning suggestions and the CPA report before committing to anything. Demo trips are marked in the ledger, and you can clear them later.</p>
       <form method="post" action="/connect/demo"><button class="primary" type="submit">Turn on the demo car</button></form>`,
      { title: 'Option 3 — try it with a demo car' },
    )}

    ${card(
      `<p>Bring in a CSV from TeslaMate, Tessie, TeslaFi, or a spreadsheet you keep by hand, and leave live reading switched off entirely. The app works the same way on imported data.</p>
       <div class="row">
         <a class="btn" href="/settings#import">Import a CSV</a>
         <form method="post" action="/connect/disconnect" class="inlineform"><button type="submit">Stop reading the car</button></form>
       </div>`,
      { title: 'Option 4 — files only' },
    )}
  `;
  return layout({ title: 'Connect', nav: 'settings', body, status: context.status, flash: context.flash });
}

export function loginPage(options: { error: string | null }): string {
  const body = `
    <div style="max-width:380px;margin:8vh auto">
      ${card(
        `<h1 style="margin-bottom:10px">Mile Ledger</h1>
         <p class="small">Enter your passcode to open the ledger.</p>
         ${options.error === null ? '' : `<div class="notice alert">${escape(options.error)}</div>`}
         <form method="post" action="/login">
           <div class="field"><label>Passcode</label><input type="password" name="passcode" autofocus required></div>
           <button class="primary" type="submit" style="width:100%">Open</button>
         </form>`,
      )}
    </div>`;
  return layout({ title: 'Sign in', nav: null, body, status: null, flash: null });
}
