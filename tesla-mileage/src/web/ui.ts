/**
 * The look of the app: one stylesheet, one small script, a handful of component
 * helpers. Server-rendered HTML, so there is no build step and no bundle — the
 * app is as fast on a phone as it is on a laptop.
 */
import type { Classification } from '../domain/types.ts';

export function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const STYLESHEET = `
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --line: #dfe3e8;
  --ink: #14181d;
  --ink-2: #5b6672;
  --ink-3: #8a94a0;
  --accent: #1f6f43;
  --accent-soft: #e7f2ec;
  --business: #1f6f43;
  --business-bg: #e7f2ec;
  --personal: #5b6672;
  --personal-bg: #eceef1;
  --commute: #97620a;
  --commute-bg: #fdf1dd;
  --pending: #a3341f;
  --pending-bg: #fceae6;
  --radius: 12px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --surface: #171b21;
    --surface-2: #1e242c;
    --line: #2a323c;
    --ink: #e9edf2;
    --ink-2: #a2adba;
    --ink-3: #74808d;
    --accent: #57b581;
    --accent-soft: #16301f;
    --business: #57b581;
    --business-bg: #16301f;
    --personal: #a2adba;
    --personal-bg: #232a33;
    --commute: #e0a63c;
    --commute-bg: #33270f;
    --pending: #ef8b73;
    --pending-bg: #351b16;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--ink);
  padding-bottom: 76px;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: -0.005em; }
h3 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-2); }
p { margin: 0 0 10px; }
small, .small { font-size: 12.5px; color: var(--ink-2); }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 16px; }

/* Top bar */
.top {
  position: sticky; top: 0; z-index: 20;
  background: var(--surface); border-bottom: 1px solid var(--line);
}
.top .wrap { display: flex; align-items: center; gap: 12px; min-height: 56px; }
.brand { font-weight: 680; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
.brand span.mark {
  width: 24px; height: 24px; border-radius: 7px; background: var(--accent); color: #fff;
  display: grid; place-items: center; font-size: 13px; font-weight: 700;
}
.status {
  margin-left: auto; display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; color: var(--ink-2); text-align: right;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); flex: none; }
.dot.driving { background: var(--business); animation: pulse 1.8s ease-in-out infinite; }
.dot.awake { background: var(--commute); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* Desktop nav */
.tabs { display: none; gap: 4px; }
.tabs a {
  padding: 7px 12px; border-radius: 8px; color: var(--ink-2); font-size: 14px; font-weight: 550;
}
.tabs a.on { background: var(--surface-2); color: var(--ink); }
.tabs a:hover { text-decoration: none; background: var(--surface-2); }

/* Mobile bottom nav */
.bottom {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 30;
  background: var(--surface); border-top: 1px solid var(--line);
  display: flex; padding: 6px 4px 8px;
}
.bottom a {
  flex: 1; text-align: center; font-size: 10.5px; color: var(--ink-3);
  display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 4px 2px;
}
.bottom a.on { color: var(--accent); }
.bottom a:hover { text-decoration: none; }
.bottom .ico { font-size: 17px; line-height: 1; }
@media (min-width: 760px) {
  .tabs { display: flex; }
  .bottom { display: none; }
  body { padding-bottom: 32px; }
}

main { padding: 18px 0 28px; }
.head { margin-bottom: 16px; }
.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px; margin-bottom: 14px; box-shadow: var(--shadow);
}
.card.tight { padding: 12px 14px; }
.card.flat { box-shadow: none; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.spread { display: grid; gap: 14px; }
@media (min-width: 760px) { .spread.two { grid-template-columns: 1fr 1fr; } }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
@media (min-width: 620px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.stat {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 13px 14px;
}
.stat.hero { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 25%, transparent); }
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-2); }
.stat .v { font-size: 23px; font-weight: 660; margin-top: 3px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.stat .s { font-size: 12px; color: var(--ink-3); margin-top: 1px; }

/* Badges */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--surface-2); color: var(--ink-2); white-space: nowrap;
}
.badge.business { background: var(--business-bg); color: var(--business); }
.badge.personal { background: var(--personal-bg); color: var(--personal); }
.badge.commute { background: var(--commute-bg); color: var(--commute); }
.badge.medical, .badge.charity { background: var(--commute-bg); color: var(--commute); }
.badge.unclassified { background: var(--pending-bg); color: var(--pending); }
.badge.ghost { background: transparent; border: 1px solid var(--line); }

/* Buttons and forms */
button, .btn {
  font: inherit; font-weight: 570; cursor: pointer;
  padding: 9px 14px; border-radius: 9px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); min-height: 40px;
}
button:hover, .btn:hover { background: var(--surface-2); text-decoration: none; }
.btn { display: inline-flex; align-items: center; gap: 6px; }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover, .btn.primary:hover { filter: brightness(1.07); }
button.small, .btn.small { padding: 5px 10px; min-height: 32px; font-size: 13px; }
button.pick { flex: 1; min-width: 92px; }
button.pick.business { border-color: color-mix(in srgb, var(--business) 45%, var(--line)); color: var(--business); }
button.pick.personal { color: var(--personal); }
button.danger { color: var(--pending); border-color: color-mix(in srgb, var(--pending) 40%, var(--line)); }
button[disabled] { opacity: 0.5; cursor: default; }
input, select, textarea {
  font: inherit; color: var(--ink); background: var(--surface);
  border: 1px solid var(--line); border-radius: 9px; padding: 9px 10px; width: 100%; min-height: 40px;
}
input:focus, select:focus, textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
label { display: block; font-size: 12.5px; font-weight: 570; color: var(--ink-2); margin-bottom: 4px; }
.field { margin-bottom: 12px; }
.fields { display: grid; gap: 12px; }
@media (min-width: 620px) { .fields.two { grid-template-columns: 1fr 1fr; } .fields.three { grid-template-columns: repeat(3, 1fr); } }
.inline { display: flex; gap: 8px; align-items: center; }
.inline input[type=checkbox] { width: 18px; height: 18px; min-height: 0; }
.inline label { margin: 0; }
form.inlineform { display: inline; }

/* Trip list */
.trip { border-bottom: 1px solid var(--line); padding: 13px 0; }
.trip:last-child { border-bottom: none; }
.trip .when { font-size: 12.5px; color: var(--ink-2); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.trip .route { font-weight: 570; margin: 3px 0 4px; line-height: 1.35; }
.trip .route .arrow { color: var(--ink-3); padding: 0 4px; }
.trip .why { font-size: 12.5px; color: var(--ink-3); }
.trip .miles { font-variant-numeric: tabular-nums; font-weight: 620; white-space: nowrap; }
.trip .actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
.trip.review { background: linear-gradient(90deg, var(--pending-bg) 0 3px, transparent 3px); padding-left: 11px; }

/* Tables */
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 8px 8px; border-bottom: 1px solid var(--line); }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

/* Bits */
.notice {
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  background: var(--accent-soft); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 14px;
  font-size: 13.5px;
}
.notice.warn { background: var(--commute-bg); border-color: color-mix(in srgb, var(--commute) 35%, var(--line)); }
.notice.alert { background: var(--pending-bg); border-color: color-mix(in srgb, var(--pending) 35%, var(--line)); }
.meter { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: 8px; }
.meter i { display: block; height: 100%; background: var(--accent); }
.meter i.warn { background: var(--commute); }
.meter i.alert { background: var(--pending); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  font-size: 12.5px; padding: 5px 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
}
.chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.chip:hover { text-decoration: none; }
.empty { text-align: center; padding: 28px 16px; color: var(--ink-2); }
.empty .big { font-size: 30px; margin-bottom: 8px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--surface-2); padding: 1px 5px; border-radius: 5px; }
pre { background: var(--surface-2); padding: 12px; border-radius: 9px; overflow-x: auto; font-size: 12.5px; }
details { border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; margin-bottom: 10px; background: var(--surface); }
summary { cursor: pointer; font-weight: 570; }
details[open] summary { margin-bottom: 10px; }
hr { border: none; border-top: 1px solid var(--line); margin: 16px 0; }
.rule-list li { margin-bottom: 6px; }
.copy { display: flex; gap: 8px; }
.copy input { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
`;

