/**
 * The screens the owner spends time in: today's status and the trip list.
 *
 * The trip list is the heart of the app, so it is built around one interaction —
 * looking at a drive and saying what it was, in one tap, on a phone.
 */
import type { Database } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import type { AppSettings } from '../settings.ts';
import type { Classification, Trip, Place } from '../domain/types.ts';
import { type Summary } from '../export/summary.ts';
import { aggregateSummary } from '../export/aggregate.ts';
import {
  badge,
  card,
  emptyState,
  escape,
  layout,
  milesText,
  money,
  selectField,
  stat,
  textField,
  type NavKey,
  type StatusStrip,
} from './ui.ts';
import { PERIOD_CHOICES, periodQuery, resolvePeriod, type Period } from './period.ts';
import { chartLegend, monthlyMilesChart, type ChartRow } from './chart.ts';
import { humanAgo, humanDuration, localClock, localLongDate, localMonth, localMonthRange, localYear, localYearRange, nowIso } from '../lib/time.ts';
import { mapUrl } from '../lib/geo.ts';

export type ViewContext = {
  db: Database;
  settings: AppSettings;
  status: StatusStrip | null;
  flash: string | null;
  poller: { running: boolean; connector: string; lastAt: string | null; messages: string[] };
};

const QUICK: Classification[] = ['business', 'personal', 'commute'];
const EXTRA: Classification[] = ['medical', 'charity', 'unclassified'];

function tripTime(trip: Trip, timezone: string): string {
  return `${localLongDate(trip.startedAt, timezone)} · ${localClock(trip.startedAt, timezone)}`;
}

/** One trip, with the buttons that decide what it was. */
export function tripRow(
  trip: Trip,
  settings: AppSettings,
  options: { returnTo: string; expandable?: boolean } = { returnTo: '/trips' },
): string {
  const tz = settings.timezone;
  const back = escape(options.returnTo);
  const quick = QUICK.filter((option) => option !== trip.classification)
    .map(
      (option) => `<form method="post" action="/trips/${trip.id}/classify" class="inlineform">
        <input type="hidden" name="classification" value="${option}">
        <input type="hidden" name="return" value="${back}">
        <button class="small pick ${option}" type="submit">${option === 'business' ? 'Business' : option === 'personal' ? 'Personal' : 'Commute'}</button>
      </form>`,
    )
    .join('');

  const extra = EXTRA.map(
    (option) => `<form method="post" action="/trips/${trip.id}/classify" class="inlineform">
      <input type="hidden" name="classification" value="${option}">
      <input type="hidden" name="return" value="${back}">
      <button class="small" type="submit">${escape(option)}</button>
    </form>`,
  ).join('');

  const endLink =
    trip.endLatitude !== null && trip.endLongitude !== null && trip.endPlaceId === null
      ? ` <a class="small" href="/places/new?lat=${trip.endLatitude}&lon=${trip.endLongitude}&name=${encodeURIComponent(trip.endDescription ?? '')}&return=${encodeURIComponent(options.returnTo)}">label this address</a>`
      : '';

  const flags = [
    trip.locked ? '<span class="badge ghost" title="You decided this one">yours</span>' : '',
    trip.open ? '<span class="badge commute">in progress</span>' : '',
    trip.inferred ? '<span class="badge ghost" title="Rebuilt from the odometer across a gap in data">reconstructed</span>' : '',
  ].join(' ');

  return `<div class="trip${trip.needsReview ? ' review' : ''}">
    <div class="trip-head">
      <span class="when">${escape(tripTime(trip, tz))}</span>
      <span class="miles">${milesText(trip.distanceMiles)} mi</span>
    </div>
    <div class="route">${escape(trip.startDescription ?? 'Unknown')}<span class="arrow">→</span>${escape(trip.endDescription ?? 'Unknown')}${endLink}</div>
    <div class="tags">${badge(trip.classification)} <span class="when">${escape(humanDuration(trip.durationSeconds))}</span> ${flags}</div>
    <div class="why">${escape(trip.classificationReason ?? '')}${
      trip.purpose === null && trip.client === null
        ? ''
        : ` · ${escape([trip.purpose, trip.client].filter((part) => part !== null && part !== '').join(' — '))}`
    }</div>
    <div class="actions">
      ${quick}
      <button class="small" type="button" data-more="${trip.id}" aria-expanded="false" aria-controls="more-${trip.id}">More…</button>
    </div>
    <div class="actions" id="more-${trip.id}" hidden>
      ${extra}
      ${
        trip.locked
          ? `<form method="post" action="/trips/${trip.id}/unlock" class="inlineform">
              <input type="hidden" name="return" value="${back}">
              <button class="small" type="submit" title="Let rules decide this trip again">Undo my choice</button>
            </form>`
          : ''
      }
      ${
        trip.endLatitude === null
          ? ''
          : `<a class="btn small" target="_blank" rel="noreferrer" href="${escape(mapUrl({ latitude: trip.endLatitude, longitude: trip.endLongitude ?? 0 }))}">Map</a>`
      }
    </div>
    <details style="margin-top:10px">
      <summary class="small">Purpose, client and notes</summary>
      <form method="post" action="/trips/${trip.id}/details">
        <input type="hidden" name="return" value="${back}">
        <div class="fields three">
          ${textField({
            id: `purpose-${trip.id}`,
            name: 'purpose',
            label: 'Business purpose',
            value: trip.purpose ?? '',
            placeholder: 'Site visit, delivery, client meeting',
          })}
          ${textField({
            id: `client-${trip.id}`,
            name: 'client',
            label: 'Client or project',
            value: trip.client ?? '',
          })}
          ${textField({
            id: `notes-${trip.id}`,
            name: 'notes',
            label: 'Notes',
            value: trip.notes ?? '',
          })}
        </div>
        <div class="row" style="margin-top:8px">
          <button class="primary small" type="submit" data-busy="Saving…">Save</button>
          <span class="small">Odometer ${trip.startOdometerMiles === null ? '—' : milesText(trip.startOdometerMiles)} → ${trip.endOdometerMiles === null ? '—' : milesText(trip.endOdometerMiles)}</span>
        </div>
      </form>
    </details>
  </div>`;
}

