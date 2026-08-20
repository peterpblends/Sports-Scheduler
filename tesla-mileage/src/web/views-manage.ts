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
import {
  badge,
  card,
  checkField,
  emptyState,
  escape,
  layout,
  milesText,
  money,
  numberField,
  selectField,
  stat,
  textField,
} from './ui.ts';
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

function placeForm(
  place: Partial<Place>,
  options: { action: string; returnTo: string; heading: string; submit: string },
): string {
  const kind = place.kind ?? 'address';
  const label = place.label ?? 'business';
  return `<form method="post" action="${escape(options.action)}">
    <input type="hidden" name="return" value="${escape(options.returnTo)}">
    <div class="fields two">
      ${textField({
        id: 'place-name',
        name: 'name',
        label: 'Name',
        value: place.name ?? '',
        placeholder: 'Acme Warehouse, Home, all of Fargo',
        required: true,
        autocomplete: 'off',
      })}
      ${selectField({
        id: 'place-kind',
        name: 'kind',
        label: 'What is this?',
        value: kind,
        choices: [
          { value: 'address', label: 'A specific address or site' },
          { value: 'city', label: 'A whole city or town' },
          { value: 'region', label: 'A whole state or region' },
        ],
      })}
    </div>
    <div class="fields two">
      ${selectField({
        id: 'place-label',
        name: 'label',
        label: 'How should trips here be treated?',
        value: label,
        choices: (['business', 'personal', 'neutral'] as const).map((option) => ({
          value: option,
          label: `${option} — ${LABEL_HELP[option] ?? ''}`,
        })),
      })}
      ${textField({
        id: 'place-purpose',
        name: 'purpose',
        label: 'Default business purpose (optional)',
        value: place.purpose ?? '',
        placeholder: 'Site supervision',
      })}
    </div>
    <div class="fields two">
      ${textField({
        id: 'place-client',
        name: 'client',
        label: 'Client or project (optional)',
        value: place.client ?? '',
      })}
      ${textField({
        id: 'place-address',
        name: 'address',
        label: 'Street address (optional, for the report)',
        value: place.address ?? '',
        autocomplete: 'street-address',
      })}
    </div>
    <div class="fields three">
      ${textField({
        id: 'place-city',
        name: 'city',
        label: 'City',
        value: place.city ?? '',
        placeholder: 'Fargo',
        autocomplete: 'address-level2',
      })}
      ${textField({
        id: 'place-region',
        name: 'region',
        label: 'State or region',
        value: place.region ?? '',
        placeholder: 'North Dakota',
        autocomplete: 'address-level1',
      })}
      ${textField({
        id: 'place-postal',
        name: 'postal',
        label: 'Postal code',
        value: place.postal ?? '',
        inputmode: 'numeric',
        autocomplete: 'postal-code',
      })}
    </div>
    <div class="fields three">
      ${numberField({
        id: 'place-latitude',
        name: 'latitude',
        label: 'Latitude',
        value: place.latitude ?? '',
        placeholder: '46.8772',
        decimal: true,
      })}
      ${numberField({
        id: 'place-longitude',
        name: 'longitude',
        label: 'Longitude',
        value: place.longitude ?? '',
        placeholder: '-96.7898',
        decimal: true,
      })}
      ${numberField({
        id: 'place-radius',
        name: 'radiusMeters',
        label: 'How close counts as "here"? (meters)',
        value: place.radiusMeters ?? 200,
      })}
    </div>
    <div class="row" style="margin:4px 0 12px">
      ${checkField({ id: 'place-is-home', name: 'isHome', label: 'This is home', checked: place.isHome === true })}
      ${checkField({
        id: 'place-is-office',
        name: 'isPrimaryOffice',
        label: 'This is my regular office',
        checked: place.isPrimaryOffice === true,
      })}
    </div>
    ${textField({ id: 'place-notes', name: 'notes', label: 'Notes', value: place.notes ?? '' })}
    <p class="small">Marking home and a regular office lets the app separate commuting, which the IRS does not allow as a deduction, from business driving that it does.</p>
    <button class="primary" type="submit" data-busy="Saving…">${escape(options.submit)}</button>
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
                    <button class="small danger" type="submit" data-confirm="Remove this label? Past trips keep their categories unless you re-run the classifier.">Remove</button>
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
  return layout({
    title: 'Places',
    nav: 'places',
    body,
    status: context.status,
    flash: context.flash,
    appearance: context.settings.appearance,
    colour: context.settings.colour,
  });
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
              <button class="small danger" type="submit" data-confirm="Delete this rule?">Delete</button>
            </form>
          </div>
        </div>
      </div>`,
    )
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
          ${textField({
            id: 'rule-name',
            name: 'name',
            label: 'Name this rule',
            placeholder: 'Saturdays are personal',
            required: true,
          })}
          ${selectField({
            id: 'rule-classification',
            name: 'classification',
            label: 'Then record the trip as',
            value: 'business',
            choices: (['business', 'personal', 'commute', 'medical', 'charity'] as Classification[]).map(
              (option) => ({ value: option, label: option }),
            ),
          })}
        </div>
        <h3 style="margin-top:14px">Only when…</h3>
        <div class="fields two">
          ${selectField({
            id: 'rule-start-place',
            name: 'startPlaceId',
            label: 'Starts at',
            value: '',
            choices: [{ value: '', label: 'anywhere' }, ...places.map((place) => ({ value: String(place.id), label: place.name }))],
          })}
          ${selectField({
            id: 'rule-end-place',
            name: 'endPlaceId',
            label: 'Ends at',
            value: '',
            choices: [{ value: '', label: 'anywhere' }, ...places.map((place) => ({ value: String(place.id), label: place.name }))],
          })}
        </div>
        <div class="fields two">
          ${textField({ id: 'rule-city', name: 'city', label: 'City is', placeholder: 'Fargo' })}
          ${textField({ id: 'rule-region', name: 'region', label: 'State or region is', placeholder: 'North Dakota' })}
        </div>
        <fieldset>
          <legend>Days of the week</legend>
          <div class="chips">
            ${WEEKDAY_NAMES.map(
              (day, index) =>
                `<label class="chip"><input type="checkbox" name="weekdays" value="${index}"><span>${day}</span></label>`,
            ).join('')}
          </div>
        </fieldset>
        <div class="fields three">
          ${textField({ id: 'rule-after', name: 'after', label: 'Not before (local time)', type: 'time' })}
          ${textField({ id: 'rule-before', name: 'before', label: 'Not after (local time)', type: 'time' })}
          ${numberField({ id: 'rule-priority', name: 'priority', label: 'Priority (lower runs first)', value: 100 })}
        </div>
        <div class="fields two">
          ${numberField({ id: 'rule-min-miles', name: 'minMiles', label: 'At least this many miles', decimal: true })}
          ${numberField({ id: 'rule-max-miles', name: 'maxMiles', label: 'At most this many miles', decimal: true })}
        </div>
        <div class="fields two">
          ${textField({ id: 'rule-purpose', name: 'purpose', label: 'Set business purpose to' })}
          ${textField({ id: 'rule-client', name: 'client', label: 'Set client or project to' })}
        </div>
        <button class="primary" type="submit" data-busy="Adding…">Add this rule</button>
      </form>`,
      { title: 'Add a rule' },
    )}
  `;
  return layout({
    title: 'Rules',
    nav: 'rules',
    body,
    status: context.status,
    flash: context.flash,
    appearance: context.settings.appearance,
    colour: context.settings.colour,
  });
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
                  <button class="small danger" type="submit" data-confirm="Revoke this link? Anyone holding it loses access immediately.">Revoke</button>
                </form>
              </div>
              <div class="copy" style="margin-top:8px">
                <label class="small" for="share-${escape(share.token)}" style="position:absolute;left:-9999px">Link for ${escape(share.name)}</label>
                <input id="share-${escape(share.token)}" readonly value="${escape(shareUrl(context, share.token))}">
                <button class="small" type="button" data-copy="share-${escape(share.token)}">Copy</button>
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
        <div style="flex:1 1 150px">${textField({ id: 'export-from', name: 'from', label: 'From', type: 'date', value: period.rawFrom ?? '' })}</div>
        <div style="flex:1 1 150px">${textField({ id: 'export-to', name: 'to', label: 'To', type: 'date', value: period.rawTo ?? '' })}</div>
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
         <div style="flex:1 1 220px">
           ${textField({
             id: 'share-name',
             name: 'name',
             label: 'What is this link for?',
             placeholder: 'CPA — tax year 2026',
           })}
         </div>
         <div style="align-self:end"><button class="primary small" type="submit" data-busy="Creating…">Create a link</button></div>
       </form>
       ${
         context.settings.connector === 'demo'
           ? '<p class="small">Heads up: this ledger is currently full of demo data.</p>'
           : ''
       }`,
      { title: 'A standing link for your CPA' },
    )}
  `;
  return layout({
    title: 'Export',
    nav: 'export',
    body,
    status: context.status,
    flash: context.flash,
    appearance: context.settings.appearance,
    colour: context.settings.colour,
  });
}