export const SCRIPT = `
// Copy a value to the clipboard, with a fallback for browsers that refuse.
function mlCopy(id, button) {
  var el = document.getElementById(id);
  if (!el) return;
  el.select();
  var done = function () {
    var was = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function () { button.textContent = was; }, 1400);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(el.value).then(done, function () { document.execCommand('copy'); done(); });
  } else {
    document.execCommand('copy');
    done();
  }
}

// Read a chosen CSV file into the textarea, so imports need no upload handling.
function mlReadFile(input, targetId) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var target = document.getElementById(targetId);
    if (target) target.value = String(reader.result || '');
    var name = document.getElementById(targetId + '-name');
    if (name) name.textContent = file.name + ' loaded — ' + String(reader.result || '').split('\\n').length + ' lines';
  };
  reader.readAsText(file);
}

// Keep the live status strip current without a full page reload.
function mlPoll() {
  var strip = document.getElementById('ml-status');
  if (!strip) return;
  fetch('/api/status', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      strip.innerHTML = '<span class="dot ' + (data.activityClass || '') + '"></span><span>' + data.label + '</span>';
    })
    .catch(function () {});
}
setInterval(mlPoll, 60000);

// Reveal the extra category buttons on a trip.
function mlMore(id) {
  var el = document.getElementById('more-' + id);
  if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}
`;

