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
  rates: RatePeriod[];
  businessName: string;
  ownerName: string;
  vehicleDescription: string;
  periodLabel: string;
  includeDetail: boolean;
  includePersonal: boolean;
};

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111; background: #fff;
  }
  .sheet { max-width: 8.5in; margin: 0 auto; }
  header { border-bottom: 3px solid #111; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #444; }
  .meta { color: #555; font-size: 13px; }
  .meta strong { color: #111; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0 4px; }
  .stat { border: 1px solid #d5d5d5; border-radius: 6px; padding: 12px 14px; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; }
  .stat .v { font-size: 21px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat.accent { background: #f3f7f3; border-color: #b9cdb9; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e4e4e4; vertical-align: top; }
  th { background: #f6f6f6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #444; border-bottom: 1px solid #bbb; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.date, th.date { white-space: nowrap; }
  tfoot td { font-weight: 650; border-top: 2px solid #111; border-bottom: none; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid #ccc; white-space: nowrap; }
  .tag.business { background: #e8f2e8; border-color: #9ec09e; }
  .tag.personal { background: #f0f0f0; }
  .tag.commute { background: #fdf3e3; border-color: #ddc79b; }
  .tag.unclassified { background: #fdeaea; border-color: #e0a6a6; }
  .note { font-size: 12px; color: #444; background: #fafafa; border: 1px solid #e0e0e0; border-radius: 6px; padding: 12px 14px; }
  .note ul { margin: 8px 0 0; padding-left: 18px; }
  .note li { margin-bottom: 4px; }
  .sign { margin-top: 34px; display: flex; gap: 40px; }
  .sign div { flex: 1; border-top: 1px solid #111; padding-top: 6px; font-size: 12px; color: #555; }
  footer { margin-top: 26px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #777; }
  @media print {
    body { padding: 0; font-size: 11.5px; }
    h2 { margin-top: 20px; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .no-print { display: none; }
  }
  .no-print { margin-bottom: 18px; }
  .no-print button {
    font: inherit; padding: 9px 16px; border-radius: 6px; border: 1px solid #111;
    background: #111; color: #fff; cursor: pointer;
  }
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
<style>${STYLES}</style>
</head>
<body>
<div class="sheet">
  <div class="no-print"><button onclick="window.print()">Print or save as PDF</button></div>

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

  <h2>Monthly totals</h2>
  <table>
    <thead>
      <tr>
        <th>Month</th><th class="n">Business</th><th class="n">Commute</th><th class="n">Personal</th>
        <th class="n">Unclassified</th><th class="n">Total</th><th class="n">Business deduction</th>
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
  </table>

  ${
    clientRows === ''
      ? ''
      : `<h2>Business miles by client or project</h2>
  <table>
    <thead><tr><th>Client / project</th><th class="n">Trips</th><th class="n">Miles</th><th class="n">Deduction</th></tr></thead>
    <tbody>${clientRows}</tbody>
  </table>`
  }

  ${
    includeDetail
      ? `<h2>Trip detail${includePersonal ? '' : ' (business, commute and unclassified trips)'}</h2>
  <table>
    <thead>
      <tr><th class="date">Date</th><th class="n">Time</th><th>From</th><th>To</th><th class="n">Miles</th><th>Category</th><th>Purpose</th><th class="n">Deduction</th></tr>
    </thead>
    <tbody>${detailRows === '' ? '<tr><td colspan="8">No trips in this period.</td></tr>' : detailRows}</tbody>
  </table>`
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
