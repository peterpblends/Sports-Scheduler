// Saddle-fit analysis. Pure functions only: no DOM, no storage, so they run in the
// browser and under `node --test` alike.
//
// Coordinate convention after orient(): row 0 is the front of the saddle (withers),
// the last row is the back (cantle); column 0 is the horse's left, the last column
// its right, as seen from above looking forward (the rider's view).

export const DEFAULT_ANALYSIS = {
  threshold: 0,        // values at or below this are treated as no contact
  channelWidth: 0.12,  // spine channel, as a fraction of the mat width, centred
  hotspotAbs: 0,       // absolute hotspot pressure; 0 = use hotspotRel instead
  hotspotRel: 2,       // hotspot = cell mean ≥ this × mean loaded-cell pressure
};

// Default verdict thresholds. These are starting points for a fitter to tune, not
// clinically validated limits; every value is editable in Settings.
export const DEFAULT_RULES = {
  balance:    { caution: 5,    fail: 10 },   // |left% − 50|, percentage points
  bridging:   { caution: 25,   fail: 20 },   // middle-third load share below this, %
  rocking:    { caution: 45,   fail: 52 },   // middle-third load share above this, %
  frontLoad:  { caution: 45,   fail: 55 },   // front-third load share, %
  backLoad:   { caution: 45,   fail: 55 },   // back-third load share, %
  channel:    { caution: 3,    fail: 6 },    // share of load inside the spine channel, %
  hotspots:   { caution: 2,    fail: 5 },    // hotspot cells as % of contact area
  riderShift: { caution: 5,    fail: 10 },   // change in left% vs the saddle-only phase
  swayLat:    { caution: 0.03, fail: 0.06 }, // SD of lateral COP, fraction of width
  swayLong:   { caution: 0.04, fail: 0.08 }, // SD of longitudinal COP, fraction of length
};

export const PHASE_KINDS = {
  saddle: "Saddle only",
  halt: "Rider at halt",
  moving: "Rider in motion",
};

export const DEFAULT_PHASES = [
  { key: "saddle", label: "Saddle only (girthed)", kind: "saddle", gait: "none", seconds: 10 },
  { key: "halt", label: "Rider mounted, halt", kind: "halt", gait: "halt", seconds: 15 },
  { key: "walk", label: "Walk", kind: "moving", gait: "walk", seconds: 30 },
  { key: "trot", label: "Trot", kind: "moving", gait: "trot", seconds: 30 },
  { key: "canter", label: "Canter", kind: "moving", gait: "canter", seconds: 30 },
];

// ---------- orientation ----------

// Map a raw mat grid into saddle coordinates.
// withers: which edge of the raw grid sits at the front of the saddle.
// mirror: swap left and right (mat laid face-down, or cable on the other side).
export function orient(grid, withers = "top", mirror = false) {
  const R = grid.length, C = grid[0].length;
  let out;
  if (withers === "bottom") {
    out = grid.map((_, r) => grid[R - 1 - r].slice().reverse());
  } else if (withers === "left") {
    out = Array.from({ length: C }, (_, i) => Array.from({ length: R }, (_, j) => grid[R - 1 - j][i]));
  } else if (withers === "right") {
    out = Array.from({ length: C }, (_, i) => Array.from({ length: R }, (_, j) => grid[j][C - 1 - i]));
  } else {
    out = grid.map(row => row.slice());
  }
  if (mirror) for (const row of out) row.reverse();
  return out;
}

// ---------- single frame ----------

export function analyzeFrame(g, cfg = DEFAULT_ANALYSIS) {
  const R = g.length, C = g[0].length;
  const thr = cfg.threshold ?? 0, halfCh = (cfg.channelWidth ?? 0.12) / 2;
  let total = 0, peak = 0, area = 0, wx = 0, wy = 0;
  let left = 0, right = 0, front = 0, mid = 0, back = 0, channel = 0;
  for (let r = 0; r < R; r++) {
    const y = (r + 0.5) / R;
    const third = y < 1 / 3 ? 0 : y < 2 / 3 ? 1 : 2;
    const row = g[r];
    for (let c = 0; c < C; c++) {
      const v = row[c];
      if (!(v > thr)) continue;
      const x = (c + 0.5) / C;
      total += v; area++; wx += x * v; wy += y * v;
      if (v > peak) peak = v;
      if (Math.abs(x - 0.5) < 1e-9) { left += v / 2; right += v / 2; }
      else if (x < 0.5) left += v; else right += v;
      if (third === 0) front += v; else if (third === 1) mid += v; else back += v;
      if (Math.abs(x - 0.5) < halfCh) channel += v;
    }
  }
  const pct = v => (total ? (v / total) * 100 : 0);
  return {
    total, peak, area,
    areaPct: (area / (R * C)) * 100,
    meanContact: area ? total / area : 0,
    copLat: total ? wx / total : 0.5,
    copLong: total ? wy / total : 0.5,
    leftPct: pct(left), rightPct: pct(right),
    frontPct: pct(front), midPct: pct(mid), backPct: pct(back),
    channelPct: pct(channel),
  };
}

