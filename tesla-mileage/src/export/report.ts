/**
 * The printable mileage log.
 *
 * This is the document that goes to the accountant. It is a self-contained HTML
 * page styled for paper: open it, print it, and the browser makes the PDF — no
 * PDF library, no service, no cost. It states plainly where the numbers came
 * from, because a mileage log is only worth what its methodology is worth.
 */
import type { Trip } from '../domain/types.ts';
import type { RatePeriod } from '../domain/rates.ts';
import { rateCents } from '../domain/rates.ts';
import { localClock, localDate, localLongDate, nowIso } from '../lib/time.ts';
import type { Summary } from './summary.ts';
import { chartLegend, monthlyMilesChart, type ChartRow } from '../web/chart.ts';

function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type ReportOptions = {
  timezone: string;
  /** Print without colour: greys only, with categories carried by glyph. */
  monochrome?: boolean;
  rates: RatePeriod[];
  businessName: string;
  ownerName: string;
  vehicleDescription: string;
  periodLabel: string;
  includeDetail: boolean;
  includePersonal: boolean;
};

const COLOUR_TOKENS = `
    --paper: #ffffff; --ink: #111111; --ink-2: #444444; --ink-3: #666666;
    --rule: #e4e4e4; --rule-strong: #111111; --panel: #f6f6f6; --panel-line: #d5d5d5;
    --highlight: #f3f7f3; --highlight-line: #b9cdb9;
    --business-bg: #e8f2e8; --business-line: #9ec09e;
    --personal-bg: #f0f0f0; --personal-line: #cccccc;
    --commute-bg: #fdf3e3; --commute-line: #ddc79b;
    --pending-bg: #fdeaea; --pending-line: #e0a6a6;
    --chart-a: #1baf7a; --chart-b: #2a78d6; --chart-grid: #e6e6e6; --surface: #ffffff;`;