function creditMeter(db: Database, settings: AppSettings): string {
  const month = localMonth(nowIso(), settings.timezone);
  const usage = repo.usageSummary(db, month);
  if (settings.connector === 'demo' || settings.connector === 'manual') {
    return `<div class="small">No Tesla API usage this month — running on ${settings.connector === 'demo' ? 'demo data' : 'imported data'}.</div>`;
  }
  const percent = settings.creditBudget === 0 ? 0 : Math.min(100, Math.round((usage.credits / settings.creditBudget) * 100));
  const level = percent >= 100 ? 'alert' : percent >= 85 ? 'warn' : '';
  return `<div class="small">Estimated Tesla API usage this month: <strong>${usage.credits}</strong> of your ${settings.creditBudget} credit ceiling · ${usage.calls} reads, ${usage.cachedCalls} of them free from cache</div>
    <div class="meter"><i class="${level}" style="width:${percent}%"></i></div>
    ${percent >= 85 ? `<div class="small" style="margin-top:6px">Reads are being spaced out to stay inside the ceiling. Miles are still captured from the odometer.</div>` : ''}`;
}

function setupChecklist(db: Database, settings: AppSettings): string {
  const items: string[] = [];
  if (settings.connector === 'manual') {
    items.push(`<li><a href="/connect">Connect your Tesla</a> — or import a CSV, or switch on the demo car to look around first.</li>`);
  }
  const places = repo.listPlaces(db);
  if (places.length === 0) {
    items.push(`<li><a href="/places/new">Label your first address</a> — start with home and one place you go for work.</li>`);
  } else {
    if (!places.some((place) => place.isHome)) {
      items.push(`<li><a href="/places">Mark which place is home</a>, so commuting can be told apart from business driving.</li>`);
    }
    if (!places.some((place) => place.label === 'business')) {
      items.push(`<li><a href="/places/new">Label a business address</a> — that is what turns drives into deductible miles.</li>`);
    }
  }
  if (items.length === 0) return '';
  return `<div class="notice"><strong>To finish setting up</strong><ul class="rule-list" style="margin:8px 0 0;padding-left:20px">${items.join('')}</ul></div>`;
}

