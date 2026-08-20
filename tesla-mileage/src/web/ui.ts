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

/**
 * Four palettes, one stylesheet.
 *
 * The black-and-white palettes are strictly neutral — every grey has equal red,
 * green and blue — so "no colour" is a fact about the page rather than an
 * impression of it.
 *
 * Appearance (auto / light / dark) and colour (full colour / black and white) are
 * independent, giving four combinations. Every colour in the app is a token, so
 * switching is a matter of redefining tokens rather than overriding rules — and
 * grayscale is a real palette, not a `filter` slapped over the page, so text
 * contrast stays under control. Every pair below meets WCAG AA.
 *
 * Because colour carries no meaning in black and white, category and status also
 * carry a glyph, a border style, and a text label. Those are present in colour
 * mode too: redundancy helps colour-blind readers either way.
 */
const LIGHT_COLOUR = `
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #f0f2f5; --line: #dfe3e8;
  --ink: #14181d; --ink-2: #4c5661; --ink-3: #616a75;
  --accent: #1a6b40; --accent-ink: #ffffff; --accent-soft: #e7f2ec; --accent-line: #b9cdc2;
  --business: #17603a; --business-bg: #e4f0e9;
  --personal: #4c5661; --personal-bg: #eceef1;
  --commute: #7a4e06; --commute-bg: #fbeed6;
  --pending: #96301c; --pending-bg: #fbe3de;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.06);
  --chart-a: #1baf7a; --chart-b: #2a78d6; --chart-grid: #e2e6ea;
`;

const DARK_COLOUR = `
  --bg: #0f1216; --surface: #171b21; --surface-2: #1e242c; --line: #2a323c;
  --ink: #e9edf2; --ink-2: #aab4c0; --ink-3: #939daa;
  --accent: #57b581; --accent-ink: #0c1a12; --accent-soft: #16301f; --accent-line: #2f5f45;
  --business: #68c592; --business-bg: #14301e;
  --personal: #aab4c0; --personal-bg: #232a33;
  --commute: #e0a63c; --commute-bg: #33270f;
  --pending: #f09a83; --pending-bg: #351b16;
  --shadow: none;
  --chart-a: #199e70; --chart-b: #3987e5; --chart-grid: #2a323c;
`;

const LIGHT_MONO = `
  --bg: #f4f4f4; --surface: #ffffff; --surface-2: #ebebeb; --line: #d6d6d6;
  --ink: #101010; --ink-2: #484848; --ink-3: #5f5f5f;
  --accent: #1c1c1c; --accent-ink: #ffffff; --accent-soft: #eaeaea; --accent-line: #b8b8b8;
  --business: #141414; --business-bg: #e4e4e4;
  --personal: #484848; --personal-bg: #ededed;
  --commute: #2c2c2c; --commute-bg: #e8e8e8;
  --pending: #000000; --pending-bg: #dcdcdc;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.07);
  --chart-a: #2b2b2b; --chart-b: #8e8e8e; --chart-grid: #dcdcdc;
`;

const DARK_MONO = `
  --bg: #0e0e0e; --surface: #171717; --surface-2: #202020; --line: #303030;
  --ink: #ededed; --ink-2: #b2b2b2; --ink-3: #959595;
  --accent: #e6e6e6; --accent-ink: #121212; --accent-soft: #242424; --accent-line: #4a4a4a;
  --business: #f0f0f0; --business-bg: #262626;
  --personal: #b2b2b2; --personal-bg: #202020;
  --commute: #dcdcdc; --commute-bg: #232323;
  --pending: #ffffff; --pending-bg: #2b2b2b;
  --shadow: none;
  --chart-a: #ededed; --chart-b: #777777; --chart-grid: #303030;
`;