export type NavKey = 'today' | 'trips' | 'places' | 'rules' | 'export' | 'settings';

const NAV: { key: NavKey; href: string; label: string; icon: string }[] = [
  { key: 'today', href: '/', label: 'Today', icon: '◉' },
  { key: 'trips', href: '/trips', label: 'Trips', icon: '≡' },
  { key: 'places', href: '/places', label: 'Places', icon: '⌖' },
  { key: 'rules', href: '/rules', label: 'Rules', icon: '⚙' },
  { key: 'export', href: '/export', label: 'Export', icon: '↧' },
];

export type StatusStrip = { label: string; activityClass: string };

export function layout(options: {
  title: string;
  nav: NavKey | null;
  body: string;
  status?: StatusStrip | null;
  flash?: string | null;
}): string {
  const { title, nav, body, status, flash } = options;
  const tabs = NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.key === nav ? 'on' : ''}">${escape(item.label)}</a>`,
  ).join('');
  const bottom = NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.key === nav ? 'on' : ''}"><span class="ico">${item.icon}</span>${escape(item.label)}</a>`,
  ).join('');

  const statusHtml =
    status === null || status === undefined
      ? ''
      : `<div class="status" id="ml-status"><span class="dot ${escape(status.activityClass)}"></span><span>${escape(status.label)}</span></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escape(title)} · Mile Ledger</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231f6f43'/%3E%3Ctext x='16' y='22' font-family='sans-serif' font-size='17' font-weight='bold' fill='white' text-anchor='middle'%3EM%3C/text%3E%3C/svg%3E">
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="/"><span class="mark">M</span> Mile Ledger</a>
    <nav class="tabs">${tabs}<a href="/settings" class="${nav === 'settings' ? 'on' : ''}">Settings</a></nav>
    ${statusHtml}
  </div>
</header>
<main class="wrap">
  ${flash === null || flash === undefined || flash === '' ? '' : `<div class="notice">${escape(flash)}</div>`}
  ${body}
</main>
<nav class="bottom">${bottom}<a href="/settings" class="${nav === 'settings' ? 'on' : ''}"><span class="ico">⚙</span>Settings</a></nav>
<script src="/app.js"></script>
</body>
</html>`;
}

export function stat(label: string, value: string, sub?: string, hero = false): string {
  return `<div class="stat${hero ? ' hero' : ''}">
    <div class="k">${escape(label)}</div>
    <div class="v">${escape(value)}</div>
    ${sub === undefined ? '' : `<div class="s">${escape(sub)}</div>`}
  </div>`;
}

export function badge(classification: Classification | string, text?: string): string {
  return `<span class="badge ${escape(classification)}">${escape(text ?? classification)}</span>`;
}

export function card(body: string, options: { title?: string; tight?: boolean } = {}): string {
  return `<section class="card${options.tight === true ? ' tight' : ''}">
    ${options.title === undefined ? '' : `<h2>${escape(options.title)}</h2>`}
    ${body}
  </section>`;
}

export function money(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function milesText(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function emptyState(icon: string, title: string, detail: string): string {
  return `<div class="empty"><div class="big">${icon}</div><strong>${escape(title)}</strong><div class="small" style="margin-top:6px">${detail}</div></div>`;
}