function suggestionsCard(db: Database): string {
  const suggestions = repo.listSuggestions(db);
  if (suggestions.length === 0) return '';
  const rows = suggestions
    .slice(0, 6)
    .map(
      (suggestion) => `<div class="trip">
        <div class="row between">
          <div><strong>${escape(suggestion.description)}</strong></div>
          ${badge(suggestion.classification)}
        </div>
        <div class="actions">
          <form method="post" action="/suggestions/${suggestion.id}/accept" class="inlineform">
            <button class="primary small" type="submit">${suggestion.signature.startsWith('place:') ? 'Label that address' : 'Do this automatically'}</button>
          </form>
          <form method="post" action="/suggestions/${suggestion.id}/dismiss" class="inlineform">
            <button class="small" type="submit">No thanks</button>
          </form>
        </div>
      </div>`,
    )
    .join('');
  return card(
    `<p class="small">These come from the choices you have already made. Nothing is applied until you say so.</p>${rows}`,
    { title: 'Patterns worth automating' },
  );
}

export function dashboardPage(context: ViewContext): string {
  const { db, settings } = context;
  const tz = settings.timezone;
  const year = localYear(nowIso(), tz);
  const yearRange = localYearRange(year, tz);
  const monthKey = localMonth(nowIso(), tz);
  const monthRange = localMonthRange(monthKey, tz);
  const rates = repo.ratePeriods(db);

  const yearSummary = aggregateSummary(db, {
    timezone: tz,
    rates,
    from: yearRange.from,
    to: yearRange.to,
  });
  const monthSummary = aggregateSummary(db, {
    timezone: tz,
    rates,
    from: monthRange.from,
    to: monthRange.to,
  });

  const business = yearSummary.byClassification.business ?? { trips: 0, miles: 0, deduction: 0 };
  const review = repo.unclassifiedTrips(db, 8);
  const reviewCount = repo.countTrips(db, { needsReview: true });
  const vehicles = repo.listVehicles(db);
  const vehicle = vehicles[0];

  const stats = `<div class="stats">
    ${stat(`${year} business miles`, milesText(business.miles), `${business.trips} trips`, true)}
    ${stat('Estimated deduction', money(yearSummary.deduction), 'at IRS standard rates', true)}
    ${stat('All miles this year', milesText(yearSummary.totalMiles), `${yearSummary.businessPercent}% business`)}
    ${stat('This month', `${milesText(monthSummary.byClassification.business?.miles ?? 0)} mi`, `business · ${money(monthSummary.deduction)}`)}
  </div>`;

  const vehicleCard = card(
    `<div class="row between">
      <div>
        <strong>${escape(vehicle?.displayName ?? 'No vehicle yet')}</strong>
        <div class="small">${
          vehicle === undefined
            ? 'Connect a Tesla, import a file, or turn on the demo car.'
            : `Odometer ${vehicle.lastOdometerMiles === null ? '—' : `${milesText(vehicle.lastOdometerMiles)} mi`} · ${
                vehicle.lastSampleAt === null ? 'never read' : `last read ${humanAgo(vehicle.lastSampleAt)}`
              }`
        }</div>
      </div>
      <form method="post" action="/poll-now"><button class="small" type="submit">Check now</button></form>
    </div>
    <hr>
    ${creditMeter(db, settings)}
    ${
      context.poller.messages.length === 0
        ? ''
        : `<div class="notice warn" style="margin:10px 0 0">${context.poller.messages.map((message) => escape(message)).join('<br>')}</div>`
    }`,
    { title: 'The car' },
  );

  const reviewCard =
    review.length === 0
      ? card(
          emptyState('✓', 'Nothing waiting on you', 'Every trip has a category. New drives will show up here when they need a decision.'),
          { title: 'Needs a decision' },
        )
      : card(
          `<p class="small">${reviewCount} trip${reviewCount === 1 ? '' : 's'} to sort out. One tap each.</p>
           ${review.map((trip) => tripRow(trip, settings, { returnTo: '/' })).join('')}
           ${reviewCount > review.length ? `<div style="margin-top:12px"><a class="btn" href="/trips?review=1">See all ${reviewCount}</a></div>` : ''}`,
          { title: 'Needs a decision' },
        );

  const chartRows: ChartRow[] = yearSummary.months.map((month) => ({
    // Short month name; the year is implied by the period.
    label: month.label.split(' ')[0]?.slice(0, 3) ?? month.month,
    business: month.business.miles,
    other: Math.round((month.totalMiles - month.business.miles) * 10) / 10,
  }));

  const trendCard =
    chartRows.length === 0
      ? ''
      : card(
          `${monthlyMilesChart(chartRows, { idPrefix: 'dash' })}
           ${chartLegend({ businessLabel: 'Business miles', otherLabel: 'Personal, commute and undecided' })}
           <div class="scroll" style="margin-top:12px">
             <table>
               <thead><tr><th scope="col">Month</th><th scope="col" class="n">Business</th><th scope="col" class="n">Other</th><th scope="col" class="n">Deduction</th></tr></thead>
               <tbody>
                 ${yearSummary.months
                   .slice(-8)
                   .map(
                     (month) => `<tr>
                       <th scope="row" style="font-weight:400;text-transform:none;letter-spacing:0">${escape(month.label)}</th>
                       <td class="n">${milesText(month.business.miles)}</td>
                       <td class="n">${milesText(Math.round((month.totalMiles - month.business.miles) * 10) / 10)}</td>
                       <td class="n">${month.business.deduction === 0 ? '—' : money(month.business.deduction)}</td>
                     </tr>`,
                   )
                   .join('')}
               </tbody>
             </table>
           </div>`,
          { title: `Miles by month, ${year}` },
        );

  const monthTable = card(
    `<div class="scroll"><table>
      <thead><tr><th scope="col">Category</th><th scope="col" class="n">Trips</th><th scope="col" class="n">Miles</th><th scope="col" class="n">Deduction</th></tr></thead>
      <tbody>
        ${(['business', 'commute', 'personal', 'unclassified'] as Classification[])
          .map((key) => {
            const totals = monthSummary.byClassification[key] ?? { trips: 0, miles: 0, deduction: 0 };
            return `<tr><th scope="row" style="font-weight:400;text-transform:none;letter-spacing:0">${badge(key)}</th><td class="n">${totals.trips}</td><td class="n">${milesText(totals.miles)}</td><td class="n">${totals.deduction === 0 ? '—' : money(totals.deduction)}</td></tr>`;
          })
          .join('')}
      </tbody>
    </table></div>
    <div class="row" style="margin-top:12px">
      <a class="btn primary" href="/export">Export for the CPA</a>
      <a class="btn" href="/trips">Look at every trip</a>
    </div>`,
    { title: `${escape(monthSummary.months[0]?.label ?? 'This month')} so far` },
  );

  const body = `
    <div class="head"><h1>Today</h1><div class="small">Everything below is current as of the last read from the car.</div></div>
    ${setupChecklist(db, settings)}
    ${stats}
    <div style="height:14px"></div>
    ${reviewCard}
    ${suggestionsCard(db)}
    ${trendCard}
    <div class="spread two">${vehicleCard}${monthTable}</div>
  `;

  return layout({
    title: 'Today',
    nav: 'today',
    body,
    status: context.status,
    flash: context.flash,
    appearance: settings.appearance,
    colour: settings.colour,
  });
}