export const STYLESHEET = `
/* Full colour, light. The starting point every other mode overrides. */
:root { color-scheme: light; ${LIGHT_COLOUR} }

/* Following the device, when the device says dark. */
@media (prefers-color-scheme: dark) {
  :root:not([data-appearance="light"]) { color-scheme: dark; ${DARK_COLOUR} }
}
/* Explicitly chosen, which must win over the device in both directions. */
:root[data-appearance="dark"] { color-scheme: dark; ${DARK_COLOUR} }
:root[data-appearance="light"] { color-scheme: light; ${LIGHT_COLOUR} }

/* Black and white. Declared after the themes so it takes precedence. */
:root[data-colour="mono"] { color-scheme: light; ${LIGHT_MONO} }
@media (prefers-color-scheme: dark) {
  :root[data-colour="mono"]:not([data-appearance="light"]) { color-scheme: dark; ${DARK_MONO} }
}
:root[data-colour="mono"][data-appearance="dark"] { color-scheme: dark; ${DARK_MONO} }
:root[data-colour="mono"][data-appearance="light"] { color-scheme: light; ${LIGHT_MONO} }

/* Anything that carries its own colour — photos, embedded media — is drained
   too, so nothing sneaks a hue back into a black and white page. */
:root[data-colour="mono"] img,
:root[data-colour="mono"] video,
:root[data-colour="mono"] iframe { filter: grayscale(1); }

:root {
  --radius: 12px;
  --tap: 44px;                       /* the smallest comfortable touch target */
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --bar-height: 58px;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--ink);
  /* Room for the fixed bottom bar plus the home indicator on modern phones. */
  padding-bottom: calc(var(--bar-height) + var(--safe-bottom) + 18px);
  overflow-wrap: break-word;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: -0.005em; }
h3 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-2); }
p { margin: 0 0 10px; }
small, .small { font-size: 12.5px; color: var(--ink-2); }
.muted { color: var(--ink-3); }
.wrap {
  max-width: 1040px; margin: 0 auto;
  padding: 0 max(16px, var(--safe-left)) 0 max(16px, var(--safe-right));
}

/* Keyboard users get a way past the navigation. */
.skip {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--surface); color: var(--ink); padding: 10px 14px;
  border: 2px solid var(--accent); border-radius: 0 0 8px 0;
}
.skip:focus { left: 0; }

:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
  border-radius: 6px;
}

/* Top bar */
.top {
  position: sticky; top: 0; z-index: 20;
  background: var(--surface); border-bottom: 1px solid var(--line);
  padding-top: var(--safe-top);
}
.top .wrap { display: flex; align-items: center; gap: 12px; min-height: 56px; }
.brand { font-weight: 680; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; flex: none; }
.brand:hover { text-decoration: none; }
.brand .mark {
  width: 26px; height: 26px; border-radius: 7px; background: var(--accent); color: var(--accent-ink);
  display: grid; place-items: center; font-size: 13px; font-weight: 700; flex: none;
}
.status {
  margin-left: auto; display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; color: var(--ink-2); text-align: right; min-width: 0;
}
.status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Status is never colour alone: the shape of the dot changes, and the words
   next to it say the same thing. */
.dot {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  border: 2px solid var(--ink-3); background: transparent;
}
.dot.driving { background: var(--business); border-color: var(--business); animation: pulse 1.8s ease-in-out infinite; }
.dot.awake { border-color: var(--commute); border-style: dashed; background: transparent; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .dot.driving { animation: none; } }

/* Desktop nav */
.tabs { display: none; gap: 4px; }
.tabs a {
  padding: 8px 12px; border-radius: 8px; color: var(--ink-2); font-size: 14px; font-weight: 550;
}
.tabs a[aria-current="page"] { background: var(--surface-2); color: var(--ink); font-weight: 650; }
.tabs a:hover { text-decoration: none; background: var(--surface-2); }

/* Bottom bar, phones. Dashboard sits in the middle and is deliberately the
   most prominent thing on it. */
.bottom {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 30;
  background: var(--surface); border-top: 1px solid var(--line);
  display: grid; grid-template-columns: repeat(5, 1fr);
  align-items: end;
  padding: 6px max(4px, var(--safe-left)) calc(6px + var(--safe-bottom)) max(4px, var(--safe-right));
}
.bottom a {
  min-height: var(--tap);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  font-size: 10.5px; color: var(--ink-3); text-align: center; padding: 4px 2px;
  border-radius: 10px;
}
.bottom a:hover { text-decoration: none; }
.bottom a[aria-current="page"] { color: var(--accent); background: var(--accent-soft); font-weight: 650; }
.bottom .ico { font-size: 18px; line-height: 1; }
.bottom .home {
  color: var(--accent-ink); background: var(--accent);
  margin: -16px 6px 0; border-radius: 16px; min-height: 56px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  border: 2px solid var(--surface);
  font-weight: 700; font-size: 11px;
}
.bottom .home[aria-current="page"] { color: var(--accent-ink); background: var(--accent); }
.bottom .home .ico { font-size: 20px; }

/* An open keyboard would otherwise cover the field being typed into. */
body.keyboard .bottom { display: none; }
body.keyboard { padding-bottom: 24px; }

@media (min-width: 760px) {
  .tabs { display: flex; }
  .bottom { display: none; }
  body { padding-bottom: 32px; }
}
/* Landscape on a phone: very little height, so give it back to the content. */
@media (max-height: 460px) and (max-width: 900px) {
  .bottom { padding-top: 2px; }
  .bottom a { min-height: 38px; font-size: 10px; }
  .bottom .home { min-height: 42px; margin-top: -8px; }
  .top .wrap { min-height: 44px; }
}

main { padding: 18px 0 28px; }
.head { margin-bottom: 16px; }
.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px; margin-bottom: 14px; box-shadow: var(--shadow);
}
.card.tight { padding: 12px 14px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.spread { display: grid; gap: 14px; }
@media (min-width: 760px) { .spread.two { grid-template-columns: 1fr 1fr; } }
/* A grid or flex child will not shrink below its content unless told it may.
   Without this a wide table inside a card drags the whole page sideways, and no
   amount of overflow handling on the table itself helps. */
.spread > *, .stats > *, .tiles > *, .fields > * { min-width: 0; }
.card, .stat, .tile { min-width: 0; }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
@media (min-width: 620px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.stat {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 13px 14px;
  min-width: 0;
}
.stat.hero { background: var(--accent-soft); border-color: var(--accent-line); }
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-2); }
.stat .v { font-size: 23px; font-weight: 660; margin-top: 3px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.stat .s { font-size: 12px; color: var(--ink-3); margin-top: 1px; }

/* Badges: colour, plus a glyph, plus a border style, plus the word itself. */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--surface-2); color: var(--ink-2); white-space: nowrap;
  border: 1px solid transparent;
}
.badge::before { font-weight: 700; font-size: 10px; line-height: 1; }
.badge.business { background: var(--business-bg); color: var(--business); border-color: var(--business); border-style: solid; }
.badge.business::before { content: "\\25CF"; }
.badge.personal { background: var(--personal-bg); color: var(--personal); border-color: var(--personal); border-style: dashed; }
.badge.personal::before { content: "\\25CB"; }
.badge.commute { background: var(--commute-bg); color: var(--commute); border-color: var(--commute); border-style: dotted; }
.badge.commute::before { content: "\\25D0"; }
.badge.medical, .badge.charity { background: var(--commute-bg); color: var(--commute); border-color: var(--commute); border-style: dotted; }
.badge.medical::before { content: "\\002B"; }
.badge.charity::before { content: "\\2661"; }
.badge.unclassified { background: var(--pending-bg); color: var(--pending); border-color: var(--pending); border-style: double; border-width: 3px; padding: 0 7px; }
.badge.unclassified::before { content: "?"; }
.badge.ghost { background: transparent; border: 1px solid var(--line); color: var(--ink-2); }

/* Buttons and forms */
button, .btn {
  font: inherit; font-weight: 570; cursor: pointer;
  padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); min-height: var(--tap);
}
button:hover, .btn:hover { background: var(--surface-2); text-decoration: none; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.primary:hover, .btn.primary:hover { filter: brightness(1.12); }
button.small, .btn.small { padding: 7px 12px; min-height: 38px; font-size: 13px; }
button.pick { flex: 1 1 auto; min-width: 96px; }
button.pick.business { border-color: var(--business); color: var(--business); font-weight: 650; }
button.pick.personal { border-color: var(--personal); color: var(--personal); border-style: dashed; }
button.pick.commute { border-color: var(--commute); color: var(--commute); border-style: dotted; }
button.danger { color: var(--pending); border-color: var(--pending); }
button[disabled] { opacity: 0.55; cursor: default; }
input, select, textarea {
  /* 16px keeps iOS from zooming the whole page when a field is focused. */
  font-family: inherit; font-size: 16px; line-height: 1.4;
  color: var(--ink); background: var(--surface);
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; width: 100%;
  min-height: var(--tap);
}
textarea {
  min-height: 96px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 16px;
}
/* Tighter fields only where there is a mouse. Keyed on the pointer rather than
   the width, because a tablet in landscape is a wide screen that is still
   touched — and it would zoom on focus just like a phone. */
@media (pointer: fine) and (min-width: 760px) {
  input, select, textarea { font-size: 14.5px; min-height: 40px; }
  textarea { font-size: 13px; }
}
label { display: block; font-size: 12.5px; font-weight: 570; color: var(--ink-2); margin-bottom: 5px; }
.field { margin-bottom: 12px; }
.fields { display: grid; gap: 12px; }
@media (min-width: 620px) { .fields.two { grid-template-columns: 1fr 1fr; } .fields.three { grid-template-columns: repeat(3, 1fr); } }
.inline { display: flex; gap: 10px; align-items: center; min-height: var(--tap); }
.inline input[type=checkbox], .inline input[type=radio] { width: 24px; height: 24px; min-height: 0; flex: none; }
/* The label fills the row, so anywhere in it toggles the box. */
.inline label { margin: 0; font-size: 14.5px; color: var(--ink); flex: 1; padding: 10px 0; cursor: pointer; }
form.inlineform { display: inline; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 12px; }
legend { font-size: 12.5px; font-weight: 570; color: var(--ink-2); padding: 0 6px; }

/* Trip list */
.trip { border-bottom: 1px solid var(--line); padding: 14px 0; }
.trip:last-child { border-bottom: none; }
/* Date and distance share one line and stay there; the tags get their own. */
.trip-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
.trip-head .when { font-size: 12.5px; color: var(--ink-2); min-width: 0; }
.trip-head .miles { flex: none; }
.trip .tags { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 5px; }
.trip .when { font-size: 12.5px; color: var(--ink-2); }
.trip .route { font-weight: 570; margin: 4px 0 4px; line-height: 1.35; }
.trip .route .arrow { color: var(--ink-3); padding: 0 4px; }
.trip .why { font-size: 12.5px; color: var(--ink-3); }
.trip .miles { font-variant-numeric: tabular-nums; font-weight: 620; white-space: nowrap; }
.trip .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.trip .actions[hidden] { display: none; }
/* Needs-a-decision rows are marked by a bar and a dotted edge, so the cue does
   not vanish in black and white. */
.trip.review { border-left: 4px solid var(--pending); padding-left: 12px; margin-left: -16px; }
.trip.review .when { font-weight: 600; }

/* Tables always get a scroll container of their own rather than pushing the
   page sideways. */
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.scroll table { min-width: 380px; }

/* Bits */
.notice {
  border: 1px solid var(--accent-line);
  background: var(--accent-soft); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 14px;
  font-size: 13.5px;
}
.notice.warn { background: var(--commute-bg); border-color: var(--commute); }
.notice.alert { background: var(--pending-bg); border-color: var(--pending); }
.notice strong { color: inherit; }
.meter { height: 8px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: 8px; border: 1px solid var(--line); }
.meter i { display: block; height: 100%; background: var(--accent); }
/* Stripes, not just a colour change, so a full meter reads as urgent in mono. */
.meter i.warn {
  background: repeating-linear-gradient(45deg, var(--commute) 0 4px, transparent 4px 8px), var(--commute-bg);
}
.meter i.alert {
  background: repeating-linear-gradient(45deg, var(--pending) 0 3px, transparent 3px 6px), var(--pending-bg);
}
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip {
  font-size: 13px; padding: 8px 14px; border-radius: 999px; min-height: 40px;
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
  cursor: pointer;
}
/* Touch screens get the full comfortable target. */
@media (pointer: coarse) { .chip { min-height: var(--tap); } button.small, .btn.small { min-height: 40px; } }
.chip[aria-current="true"], .chip.on {
  background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 620;
}
.chip:hover { text-decoration: none; }
/* A chip that wraps a radio button: the whole chip is the target. */
.chip input { width: 16px; height: 16px; min-height: 0; margin: 0; flex: none; }
.chip:has(input:checked) {
  background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 620;
}
.chip:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
.swatches { display: flex; gap: 6px; margin-top: 10px; }
.swatch { flex: 1; height: 28px; border-radius: 6px; border: 1px solid var(--line); }
.swatch.ink { background: var(--ink); }
.swatch.accent { background: var(--accent); }
.swatch.business { background: var(--business-bg); border-color: var(--business); }
.swatch.commute { background: var(--commute-bg); border-color: var(--commute); }
.swatch.pending { background: var(--pending-bg); border-color: var(--pending); }
.tiles { display: grid; gap: 10px; grid-template-columns: 1fr; }
@media (min-width: 560px) { .tiles { grid-template-columns: 1fr 1fr; } }
.tile {
  display: flex; gap: 12px; align-items: flex-start;
  border: 1px solid var(--line); border-radius: var(--radius); padding: 14px;
  background: var(--surface); color: inherit; min-height: var(--tap);
}
.tile:hover { text-decoration: none; background: var(--surface-2); }
.tile .ico { font-size: 20px; line-height: 1.2; flex: none; }
.tile strong { display: block; }
.tile .small { display: block; margin-top: 2px; }
.empty { text-align: center; padding: 28px 16px; color: var(--ink-2); }
.empty .big { font-size: 30px; margin-bottom: 8px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--surface-2); padding: 1px 5px; border-radius: 5px; overflow-wrap: anywhere; }
pre { background: var(--surface-2); padding: 12px; border-radius: 9px; overflow-x: auto; font-size: 12.5px; }
details { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: var(--surface); }
summary { cursor: pointer; font-weight: 570; min-height: 30px; display: flex; align-items: center; }
details[open] summary { margin-bottom: 10px; }
hr { border: none; border-top: 1px solid var(--line); margin: 16px 0; }
.rule-list li { margin-bottom: 6px; }
.copy { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
.copy input { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; flex: 1 1 220px; }

/* Chart. Texture, lightness, labels and the legend carry the meaning; colour
   only reinforces it, which is what keeps the chart readable with no colour at
   all and for a reader with colour vision deficiency. */
.chart { width: 100%; height: auto; display: block; }
.chart .axis { fill: var(--ink-3); font-size: 10px; }
.chart .grid { stroke: var(--chart-grid); stroke-width: 1; }
.chart .value { fill: var(--ink); font-size: 10.5px; font-weight: 650; }
.chart .bar-a { fill: var(--chart-a); }
.chart .hatch-bg { fill: var(--surface); }
.chart .hatch-line { stroke: var(--chart-b); stroke-width: 2.6; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-2); margin-top: 8px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 15px; height: 15px; border-radius: 3px; display: inline-block; border: 1px solid var(--line); }
.legend .key-a { background: var(--chart-a); }
.legend .key-b {
  background: repeating-linear-gradient(45deg, var(--chart-b) 0 2px, var(--surface) 2px 5px);
}

@media print {
  .top, .bottom, .no-print, .skip { display: none !important; }
  body { padding: 0; background: #fff; color: #000; }
  .card { border-color: #ccc; box-shadow: none; }
}
`;

export const SCRIPT = `
// No inline handlers anywhere: everything is wired by delegation from here, so
// the pages can be served under a strict Content-Security-Policy.
(function () {
  'use strict';

  function copyFrom(id, button) {
    var el = document.getElementById(id);
    if (!el) return;
    var done = function () {
      var was = button.getAttribute('data-label') || button.textContent;
      button.setAttribute('data-label', was);
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = was; }, 1400);
    };
    el.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(el.value).then(done, function () {
        try { document.execCommand('copy'); } catch (e) {}
        done();
      });
    } else {
      try { document.execCommand('copy'); } catch (e) {}
      done();
    }
  }

  // Read a chosen CSV into the textarea, so importing needs no upload handling.
  function readFileInto(input, targetId) {
    var file = input.files && input.files[0];
    if (!file) return;
    var target = document.getElementById(targetId);
    var note = document.getElementById(targetId + '-name');
    var reader = new FileReader();
    reader.onerror = function () {
      if (note) note.textContent = 'That file could not be read. Try pasting the rows instead.';
    };
    reader.onload = function () {
      var text = String(reader.result || '');
      if (target) target.value = text;
      if (note) note.textContent = file.name + ' loaded — ' + text.split('\\n').length + ' lines';
    };
    reader.readAsText(file);
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var copy = target.closest('[data-copy]');
    if (copy) { copyFrom(copy.getAttribute('data-copy'), copy); return; }

    var more = target.closest('[data-more]');
    if (more) {
      var panel = document.getElementById('more-' + more.getAttribute('data-more'));
      if (panel) {
        var open = panel.hasAttribute('hidden');
        if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
        more.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      return;
    }

    var print = target.closest('[data-print]');
    if (print) { window.print(); return; }
  });

  document.addEventListener('change', function (event) {
    var input = event.target;
    if (!input || !input.getAttribute) return;

    if (input.getAttribute('data-file-into')) {
      readFileInto(input, input.getAttribute('data-file-into'));
      return;
    }

    // Appearance changes apply straight away; the form still has a Save button
    // for anyone without JavaScript.
    var form = input.form;
    if (form && form.hasAttribute('data-autosubmit')) {
      form.removeAttribute('data-sent');
      form.submit();
    }
  });

  // One confirmation path, and one guard against double submission: a form that
  // has been sent is locked until the next page arrives.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.tagName !== 'FORM') return;
    var submitter = event.submitter;

    var question = submitter && submitter.getAttribute ? submitter.getAttribute('data-confirm') : null;
    if (question && !window.confirm(question)) {
      event.preventDefault();
      return;
    }

    if (form.hasAttribute('data-sent')) {
      event.preventDefault();
      return;
    }
    form.setAttribute('data-sent', '');
    if (submitter && submitter.tagName === 'BUTTON') {
      var busy = submitter.getAttribute('data-busy') || 'Working…';
      submitter.setAttribute('data-label', submitter.textContent);
      // Keep the button's width so the row does not jump.
      submitter.style.minWidth = submitter.offsetWidth + 'px';
      submitter.textContent = busy;
      submitter.disabled = true;
    }
    // If navigation is blocked or slow, release the form so it is not stuck.
    setTimeout(function () {
      form.removeAttribute('data-sent');
      if (submitter && submitter.tagName === 'BUTTON') {
        submitter.disabled = false;
        var label = submitter.getAttribute('data-label');
        if (label) submitter.textContent = label;
      }
    }, 12000);
  });

  // Keep the live status strip current. Text only — never markup — because the
  // label can contain a place name the owner typed.
  function refreshStatus() {
    var strip = document.getElementById('ml-status');
    if (!strip || document.hidden) return;
    fetch('/api/status', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var dot = strip.querySelector('.dot');
        var text = strip.querySelector('.status-text');
        if (dot) dot.className = 'dot ' + (data.activityClass || '');
        if (text) text.textContent = data.label;
      })
      .catch(function () {});
  }
  setInterval(refreshStatus, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshStatus();
  });

  // On phones the bottom bar is fixed, and an open keyboard would otherwise sit
  // on top of the field being typed into.
  var body = document.body;
  document.addEventListener('focusin', function (event) {
    var el = event.target;
    if (el && el.matches && el.matches('input, textarea, select')) body.classList.add('keyboard');
  });
  document.addEventListener('focusout', function () {
    setTimeout(function () {
      var active = document.activeElement;
      if (!active || !active.matches || !active.matches('input, textarea, select')) {
        body.classList.remove('keyboard');
      }
    }, 80);
  });
})();
`;