// Hotspot cells in a grid: absolute threshold if set, otherwise relative to the
// mean contact pressure of that grid.
// The relative limit uses the mean of cells carrying at least 10% of the peak, so
// faint edge contact and noise don't drag the reference down.
export function hotspots(g, cfg = DEFAULT_ANALYSIS) {
  const f = analyzeFrame(g, cfg);
  let limit = cfg.hotspotAbs;
  if (!(limit > 0)) {
    let sum = 0, n = 0;
    for (const row of g) for (const v of row) if (v > cfg.threshold && v >= f.peak * 0.1) { sum += v; n++; }
    limit = (n ? sum / n : 0) * (cfg.hotspotRel ?? 2);
  }
  const cells = [];
  if (!f.area || !(limit > 0)) return { limit, cells, pctOfContact: 0 };
  for (let r = 0; r < g.length; r++) for (let c = 0; c < g[0].length; c++) if (g[r][c] >= limit) cells.push([r, c]);
  return { limit, cells, pctOfContact: (cells.length / f.area) * 100 };
}

// ---------- recording ----------

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = a => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map(v => (v - m) ** 2))); };

// frames: array of saddle-oriented grids. times: matching timestamps in ms (optional).
export function analyzeRecording(frames, cfg = DEFAULT_ANALYSIS, times = []) {
  if (!frames.length) throw new Error("No frames to analyse");
  const R = frames[0].length, C = frames[0][0].length;
  const meanGrid = Array.from({ length: R }, () => new Array(C).fill(0));
  const peakGrid = Array.from({ length: R }, () => new Array(C).fill(0));
  const per = [];
  let used = 0;
  for (const g of frames) {
    if (g.length !== R || g[0].length !== C) continue; // grid size changed mid-recording
    used++;
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const v = g[r][c] > 0 ? g[r][c] : 0;
      meanGrid[r][c] += v;
      if (v > peakGrid[r][c]) peakGrid[r][c] = v;
    }
    per.push(analyzeFrame(g, cfg));
  }
  for (const row of meanGrid) for (let c = 0; c < C; c++) row[c] = round(row[c] / used, 3);

  const loaded = per.filter(f => f.total > 0);
  const pick = k => avg(loaded.map(f => f[k]));
  const meanFrame = analyzeFrame(meanGrid, cfg);
  const hs = hotspots(meanGrid, cfg);

  const step = Math.max(1, Math.ceil(loaded.length / 300));
  const copTrace = loaded.filter((_, i) => i % step === 0).map(f => [round(f.copLat, 4), round(f.copLong, 4)]);

  return {
    rows: R, cols: C, frameCount: used,
    durationMs: times.length > 1 ? times[times.length - 1] - times[0] : 0,
    meanGrid, peakGrid, copTrace,
    metrics: {
      leftPct: pick("leftPct"), rightPct: pick("rightPct"),
      frontPct: pick("frontPct"), midPct: pick("midPct"), backPct: pick("backPct"),
      channelPct: pick("channelPct"),
      copLat: pick("copLat"), copLong: pick("copLong"),
      swayLat: sd(loaded.map(f => f.copLat)), swayLong: sd(loaded.map(f => f.copLong)),
      peakMax: Math.max(0, ...per.map(f => f.peak)),
      peakMean: meanFrame.peak,
      meanContact: meanFrame.meanContact,
      areaPct: meanFrame.areaPct,
      totalMean: pick("total"),
      hotspotPct: hs.pctOfContact, hotspotCells: hs.cells.length, hotspotLimit: hs.limit,
      loadedFrames: loaded.length,
    },
  };
}

// ---------- verdicts ----------

const RANK = { pass: 0, info: 0, caution: 1, fail: 2 };
const above = (v, t) => (v > t.fail ? "fail" : v > t.caution ? "caution" : "pass");
const below = (v, t) => (v < t.fail ? "fail" : v < t.caution ? "caution" : "pass");
const f1 = v => v.toFixed(1);

export function worst(statuses) {
  let w = "pass";
  for (const s of statuses) if (RANK[s] > RANK[w]) w = s;
  return w;
}