/**
 * Absolute link when a base URL is configured, otherwise a relative one — which
 * still works when copied out of the browser's address bar.
 */
function shareUrl(context: ViewContext, token: string): string {
  const configured = (context.db.setting('base_url') ?? config.baseUrl).replace(/\/$/, '');
  return `${configured}/share/${token}`;
}


/** Theme and colour, as two independent choices. */
export function appearanceCard(settings: { appearance: string; colour: string }): string {
  const themes: { value: string; label: string; hint: string }[] = [
    { value: 'system', label: 'Follow device', hint: 'light or dark to match your phone or computer' },
    { value: 'light', label: 'Light', hint: 'always light' },
    { value: 'dark', label: 'Dark', hint: 'always dark' },
  ];
  const colours: { value: string; label: string; hint: string }[] = [
    { value: 'colour', label: 'Full colour', hint: 'green for business, amber for commuting' },
    { value: 'mono', label: 'Black and white', hint: 'no colour anywhere; categories are shown by shape and label' },
  ];

  const group = (
    name: string,
    current: string,
    choices: { value: string; label: string; hint: string }[],
  ): string =>
    `<div class="chips" role="radiogroup">
      ${choices
        .map(
          (choice) => `<label class="chip">
            <input type="radio" name="${name}" value="${escape(choice.value)}" ${current === choice.value ? 'checked' : ''}>
            <span>${escape(choice.label)}</span>
          </label>`,
        )
        .join('')}
    </div>
    <div class="small" style="margin-top:6px">${escape(choices.find((choice) => choice.value === current)?.hint ?? '')}</div>`;

  return card(
    `<form method="post" action="/appearance" data-autosubmit>
      <fieldset>
        <legend>Theme</legend>
        ${group('appearance', settings.appearance, themes)}
      </fieldset>
      <fieldset>
        <legend>Colour</legend>
        ${group('colour', settings.colour, colours)}
      </fieldset>
      <div class="swatches" aria-hidden="true">
        <span class="swatch ink"></span><span class="swatch accent"></span>
        <span class="swatch business"></span><span class="swatch commute"></span><span class="swatch pending"></span>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" type="submit">Save appearance</button>
        <span class="small">Saved with your ledger, so it stays put after a refresh, a sign-out, or a restart.</span>
      </div>
    </form>`,
    { title: 'Appearance' },
  );
}