export type NavKey = 'today' | 'trips' | 'places' | 'rules' | 'export' | 'settings' | 'more';

/**
 * Navigation, by where it appears.
 *
 * Desktop keeps a full row of tabs, because there is room for it and no reason
 * to hide anything. The phone bar is a different question: five slots, chosen by
 * what the owner of a mileage log actually does between one drive and the next —
 * sort out today's trips, label a place, check the year's totals, hand something
 * to the accountant. Everything else lives one tap deeper under More, which is a
 * real page rather than a menu, so it works without JavaScript and can be
 * bookmarked.
 *
 * There is one other role in this app: the accountant holding a share link. They
 * get no app navigation at all — the shared page is a document with its own
 * period links, and nothing else in the ledger is reachable from it.
 */
const DESKTOP_NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'today', href: '/', label: 'Today' },
  { key: 'trips', href: '/trips', label: 'Trips' },
  { key: 'places', href: '/places', label: 'Places' },
  { key: 'rules', href: '/rules', label: 'Rules' },
  { key: 'export', href: '/export', label: 'Export' },
  { key: 'settings', href: '/settings', label: 'Settings' },
];

const PHONE_NAV: { key: NavKey; href: string; label: string; icon: string; home?: boolean }[] = [
  { key: 'trips', href: '/trips', label: 'Trips', icon: '≡' },
  { key: 'places', href: '/places', label: 'Places', icon: '⌖' },
  // Centre slot: home, and made obvious.
  { key: 'today', href: '/', label: 'Dashboard', icon: '◉', home: true },
  { key: 'export', href: '/export', label: 'Export', icon: '↧' },
  { key: 'more', href: '/more', label: 'More', icon: '⋯' },
];

export type StatusStrip = { label: string; activityClass: string };

export type Appearance = 'system' | 'light' | 'dark';
export type ColourMode = 'colour' | 'mono';

export type LayoutOptions = {
  title: string;
  nav: NavKey | null;
  body: string;
  status?: StatusStrip | null;
  flash?: string | null;
  appearance: Appearance;
  colour: ColourMode;
};

/**
 * The page shell.
 *
 * The appearance choice is written onto the html element by the server, so the
 * first paint is already in the right palette — no flash of the wrong theme, and
 * no JavaScript needed to apply it.
 */
export function layout(options: LayoutOptions): string {
  const { title, nav, body, status, flash, appearance, colour } = options;

  const tabs = DESKTOP_NAV.map((item) => {
    const current = item.key === nav ? ' aria-current="page"' : '';
    return `<a href="${item.href}"${current}>${escape(item.label)}</a>`;
  }).join('');

  const bottom = PHONE_NAV.map((item) => {
    const current = item.key === nav ? ' aria-current="page"' : '';
    const classes = item.home === true ? ' class="home"' : '';
    return `<a href="${item.href}"${classes}${current}><span class="ico" aria-hidden="true">${item.icon}</span>${escape(item.label)}</a>`;
  }).join('');

  const statusHtml =
    status === null || status === undefined
      ? ''
      : `<div class="status" id="ml-status"><span class="dot ${escape(status.activityClass)}" aria-hidden="true"></span><span class="status-text">${escape(status.label)}</span></div>`;

  return `<!doctype html>
<html lang="en" data-appearance="${escape(appearance)}" data-colour="${escape(colour)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="${colour === 'mono' ? 'light dark' : 'light dark'}">
<meta name="theme-color" content="${appearance === 'dark' ? '#171b21' : '#ffffff'}">
<title>${escape(title)} · Mile Ledger</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231a6b40'/%3E%3Ctext x='16' y='22' font-family='sans-serif' font-size='17' font-weight='bold' fill='white' text-anchor='middle'%3EM%3C/text%3E%3C/svg%3E">
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap">
    <a class="brand" href="/"><span class="mark" aria-hidden="true">M</span> Mile Ledger</a>
    <nav class="tabs" aria-label="Sections">${tabs}</nav>
    ${statusHtml}
  </div>
</header>
<main class="wrap" id="main">
  ${
    flash === null || flash === undefined || flash === ''
      ? ''
      : `<div class="notice" role="status">${escape(flash)}</div>`
  }
  ${body}
</main>
<nav class="bottom" aria-label="Main">${bottom}</nav>
</body>
</html>`;
}

