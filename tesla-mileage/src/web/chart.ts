/**
 * The monthly miles chart.
 *
 * Two series per month — business against everything else — because the question
 * the chart answers is "how is the deductible half of my driving trending". It is
 * a plain inline SVG rendered on the server: no chart library, no client
 * JavaScript, and it scales with the page.
 *
 * Colour is the last thing carrying meaning here, deliberately. The series are
 * separated by lightness, by a hatch texture on the second series, by a legend,
 * and by direct value labels on the series that matters. That is what keeps the
 * chart readable in black-and-white mode, on a monochrome printer, and for a
 * reader with colour vision deficiency. The hues themselves come from a palette
 * checked with the validator rather than chosen by eye.
 */

export type ChartRow = { label: string; business: number; other: number };

export type ChartOptions = {
  /** Coordinate space; the rendered element scales to its container. */
  width: number;
  height: number;
  /** Keep the most recent N months. */
  maxBars: number;
  /** Unique per page, so two charts do not share pattern ids. */
  idPrefix: string;
};

const DEFAULTS: ChartOptions = { width: 640, height: 220, maxBars: 8, idPrefix: 'chart' };

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Round a maximum up to something a person would choose for an axis. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = magnitude * step;
    if (candidate >= value) return candidate;
  }
  return magnitude * 10;
}

/** A bar with its top corners rounded and its base flat on the axis. */
export function barPath(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0.5) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const right = x + width;
  const bottom = y + height;
  return [
    `M${x.toFixed(1)},${bottom.toFixed(1)}`,
    `V${(y + r).toFixed(1)}`,
    `A${r},${r} 0 0 1 ${(x + r).toFixed(1)},${y.toFixed(1)}`,
    `H${(right - r).toFixed(1)}`,
    `A${r},${r} 0 0 1 ${right.toFixed(1)},${(y + r).toFixed(1)}`,
    `V${bottom.toFixed(1)}`,
    'Z',
  ].join(' ');
}

function formatMiles(value: number): string {
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  if (value >= 100) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

/**
 * Render the chart. Returns an empty string for no data, so the caller can show
 * something else rather than an empty frame.
 */
export function monthlyMilesChart(rows: ChartRow[], overrides: Partial<ChartOptions> = {}): string {
  const options = { ...DEFAULTS, ...overrides };
  const data = rows.slice(-options.maxBars);
  if (data.length === 0) return '';

  const { width, height, idPrefix } = options;
  const padding = { top: 20, right: 6, bottom: 24, left: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const peak = Math.max(...data.flatMap((row) => [row.business, row.other]), 1);
  const ceiling = niceCeiling(peak);
  const yOf = (value: number): number => padding.top + plotHeight - (value / ceiling) * plotHeight;

  const groupWidth = plotWidth / data.length;
  // A 2px gap between the two bars, and breathing room around each group.
  const groupPadding = Math.min(14, groupWidth * 0.22);
  const barWidth = Math.max(3, (groupWidth - groupPadding * 2 - 2) / 2);

  const gridValues = [0, ceiling / 2, ceiling];
  const grid = gridValues
    .map((value) => {
      const y = yOf(value);
      return `<line class="grid" x1="${padding.left}" y1="${y.toFixed(1)}" x2="${(width - padding.right).toFixed(1)}" y2="${y.toFixed(1)}"></line>
        <text class="axis" x="${padding.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${formatMiles(value)}</text>`;
    })
    .join('');

  const bars = data
    .map((row, index) => {
      const groupX = padding.left + index * groupWidth + groupPadding;
      const businessX = groupX;
      const otherX = groupX + barWidth + 2;
      const baseline = yOf(0);
      const businessHeight = baseline - yOf(row.business);
      const otherHeight = baseline - yOf(row.other);
      const labelY = Math.max(padding.top - 6, yOf(row.business) - 5);

      return `<g>
        <path class="bar-a" d="${barPath(businessX, yOf(row.business), barWidth, businessHeight)}">
        </path>
        <path class="bar-b" fill="url(#${escapeText(idPrefix)}-hatch)" d="${barPath(otherX, yOf(row.other), barWidth, otherHeight)}"></path>
        <rect x="${businessX.toFixed(1)}" y="${padding.top}" width="${(barWidth * 2 + 2).toFixed(1)}" height="${plotHeight.toFixed(1)}" fill="transparent">
          <title>${escapeText(row.label)}: ${formatMiles(row.business)} business miles, ${formatMiles(row.other)} other miles</title>
        </rect>
        ${
          row.business > 0
            ? `<text class="value" x="${(businessX + barWidth / 2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${formatMiles(row.business)}</text>`
            : ''
        }
        <text class="axis" x="${(groupX + barWidth + 1).toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle">${escapeText(row.label)}</text>
      </g>`;
    })
    .join('');

  const summary = data
    .map((row) => `${row.label}: ${formatMiles(row.business)} business, ${formatMiles(row.other)} other`)
    .join('; ');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img"
    aria-label="Miles by month. ${escapeText(summary)}. The same figures are in the table below.">
    <defs>
      <!-- Texture, not just colour: the second series stays distinguishable with
           no colour at all, on a monochrome printer, and for a reader with colour
           vision deficiency. -->
      <pattern id="${escapeText(idPrefix)}-hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" class="hatch-bg"></rect>
        <line x1="0" y1="0" x2="0" y2="5" class="hatch-line"></line>
      </pattern>
    </defs>
    ${grid}
    ${bars}
  </svg>`;
}

/** The legend that always accompanies the chart. */
export function chartLegend(options: { businessLabel: string; otherLabel: string }): string {
  return `<div class="legend">
    <span><i class="key-a" aria-hidden="true"></i>${escapeText(options.businessLabel)}</span>
    <span><i class="key-b" aria-hidden="true"></i>${escapeText(options.otherLabel)}</span>
  </div>`;
}