/**
 * Everything that does not earn a slot in the phone navigation bar.
 *
 * A real page rather than a pop-out menu: it works without JavaScript, it can be
 * bookmarked, and the back button behaves.
 */
export function morePage(context: ViewContext, options: { passcodeSet: boolean }): string {
  const { db, settings } = context;
  const reviewCount = repo.countTrips(db, { needsReview: true });
  const suggestions = repo.listSuggestions(db).length;

  const tile = (href: string, icon: string, title: string, detail: string, badgeText?: string): string =>
    `<a class="tile" href="${escape(href)}">
      <span class="ico" aria-hidden="true">${icon}</span>
      <span>
        <strong>${escape(title)} ${badgeText === undefined ? '' : `<span class="badge unclassified">${escape(badgeText)}</span>`}</strong>
        <span class="small">${escape(detail)}</span>
      </span>
    </a>`;

  const body = `
    <div class="head"><h1>More</h1><div class="small">Everything not on the bar at the bottom.</div></div>

    <div class="tiles">
      ${tile('/trips?review=1', '◔', 'Trips needing a decision', reviewCount === 0 ? 'Nothing waiting on you' : `${reviewCount} to sort out`, reviewCount === 0 ? undefined : String(reviewCount))}
      ${tile('/rules', '⚙', 'Rules', suggestions === 0 ? 'How trips are categorised automatically' : `${suggestions} pattern${suggestions === 1 ? '' : 's'} waiting for approval`)}
      ${tile('/places', '⌖', 'Places', 'Label the addresses and cities you drive to')}
      ${tile('/connect', '⇄', 'The car', `Currently reading from: ${settings.connector}`)}
      ${tile('/settings', '⚑', 'Settings', 'Appearance, time zone, IRS rates, import, passcode')}
      ${tile('/export', '↧', 'Export', 'Reports and spreadsheets for your accountant')}
    </div>

    ${appearanceCard(settings)}

    ${card(
      `<div class="row between">
        <div>
          <strong>${options.passcodeSet ? 'This ledger is locked with a passcode' : 'No passcode set'}</strong>
          <div class="small">${
            options.passcodeSet
              ? 'Signing out will ask for it again next time.'
              : 'The app only accepts connections from this machine. Set a passcode in Settings before exposing it to your network.'
          }</div>
        </div>
        ${
          options.passcodeSet
            ? `<form method="post" action="/logout"><button type="submit" data-confirm="Sign out of this ledger?">Sign out</button></form>`
            : `<a class="btn" href="/settings">Set a passcode</a>`
        }
      </div>`,
      { title: 'Access' },
    )}
  `;

  return layout({
    title: 'More',
    nav: 'more',
    body,
    status: context.status,
    flash: context.flash,
    appearance: settings.appearance,
    colour: settings.colour,
  });
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

    ${appearanceCard(settings)}

    ${card(
      `<form method="post" action="/settings">
        <div class="fields two">
          ${textField({
            id: 'business_name',
            label: 'Business name (printed on the report)',
            value: settings.businessName,
            autocomplete: 'organization',
          })}
          ${textField({
            id: 'owner_name',
            label: 'Your name',
            value: settings.ownerName,
            autocomplete: 'name',
          })}
        </div>
        <div class="fields two">
          ${textField({
            id: 'vehicle_description',
            label: 'Vehicle description',
            value: settings.vehicleDescription,
            placeholder: '2024 Tesla Model Y',
          })}
          ${textField({
            id: 'timezone',
            label: 'Time zone',
            value: settings.timezone,
            placeholder: 'America/Chicago',
            hint: 'Decides which day — and which tax year — a trip falls in. Use a name like America/Chicago.',
          })}
        </div>
        <h3 style="margin-top:16px">How to treat a trip nothing explains</h3>
        <div class="fields two">
          ${selectField({
            id: 'fallback_classification',
            label: 'Unmatched trips become',
            value: settings.fallback,
            choices: (['unclassified', 'personal', 'business'] as Classification[]).map((option) => ({
              value: option,
              label: option === 'unclassified' ? 'unclassified — ask me' : option,
            })),
          })}
          ${selectField({
            id: 'commute_handling',
            label: 'Home to the regular office is',
            value: settings.commuteHandling,
            choices: [
              { value: 'commute', label: 'commute — tracked, not deducted (IRS treatment)' },
              { value: 'personal', label: 'personal' },
              { value: 'business', label: 'business — only if your accountant says so' },
            ],
          })}
        </div>
        <h3 style="margin-top:16px">Learning</h3>
        <div class="fields three">
          ${numberField({
            id: 'learn_min_observations',
            label: 'Corrections before a pattern is proposed',
            value: settings.learnMinObservations,
          })}
          ${numberField({
            id: 'learn_agreement',
            label: 'Agreement required (0–1)',
            value: settings.learnAgreement,
            decimal: true,
          })}
          ${selectField({
            id: 'auto_apply_learned',
            label: 'Apply learned patterns',
            value: settings.autoApplyLearned ? '1' : '0',
            choices: [
              { value: '0', label: 'only after I approve them' },
              { value: '1', label: 'automatically, without asking' },
            ],
          })}
        </div>
        <h3 style="margin-top:16px">Reading the car</h3>
        <div class="fields three">
          ${numberField({
            id: 'poll_driving_seconds',
            label: 'While driving, read every (seconds)',
            value: settings.pollDrivingSeconds,
          })}
          ${numberField({
            id: 'poll_awake_seconds',
            label: 'While parked and awake (seconds)',
            value: settings.pollAwakeSeconds,
          })}
          ${numberField({
            id: 'poll_asleep_seconds',
            label: 'While asleep (seconds)',
            value: settings.pollAsleepSeconds,
          })}
        </div>
        <div class="fields three">
          ${numberField({
            id: 'credit_budget',
            label: 'Monthly API credit ceiling',
            value: settings.creditBudget,
          })}
          ${selectField({
            id: 'geocode_enabled',
            label: 'Look up street addresses',
            value: settings.geocodeEnabled ? '1' : '0',
            choices: [
              { value: '1', label: 'yes — use OpenStreetMap (free)' },
              { value: '0', label: 'no — coordinates only, nothing leaves this machine' },
            ],
          })}
          ${numberField({
            id: 'sample_retention_days',
            label: 'Keep raw readings for (days)',
            value: settings.sampleRetentionDays,
          })}
        </div>
        <p class="small">Reads while the car is asleep come from Tesla's cache and are not billed, which is why the asleep interval can stay slow without losing miles — the odometer still tells the whole story. Estimated usage this month: ${usage.credits} credits over ${usage.calls} reads.</p>
        <button class="primary" type="submit" data-busy="Saving…">Save settings</button>
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
        <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" class="n">Business ¢/mi</th><th scope="col" class="n">Medical</th><th scope="col" class="n">Charity</th><th scope="col">Source</th></tr></thead>
        <tbody>${rateRows}</tbody>
      </table></div>
      <form method="post" action="/settings/rates" style="margin-top:12px">
        <div class="fields three">
          ${textField({ id: 'rate-from', name: 'from', label: 'Effective from', type: 'date', required: true })}
          ${textField({ id: 'rate-to', name: 'to', label: 'Effective to', type: 'date', required: true })}
          ${numberField({ id: 'rate-business', name: 'business', label: 'Business cents per mile', placeholder: '76', required: true, decimal: true })}
        </div>
        <div class="fields three">
          ${numberField({ id: 'rate-medical', name: 'medical', label: 'Medical cents', placeholder: '23.5', decimal: true })}
          ${numberField({ id: 'rate-charity', name: 'charity', label: 'Charity cents', placeholder: '14', decimal: true })}
          ${textField({ id: 'rate-note', name: 'note', label: 'Note', placeholder: 'IRS Notice' })}
        </div>
        <button type="submit" data-busy="Saving…">Add or update a rate</button>
      </form>
      <p class="small">Rates ship with the app but are editable, because the IRS changes them — sometimes in the middle of a year. Confirm against irs.gov or with your accountant.</p>`,
      { title: 'IRS standard mileage rates' },
    )}

    ${card(
      `<form method="post" action="/settings/passcode">
        <div class="fields two">
          ${textField({
            id: 'passcode',
            label: options.passcodeSet ? 'New passcode' : 'Set a passcode',
            type: 'password',
            placeholder: options.passcodeSet ? 'leave blank to remove' : 'protects the ledger',
            autocomplete: 'new-password',
          })}
          <div style="align-self:end"><button class="primary" type="submit" data-busy="Saving…">${options.passcodeSet ? 'Change passcode' : 'Set passcode'}</button></div>
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
      `<form method="post" action="/import" id="import-form">
        <div class="field">
          <label for="csv-file">Load a CSV file</label>
          <input type="file" id="csv-file" accept=".csv,text/csv" data-file-into="csv-body">
          <div class="small" id="csv-body-name" role="status"></div>
        </div>
        <div class="field">
          <label for="csv-body">…or paste the rows here</label>
          <textarea id="csv-body" name="csv" rows="6" spellcheck="false" placeholder="timestamp,odometer,latitude,longitude&#10;2026-01-04 08:12:00,41230.4,46.8772,-96.7898"></textarea>
        </div>
        <button class="primary" type="submit" data-busy="Importing…">Import</button>
      </form>
      <p class="small">Two shapes are understood, and the file is inspected to work out which: a log of <strong>readings</strong> (a timestamp and an odometer, optionally coordinates), or one row per <strong>completed trip</strong> (start, end, distance, and a category if you have one). Readings go through the same processing as live data. Times without a zone are read in ${escape(settings.timezone)}.</p>`,
      { title: 'Bring in history from elsewhere', id: 'import' },
    )}
  `;
  return layout({
    title: 'Settings',
    nav: 'settings',
    body,
    status: context.status,
    flash: context.flash,
    appearance: context.settings.appearance,
    colour: context.settings.colour,
  });
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
                <form method="post" action="/connect/register" class="row">
                  <div style="flex:1 1 200px">${textField({
                    id: 'register-domain',
                    name: 'domain',
                    label: 'Domain serving your public key',
                    placeholder: 'your-domain.com',
                    extraAttributes: 'spellcheck="false"',
                  })}</div>
                  <div style="flex:0 1 120px">${selectField({
                    id: 'register-region',
                    name: 'region',
                    label: 'Region',
                    value: 'na',
                    choices: regions.map((region) => ({ value: region, label: region.toUpperCase() })),
                  })}</div>
                  <div style="align-self:end"><button type="submit" data-busy="Registering…">Register the domain</button></div>
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
           ${textField({
             id: 'refresh-token',
             name: 'refreshToken',
             label: 'Refresh token',
             placeholder: 'eyJ...',
             required: true,
             extraAttributes: 'spellcheck="false"',
           })}
           ${selectField({
             id: 'token-mode',
             name: 'mode',
             label: 'Which interface is this token for?',
             value: 'owner',
             choices: [
               { value: 'owner', label: 'Owner API (tokens from third-party token apps)' },
               { value: 'fleet', label: 'Fleet API (a token from your own developer app)' },
             ],
           })}
         </div>
         ${selectField({
           id: 'token-region',
           name: 'region',
           label: 'Region',
           value: 'na',
           choices: regions.map((region) => ({ value: region, label: region.toUpperCase() })),
         })}
         <button class="primary" type="submit" data-busy="Connecting…">Save the token and start reading</button>
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
  return layout({
    title: 'Connect',
    nav: 'settings',
    body,
    status: context.status,
    flash: context.flash,
    appearance: context.settings.appearance,
    colour: context.settings.colour,
  });
}

export function loginPage(options: {
  error: string | null;
  appearance?: 'system' | 'light' | 'dark';
  colour?: 'colour' | 'mono';
}): string {
  const body = `
    <div style="max-width:380px;margin:8vh auto">
      ${card(
        `<h1 style="margin-bottom:10px">Mile Ledger</h1>
         <p class="small">Enter your passcode to open the ledger.</p>
         ${options.error === null ? '' : `<div class="notice alert">${escape(options.error)}</div>`}
         <form method="post" action="/login">
           ${textField({
             id: 'login-passcode',
             name: 'passcode',
             label: 'Passcode',
             type: 'password',
             required: true,
             autocomplete: 'current-password',
             extraAttributes: 'autofocus',
           })}
           <button class="primary" type="submit" style="width:100%" data-busy="Opening…">Open</button>
         </form>`,
      )}
    </div>`;
  return layout({
    title: 'Sign in',
    nav: null,
    body,
    status: null,
    flash: null,
    appearance: options.appearance ?? 'system',
    colour: options.colour ?? 'colour',
  });
}