/**
 * Form fields.
 *
 * Every input goes through these so a label is always tied to its control —
 * which is what lets a screen reader announce the field, and what makes tapping
 * the label focus the input on a phone. They also carry the keyboard hints:
 * `inputmode` decides whether a phone offers letters, digits or a decimal pad,
 * and getting that wrong is one of the most obvious ways a web app feels wrong
 * on a phone.
 */
export type FieldOptions = {
  id: string;
  label: string;
  name?: string;
  value?: string | number | null;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'password' | 'date' | 'time' | 'search' | 'file' | 'email';
  inputmode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search';
  autocomplete?: string;
  required?: boolean;
  readonly?: boolean;
  extraAttributes?: string;
  className?: string;
};

function attribute(name: string, value: string | undefined): string {
  return value === undefined || value === '' ? '' : ` ${name}="${escape(value)}"`;
}

export function textField(options: FieldOptions): string {
  const name = options.name ?? options.id;
  const hintId = options.hint === undefined ? undefined : `${options.id}-hint`;
  return `<div class="field${options.className === undefined ? '' : ` ${options.className}`}">
    <label for="${escape(options.id)}">${escape(options.label)}</label>
    <input
      id="${escape(options.id)}"
      name="${escape(name)}"
      type="${options.type ?? 'text'}"
      value="${escape(options.value ?? '')}"
      ${attribute('placeholder', options.placeholder)}
      ${attribute('inputmode', options.inputmode)}
      ${attribute('autocomplete', options.autocomplete ?? 'off')}
      ${attribute('aria-describedby', hintId)}
      ${options.required === true ? 'required' : ''}
      ${options.readonly === true ? 'readonly' : ''}
      ${options.extraAttributes ?? ''}
    >
    ${hintId === undefined ? '' : `<div class="small" id="${escape(hintId)}">${options.hint ?? ''}</div>`}
  </div>`;
}