export type TripListParams = {
  period: Period;
  classification: string;
  reviewOnly: boolean;
  search: string;
  page: number;
  /** Limit to trips that started or ended at one labelled place. */
  placeId?: number;
  placeName?: string;
};

export function tripsPage(context: ViewContext, params: TripListParams): string {
  const { db, settings } = context;
  const tz = settings.timezone;
  const rates = repo.ratePeriods(db);
  const perPage = 40;

  const filter = {
    from: params.period.from,
    to: params.period.to,
    classification: params.classification === 'all' ? undefined : (params.classification as Classification),
    needsReview: params.reviewOnly ? true : undefined,
    search: params.search === '' ? undefined : params.search,
    placeId: params.placeId,
  };

  const total = repo.countTrips(db, filter);
  const trips = repo.listTrips(db, { ...filter, limit: perPage, offset: (params.page - 1) * perPage });
  const summary = aggregateSummary(db, {
    timezone: tz,
    rates,
    from: params.period.from,
    to: params.period.to,
    filter,
    months: false,
  });

  const base = (overrides: Record<string, string>): string => {
    const params2 = new URLSearchParams(periodQuery(params.period));
    if (params.classification !== 'all') params2.set('category', params.classification);
    if (params.reviewOnly) params2.set('review', '1');
    if (params.search !== '') params2.set('q', params.search);
    if (params.placeId !== undefined) params2.set('place', String(params.placeId));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === '') params2.delete(key);
      else params2.set(key, value);
    }
    params2.delete('page');
    return `/trips?${params2.toString()}`;
  };

  const periodChips = PERIOD_CHOICES.map(
    (choice) =>
      `<a class="chip" ${params.period.key === choice.key ? 'aria-current="true"' : ''} href="/trips?period=${choice.key}${params.classification === 'all' ? '' : `&category=${params.classification}`}${params.reviewOnly ? '&review=1' : ''}">${escape(choice.label)}</a>`,
  ).join('');

  const categoryChips = ['all', 'business', 'personal', 'commute', 'unclassified']
    .map(
      (key) =>
        `<a class="chip" ${params.classification === key ? 'aria-current="true"' : ''} href="${escape(base({ category: key === 'all' ? '' : key }))}">${escape(key === 'all' ? 'Every category' : key)}</a>`,
    )
    .join('');

  const pages = Math.max(1, Math.ceil(total / perPage));
  const pager =
    pages <= 1
      ? ''
      : `<div class="row between" style="margin-top:14px">
          ${params.page > 1 ? `<a class="btn small" href="${escape(base({}))}&page=${params.page - 1}">← Newer</a>` : '<span></span>'}
          <span class="small">Page ${params.page} of ${pages}</span>
          ${params.page < pages ? `<a class="btn small" href="${escape(base({}))}&page=${params.page + 1}">Older →</a>` : '<span></span>'}
        </div>`;

  const body = `
    <div class="head"><h1>Trips</h1><div class="small">${escape(params.period.label)} · ${total} trip${total === 1 ? '' : 's'}${
      params.placeName === undefined ? '' : ` · at ${escape(params.placeName)}`
    }</div></div>
    ${
      params.placeName === undefined
        ? ''
        : `<div class="notice">Showing only trips that started or ended at <strong>${escape(params.placeName)}</strong>. <a href="/trips">Show every trip</a></div>`
    }

    <section class="card tight">
      <div class="chips" style="margin-bottom:8px">${periodChips}</div>
      <div class="chips" style="margin-bottom:8px">${categoryChips}
        <a class="chip" ${params.reviewOnly ? 'aria-current="true"' : ''} href="${escape(base({ review: params.reviewOnly ? '' : '1' }))}">Needs a decision</a>
      </div>
      <form method="get" action="/trips" class="row" role="search">
        <input type="hidden" name="period" value="${escape(params.period.key)}">
        ${params.period.rawFrom === undefined ? '' : `<input type="hidden" name="from" value="${escape(params.period.rawFrom)}">`}
        ${params.period.rawTo === undefined ? '' : `<input type="hidden" name="to" value="${escape(params.period.rawTo)}">`}
        ${params.classification === 'all' ? '' : `<input type="hidden" name="category" value="${escape(params.classification)}">`}
        ${params.reviewOnly ? '<input type="hidden" name="review" value="1">' : ''}
        <div style="flex:1 1 200px">
          ${textField({
            id: 'trip-search',
            name: 'q',
            label: 'Search trips',
            type: 'search',
            inputmode: 'search',
            value: params.search,
            placeholder: 'A place, client or note',
            extraAttributes: 'enterkeyhint="search"',
          })}
        </div>
        <div style="align-self:end"><button type="submit" class="small">Search</button></div>
      </form>
    </section>

    <div class="stats" style="margin-bottom:14px">
      ${stat('Business', `${milesText(summary.byClassification.business?.miles ?? 0)} mi`, money(summary.deduction), true)}
      ${stat('Personal', `${milesText(summary.byClassification.personal?.miles ?? 0)} mi`)}
      ${stat('Commute', `${milesText(summary.byClassification.commute?.miles ?? 0)} mi`, 'not deductible')}
      ${stat('Undecided', `${milesText(summary.byClassification.unclassified?.miles ?? 0)} mi`, `${summary.unclassifiedTrips} trips`)}
    </div>

    <section class="card">
      ${
        trips.length === 0
          ? emptyState('◔', 'No trips here', 'Try a wider period, or clear the filters above.')
          : trips.map((trip) => tripRow(trip, settings, { returnTo: base({}) })).join('')
      }
      ${pager}
    </section>

    ${
      trips.length === 0
        ? ''
        : `<section class="card tight">
            <form method="post" action="/trips/bulk" class="row">
              <input type="hidden" name="return" value="${escape(base({}))}">
              <input type="hidden" name="from" value="${escape(params.period.from ?? '')}">
              <input type="hidden" name="to" value="${escape(params.period.to ?? '')}">
              <input type="hidden" name="category" value="${escape(params.classification)}">
              <input type="hidden" name="review" value="${params.reviewOnly ? '1' : ''}">
              <input type="hidden" name="q" value="${escape(params.search)}">
              <div style="flex:1 1 220px">
                ${selectField({
                  id: 'bulk-classification',
                  name: 'classification',
                  label: `Set all ${total} trips in this view to`,
                  value: 'business',
                  choices: ['business', 'personal', 'commute', 'medical', 'charity'].map((option) => ({
                    value: option,
                    label: option,
                  })),
                })}
              </div>
              <div style="align-self:end">
                <button class="small" type="submit" data-busy="Applying…" data-confirm="Set every trip in this view? Each one will be recorded as your own decision.">Apply</button>
              </div>
            </form>
          </section>`
    }
  `;

  return layout({
    title: 'Trips',
    nav: 'trips',
    body,
    status: context.status,
    flash: context.flash,
    appearance: settings.appearance,
    colour: settings.colour,
  });
}

export function statusStrip(
  db: Database,
  settings: AppSettings,
  poller: { running: boolean; connector: string },
): StatusStrip {
  const vehicle = repo.listVehicles(db)[0];
  if (vehicle === undefined) return { label: 'No car connected', activityClass: '' };
  const latest = repo.latestSample(db, vehicle.id);
  if (latest === null) return { label: 'Waiting for the first reading', activityClass: '' };

  const shift = (latest.shiftState ?? '').toUpperCase();
  const driving = shift === 'D' || shift === 'R' || shift === 'N' || (latest.speedMph ?? 0) > 1;
  const awake = (latest.state ?? '').toLowerCase() === 'online';
  const open = repo.listTrips(db, { limit: 1 })[0];

  if (driving && open !== undefined && open.open) {
    return {
      label: `Driving · ${milesText(open.distanceMiles)} mi so far`,
      activityClass: 'driving',
    };
  }
  const place = openPlaceName(db, latest.latitude, latest.longitude);
  return {
    label: `${driving ? 'Driving' : place === null ? 'Parked' : `Parked at ${place}`} · read ${humanAgo(latest.at)}`,
    activityClass: driving ? 'driving' : awake ? 'awake' : '',
  };
}

function openPlaceName(db: Database, latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null) return null;
  const places: Place[] = repo.listPlaces(db);
  for (const place of places) {
    if (place.kind !== 'address' || place.latitude === null || place.longitude === null) continue;
    const dLat = (place.latitude - latitude) * 111_320;
    const dLon = (place.longitude - longitude) * 111_320 * Math.cos((latitude * Math.PI) / 180);
    if (Math.sqrt(dLat * dLat + dLon * dLon) <= place.radiusMeters) return place.name;
  }
  return null;
}

export type { Summary };
export function navFor(path: string): NavKey | null {
  if (path === '/') return 'today';
  if (path.startsWith('/trips')) return 'trips';
  if (path.startsWith('/places')) return 'places';
  if (path.startsWith('/rules')) return 'rules';
  if (path.startsWith('/export')) return 'export';
  if (path.startsWith('/settings') || path.startsWith('/connect')) return 'settings';
  return null;
}