const MONO_TOKENS = `
    --paper: #ffffff; --ink: #000000; --ink-2: #333333; --ink-3: #555555;
    --rule: #d9d9d9; --rule-strong: #000000; --panel: #f2f2f2; --panel-line: #cccccc;
    --highlight: #ededed; --highlight-line: #999999;
    --business-bg: #e6e6e6; --business-line: #333333;
    --personal-bg: #f2f2f2; --personal-line: #999999;
    --commute-bg: #ebebeb; --commute-line: #666666;
    --pending-bg: #e0e0e0; --pending-line: #000000;
    --chart-a: #2b2b2b; --chart-b: #8e8e8e; --chart-grid: #dddddd; --surface: #ffffff;`;

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); background: var(--paper);
  }
  .sheet { max-width: 8.5in; margin: 0 auto; }
  header { border-bottom: 3px solid var(--rule-strong); padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-2); }
  .meta { color: var(--ink-3); font-size: 13px; }
  .meta strong { color: var(--ink); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0 4px; }
  .stat { border: 1px solid var(--panel-line); border-radius: 6px; padding: 12px 14px; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); }
  .stat .v { font-size: 21px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat.accent { background: var(--highlight); border-color: var(--highlight-line); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { background: var(--panel); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); border-bottom: 1px solid var(--panel-line); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.date, th.date { white-space: nowrap; }
  tfoot td { font-weight: 650; border-top: 2px solid var(--rule-strong); border-bottom: none; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--panel-line); white-space: nowrap; }
  .tag.business { background: var(--business-bg); border-color: var(--business-line); }
  .tag.personal { background: var(--personal-bg); border-color: var(--personal-line); border-style: dashed; }
  .tag.commute { background: var(--commute-bg); border-color: var(--commute-line); border-style: dotted; }
  .tag.unclassified { background: var(--pending-bg); border-color: var(--pending-line); }
  .note { font-size: 12px; color: var(--ink-2); background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; }
  .note ul { margin: 8px 0 0; padding-left: 18px; }
  .note li { margin-bottom: 4px; }
  .sign { margin-top: 34px; display: flex; gap: 40px; }
  .sign div { flex: 1; border-top: 1px solid var(--rule-strong); padding-top: 6px; font-size: 12px; color: var(--ink-3); }
  footer { margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--rule); font-size: 11px; color: var(--ink-3); }
  @media print {
    body { padding: 0; font-size: 11.5px; }
    h2 { margin-top: 20px; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .no-print { display: none; }
  }
  .no-print { margin-bottom: 18px; }
  .chart { width: 100%; height: auto; display: block; max-width: 640px; }
  .chart .axis { fill: var(--ink-3); font-size: 10px; }
  .chart .grid { stroke: var(--chart-grid); stroke-width: 1; }
  .chart .value { fill: var(--ink); font-size: 10.5px; font-weight: 650; }
  .chart .bar-a { fill: var(--chart-a); }
  .chart .hatch-bg { fill: var(--surface); }
  .chart .hatch-line { stroke: var(--chart-b); stroke-width: 2.6; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11.5px; color: var(--ink-2); margin-top: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 13px; height: 13px; border-radius: 3px; display: inline-block; border: 1px solid var(--panel-line); }
  .legend .key-a { background: var(--chart-a); }
  .legend .key-b { background: repeating-linear-gradient(45deg, var(--chart-b) 0 2px, var(--surface) 2px 5px); }
  .no-print button {
    font: inherit; padding: 10px 16px; border-radius: 6px; border: 1px solid var(--rule-strong);
    background: var(--rule-strong); color: var(--paper); cursor: pointer; min-height: 44px;
  }
  /* The category tag keeps a glyph, so a printed page still distinguishes the
     categories when there is no colour at all. */
  .tag::before { font-size: 9px; margin-right: 3px; }
  .tag.business::before { content: "\\25CF"; }
  .tag.personal::before { content: "\\25CB"; }
  .tag.commute::before { content: "\\25D0"; }
  .tag.unclassified::before { content: "?"; }
  .scroll { overflow-x: auto; }
`;

function statBlock(label: string, value: string, accent = false): string {
  return `<div class="stat${accent ? ' accent' : ''}"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`;
}

function money(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function miles(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function renderReport(trips: Trip[], summary: Summary, options: ReportOptions): string {
  const {
    timezone,
    rates,
    businessName,
    ownerName,
    vehicleDescription,
    periodLabel,
    includeDetail,
    includePersonal,
  } = options;

  const business = summary.byClassification.business ?? { trips: 0, miles: 0, deduction: 0 };
  const personal = summary.byClassification.personal ?? { trips: 0, miles: 0, deduction: 0 };
  const commute = summary.byClassification.commute ?? { trips: 0, miles: 0, deduction: 0 };
  const unclassified = summary.byClassification.unclassified ?? { trips: 0, miles: 0, deduction: 0 };

  const detailTrips = includePersonal
    ? trips
    : trips.filter((trip) => trip.classification !== 'personal');

  const chartRows: ChartRow[] = summary.months.map((month) => ({
    label: month.label.split(' ')[0]?.slice(0, 3) ?? month.month,
    business: month.business.miles,
    other: Math.round((month.totalMiles - month.business.miles) * 10) / 10,
  }));

  const monthRows = summary.months
    .map(
      (month) => `<tr>
        <td>${escapeHtml(month.label)}</td>
        <td class="n">${miles(month.business.miles)}</td>
        <td class="n">${miles(month.commute.miles)}</td>
        <td class="n">${miles(month.personal.miles)}</td>
        <td class="n">${miles(month.unclassified.miles)}</td>
        <td class="n">${miles(month.totalMiles)}</td>
        <td class="n">${money(month.business.deduction)}</td>
      </tr>`,
    )
    .join('');

  const clientRows = summary.clients
    .map(
      (client) => `<tr>
        <td>${escapeHtml(client.name)}</td>
        <td class="n">${client.trips}</td>
        <td class="n">${miles(client.miles)}</td>
        <td class="n">${money(client.deduction)}</td>
      </tr>`,
    )
    .join('');

  const detailRows = detailTrips
    .map((trip) => {
      const date = localDate(trip.startedAt, timezone);
      const { cents } = rateCents(date, trip.classification, rates);
      const deduction = Math.round(trip.distanceMiles * cents) / 100;
      const purpose = [trip.purpose, trip.client].filter((part) => (part ?? '') !== '').join(' — ');
      return `<tr>
        <td class="date">${escapeHtml(date)}</td>
        <td class="n">${escapeHtml(localClock(trip.startedAt, timezone))}</td>
        <td>${escapeHtml(trip.startDescription ?? '')}</td>
        <td>${escapeHtml(trip.endDescription ?? '')}</td>
        <td class="n">${miles(trip.distanceMiles)}</td>
        <td><span class="tag ${escapeHtml(trip.classification)}">${escapeHtml(trip.classification)}</span></td>
        <td>${escapeHtml(purpose)}${trip.inferred ? ' <em>(reconstructed)</em>' : ''}</td>
        <td class="n">${deduction === 0 ? '' : money(deduction)}</td>
      </tr>`;
    })
    .join('');

  const rateNotes = summary.ratesApplied
    .map(
      (rate) =>
        `<li>${escapeHtml(rate.from)} to ${escapeHtml(rate.to)}: ${rate.businessCents.toFixed(1)}&cent;/mile &mdash; ${escapeHtml(rate.note)}</li>`,
    )
    .join('');

  const title = businessName.trim() === '' ? 'Vehicle Mileage Log' : `${businessName} — Vehicle Mileage Log`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>:root {${options.monochrome === true ? MONO_TOKENS : COLOUR_TOKENS}}${STYLES}</style>
<script src="/app.js" defer></script>
</head>
<body>
<div class="sheet">
  <div class="no-print"><button type="button" data-print>Print or save as PDF</button></div>

  <header>
    <h1>Vehicle Mileage Log</h1>
    <div class="meta">
      ${businessName.trim() === '' ? '' : `<strong>${escapeHtml(businessName)}</strong><br>`}
      ${ownerName.trim() === '' ? '' : `Prepared for ${escapeHtml(ownerName)}<br>`}
      Period: <strong>${escapeHtml(periodLabel)}</strong><br>
      ${vehicleDescription.trim() === '' ? '' : `Vehicle: ${escapeHtml(vehicleDescription)}<br>`}
      Generated ${escapeHtml(localLongDate(nowIso(), timezone))} at ${escapeHtml(localClock(nowIso(), timezone))} (${escapeHtml(timezone)})
    </div>
  </header>

  <div class="grid">
    ${statBlock('Business miles', miles(business.miles), true)}
    ${statBlock('Estimated deduction', money(summary.deduction), true)}
    ${statBlock('Total miles driven', miles(summary.totalMiles))}
    ${statBlock('Business share', `${summary.businessPercent}%`)}
    ${statBlock('Business trips', String(business.trips))}
  </div>

  ${
    chartRows.length < 2
      ? ''
      : `<h2>Miles by month</h2>
  ${monthlyMilesChart(chartRows, { idPrefix: 'report' })}
  ${chartLegend({ businessLabel: 'Business miles', otherLabel: 'Personal, commute and undecided' })}`
  }

  <h2>Monthly totals</h2>
  <div class="scroll"><table>
    <thead>
      <tr>
        <th scope="col">Month</th><th scope="col" class="n">Business</th><th scope="col" class="n">Commute</th><th scope="col" class="n">Personal</th>
        <th scope="col" class="n">Unclassified</th><th scope="col" class="n">Total</th><th scope="col" class="n">Business deduction</th>
      </tr>
    </thead>
    <tbody>${monthRows === '' ? '<tr><td colspan="7">No trips in this period.</td></tr>' : monthRows}</tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td class="n">${miles(business.miles)}</td>
        <td class="n">${miles(commute.miles)}</td>
        <td class="n">${miles(personal.miles)}</td>
        <td class="n">${miles(unclassified.miles)}</td>
        <td class="n">${miles(summary.totalMiles)}</td>
        <td class="n">${money(summary.deduction)}</td>
      </tr>
    </tfoot>
  </table></div>

  ${
    clientRows === ''
      ? ''
      : `<h2>Business miles by client or project</h2>
  <div class="scroll"><table>
    <thead><tr><th scope="col">Client / project</th><th scope="col" class="n">Trips</th><th scope="col" class="n">Miles</th><th scope="col" class="n">Deduction</th></tr></thead>
    <tbody>${clientRows}</tbody>
  </table></div>`
  }

  ${
    includeDetail
      ? `<h2>Trip detail${includePersonal ? '' : ' (business, commute and unclassified trips)'}</h2>
  <div class="scroll"><table>
    <thead>
      <tr><th scope="col" class="date">Date</th><th scope="col" class="n">Time</th><th scope="col">From</th><th scope="col">To</th><th scope="col" class="n">Miles</th><th scope="col">Category</th><th scope="col">Purpose</th><th scope="col" class="n">Deduction</th></tr>
    </thead>
    <tbody>${detailRows === '' ? '<tr><td colspan="8">No trips in this period.</td></tr>' : detailRows}</tbody>
  </table></div>`
      : ''
  }

  <h2>How these numbers were produced</h2>
  <div class="note">
    <ul>
      <li>Distances come from the vehicle's own odometer, read directly from the car. They are not estimated from a phone or a map route.</li>
      <li>Each trip records the date, the miles, the start and end location, and the business purpose.</li>
      <li>Categories are set from labeled locations and rules, and can be overridden by hand. Every trip in the app carries a note saying which one decided it.</li>
      ${
        summary.inferredTrips > 0
          ? `<li><strong>${summary.inferredTrips} trip${summary.inferredTrips === 1 ? '' : 's'} marked "reconstructed"</strong>: the vehicle was asleep or unreachable for part of the drive, so the mileage is taken from the change in the odometer while the route in between is not recorded. The mileage is the car's own; the intermediate stops are not known.</li>`
          : ''
      }
      ${
        unclassified.trips > 0
          ? `<li><strong>${unclassified.trips} trip${unclassified.trips === 1 ? '' : 's'} (${miles(unclassified.miles)} miles) are not yet categorized</strong> and are excluded from the deduction figure above.</li>`
          : ''
      }
      <li>Commuting between home and a regular place of work is tracked separately and is <strong>not</strong> included in the deduction, per IRS treatment of commuting expenses.</li>
      ${rateNotes === '' ? '' : `<li>Standard mileage rates applied:<ul>${rateNotes}</ul></li>`}
      <li>Figures are an estimate prepared by the taxpayer for their accountant's review. They are not tax advice.</li>
    </ul>
  </div>

  <div class="sign">
    <div>Taxpayer signature and date</div>
    <div>Prepared by</div>
  </div>

  <footer>
    ${escapeHtml(summary.totalTrips)} trips covering
    ${summary.firstTripAt === null ? 'no dates' : escapeHtml(localDate(summary.firstTripAt, timezone))}
    through
    ${summary.lastTripAt === null ? 'no dates' : escapeHtml(localDate(summary.lastTripAt, timezone))}.
    Times shown in ${escapeHtml(timezone)}.
  </footer>
</div>
</body>
</html>
`;
}