export function selectField(options: {
  id: string;
  label: string;
  name?: string;
  value: string;
  choices: { value: string; label: string }[];
  hint?: string;
  className?: string;
}): string {
  const name = options.name ?? options.id;
  const hintId = options.hint === undefined ? undefined : `${options.id}-hint`;
  return `<div class="field${options.className === undefined ? '' : ` ${options.className}`}">
    <label for="${escape(options.id)}">${escape(options.label)}</label>
    <select id="${escape(options.id)}" name="${escape(name)}"${attribute('aria-describedby', hintId)}>
      ${options.choices
        .map(
          (choice) =>
            `<option value="${escape(choice.value)}"${choice.value === options.value ? ' selected' : ''}>${escape(choice.label)}</option>`,
        )
        .join('')}
    </select>
    ${hintId === undefined ? '' : `<div class="small" id="${escape(hintId)}">${options.hint ?? ''}</div>`}
  </div>`;
}

export function checkField(options: {
  id: string;
  label: string;
  name?: string;
  checked: boolean;
  value?: string;
}): string {
  return `<div class="inline">
    <input type="checkbox" id="${escape(options.id)}" name="${escape(options.name ?? options.id)}" value="${escape(options.value ?? '1')}"${options.checked ? ' checked' : ''}>
    <label for="${escape(options.id)}">${escape(options.label)}</label>
  </div>`;
}

/** A numeric field with the right keyboard and a sensible pattern. */
export function numberField(options: FieldOptions & { decimal?: boolean }): string {
  return textField({
    ...options,
    inputmode: options.decimal === true ? 'decimal' : 'numeric',
    extraAttributes: `${options.extraAttributes ?? ''} pattern="${options.decimal === true ? '[0-9.,\\-]*' : '[0-9]*'}"`,
  });
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

export function card(
  body: string,
  options: { title?: string; tight?: boolean; id?: string } = {},
): string {
  const id = options.id === undefined ? '' : ` id="${escape(options.id)}"`;
  return `<section class="card${options.tight === true ? ' tight' : ''}"${id}>
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