// m: metrics from analyzeRecording. kind: "saddle" | "halt" | "moving".
// baseline: metrics of the saddle-only phase, if one was captured.
export function evaluate(m, kind, rules = DEFAULT_RULES, baseline = null) {
  const checks = [];
  const add = (id, label, status, value, detail, advice) => checks.push({ id, label, status, value, detail, advice: status === "pass" ? "" : advice });

  if (!m.loadedFrames) {
    add("contact", "Contact", "fail", "none", "No pressure above the contact threshold was recorded.",
      "Check the mat is under the saddle, connected, and that the contact threshold isn't too high.");
    return { checks, status: "fail" };
  }

  const dev = Math.abs(m.leftPct - 50);
  const side = m.leftPct > 50 ? "left" : "right";
  add("balance", "Left / right balance", above(dev, rules.balance), `${f1(m.leftPct)} / ${f1(m.rightPct)}`,
    `Left ${f1(m.leftPct)}% · right ${f1(m.rightPct)}%${dev >= 1 ? ` (more load on the ${side})` : ""}.`,
    kind === "saddle"
      ? `Saddle sits heavier on the ${side}. Check the tree is straight, the panels are evenly flocked, and for asymmetric muscling (often the left shoulder).`
      : `More load on the ${side}. Compare with the saddle-only phase to separate saddle asymmetry from rider position; check stirrup lengths.`);

  const mid = m.midPct, endsHeavy = m.frontPct > mid && m.backPct > mid;
  if (endsHeavy && mid < rules.bridging.caution) {
    add("bridging", "Bridging", below(mid, rules.bridging), `${f1(mid)}% mid`,
      `Only ${f1(mid)}% of load in the middle third; front ${f1(m.frontPct)}%, back ${f1(m.backPct)}%.`,
      "Panels are touching at the front and back with little support in the middle. The tree may be too straight for this back, or the panels need more flocking mid-panel.");
  } else if (mid > rules.rocking.caution) {
    add("bridging", "Rocking", above(mid, rules.rocking), `${f1(mid)}% mid`,
      `${f1(mid)}% of load concentrated in the middle third.`,
      "Load is concentrated under the middle of the saddle, so it can rock. The tree or panels may be too curved (banana-shaped) for this back.");
  } else {
    add("bridging", "Bridging / rocking", "pass", `${f1(mid)}% mid`,
      `Front ${f1(m.frontPct)}% · middle ${f1(mid)}% · back ${f1(m.backPct)}%.`, "");
  }

  add("front", "Front (tree points)", above(m.frontPct, rules.frontLoad), `${f1(m.frontPct)}%`,
    `${f1(m.frontPct)}% of load in the front third.`,
    "High load at the front can mean the tree is too narrow or the gullet angle too closed, pinching at the tree points.");
  add("back", "Back (cantle)", above(m.backPct, rules.backLoad), `${f1(m.backPct)}%`,
    `${f1(m.backPct)}% of load in the back third.`,
    "High load at the back can mean the tree is too wide (saddle tips down at the front) or the rider sits behind the movement.");

  add("channel", "Spine clearance", above(m.channelPct, rules.channel), `${f1(m.channelPct)}%`,
    `${f1(m.channelPct)}% of load inside the spine channel.`,
    "Pressure in the channel means the spine isn't clear. The channel may be too narrow, or the saddle is sitting too low.");

  add("hotspots", "Pressure hotspots", above(m.hotspotPct, rules.hotspots), `${m.hotspotCells} cells`,
    `${m.hotspotCells} cells at or above ${f1(m.hotspotLimit)} (${f1(m.hotspotPct)}% of contact area).`,
    "Localised high pressure. Check the highlighted areas on the map for lumpy flocking, a twisted tree, or girth-point pressure.");

  if (kind !== "saddle") {
    if (baseline && baseline.loadedFrames) {
      const shift = m.leftPct - baseline.leftPct, dir = shift > 0 ? "left" : "right";
      add("riderShift", "Rider lateral shift", above(Math.abs(shift), rules.riderShift), `${shift >= 0 ? "+" : ""}${f1(shift)} pts`,
        `Rider moves the load ${f1(Math.abs(shift))} points to the ${dir} compared with the saddle alone.`,
        `The rider is sitting to the ${dir}. Check stirrup lengths, rider symmetry, and whether the saddle slips to one side once mounted.`);
    }
    add("swayLat", "Rider stability (side to side)", above(m.swayLat, rules.swayLat), `${f1(m.swayLat * 100)}% W`,
      `Centre of pressure moves ${f1(m.swayLat * 100)}% of the mat width side to side (SD).`,
      "The load moves a lot side to side. Check the saddle isn't rolling (tree too wide or round back) and the rider's lateral balance.");
    add("swayLong", "Rocking in motion (front to back)", above(m.swayLong, rules.swayLong), `${f1(m.swayLong * 100)}% L`,
      `Centre of pressure moves ${f1(m.swayLong * 100)}% of the mat length front to back (SD).`,
      "The saddle or rider rocks front to back. Check the tree curve against the back, and the rider's seat position.");
  }

  add("area", "Contact area", "info", `${f1(m.areaPct)}%`,
    `${f1(m.areaPct)}% of the mat in contact; mean contact pressure ${f1(m.meanContact)}, peak ${f1(m.peakMax)}.`, "");

  return { checks, status: worst(checks.map(c => c.status)) };
}

// Re-evaluate every phase of a session. The saddle-only phase becomes the baseline
// for rider-shift checks.
export function evaluateSession(session, rules = DEFAULT_RULES) {
  const phases = session.phases || [];
  const base = phases.find(p => p.kind === "saddle" && p.result)?.result.metrics || null;
  for (const p of phases) if (p.result) p.verdict = evaluate(p.result.metrics, p.kind, rules, p.kind === "saddle" ? null : base);
  const done = phases.filter(p => p.verdict);
  session.overall = done.length ? worst(done.map(p => p.verdict.status)) : "none";
  return session;
}

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }
