import { test } from "node:test";
import assert from "node:assert/strict";
import { orient, analyzeFrame, analyzeRecording, evaluate, evaluateSession, hotspots, worst, DEFAULT_PHASES } from "../app/js/analysis.js";
import { makeDemo, SCENARIOS } from "../app/js/demo.js";
import { takeRemote, forUpload } from "../app/js/sync.js";

const g = [[1, 2, 3], [4, 5, 6]]; // 2 rows × 3 cols

test("orient: every withers edge and mirror", () => {
  assert.deepEqual(orient(g, "top"), g);
  assert.deepEqual(orient(g, "bottom"), [[6, 5, 4], [3, 2, 1]]);
  assert.deepEqual(orient(g, "left"), [[4, 1], [5, 2], [6, 3]]);   // column 0 becomes the front row
  assert.deepEqual(orient(g, "right"), [[3, 6], [2, 5], [1, 4]]);  // last column becomes the front row
  assert.deepEqual(orient(g, "top", true), [[3, 2, 1], [6, 5, 4]]);
  assert.deepEqual(g, [[1, 2, 3], [4, 5, 6]], "input not mutated");
});

test("analyzeFrame: left/right split puts an odd centre column half on each side", () => {
  const f = analyzeFrame([[10, 20, 30]], { threshold: 0, channelWidth: 0 });
  assert.equal(f.total, 60);
  assert.equal(f.leftPct, (10 + 10) / 60 * 100);
  assert.equal(f.rightPct, (30 + 10) / 60 * 100);
});

test("analyzeFrame: thirds, channel, threshold, centre of pressure", () => {
  const grid = [
    [1, 0, 1],
    [0, 8, 0],
    [1, 0, 1],
  ];
  const f = analyzeFrame(grid, { threshold: 0, channelWidth: 0.34 });
  assert.equal(f.frontPct, 2 / 12 * 100);
  assert.equal(f.midPct, 8 / 12 * 100);
  assert.equal(f.channelPct, 8 / 12 * 100);
  assert.ok(Math.abs(f.copLat - 0.5) < 1e-9 && Math.abs(f.copLong - 0.5) < 1e-9);
  const t = analyzeFrame(grid, { threshold: 1, channelWidth: 0 });
  assert.equal(t.area, 1, "values at the threshold count as no contact");
});

test("analyzeFrame: empty grid is safe", () => {
  const f = analyzeFrame([[0, 0], [0, 0]]);
  assert.equal(f.total, 0); assert.equal(f.leftPct, 0); assert.equal(f.copLat, 0.5);
});

test("hotspots: absolute and relative limits", () => {
  const grid = [[1, 1, 1, 1], [1, 9, 1, 1]];
  assert.deepEqual(hotspots(grid, { threshold: 0, hotspotAbs: 5 }).cells, [[1, 1]]);
  const rel = hotspots(grid, { threshold: 0, hotspotAbs: 0, hotspotRel: 2 });
  assert.deepEqual(rel.cells, [[1, 1]]);
});

test("analyzeRecording: mean/peak grids, sway, skips frames of a different size", () => {
  const frames = [[[2, 0], [0, 2]], [[4, 0], [0, 4]], [[1, 1, 1]]];
  const r = analyzeRecording(frames, { threshold: 0, channelWidth: 0 }, [0, 100, 200]);
  assert.equal(r.frameCount, 2);
  assert.deepEqual(r.meanGrid, [[3, 0], [0, 3]]);
  assert.deepEqual(r.peakGrid, [[4, 0], [0, 4]]);
  assert.equal(r.durationMs, 200);
  assert.equal(r.metrics.swayLat, 0);
  assert.throws(() => analyzeRecording([]));
});

test("worst", () => {
  assert.equal(worst(["pass", "info", "caution"]), "caution");
  assert.equal(worst(["pass", "fail", "caution"]), "fail");
  assert.equal(worst([]), "pass");
});

test("evaluate: no contact fails", () => {
  const v = evaluate({ loadedFrames: 0 }, "halt");
  assert.equal(v.status, "fail");
});

// Run a full simulated fit check for one demo scenario.
function simulate(scenario) {
  const frame = makeDemo({ scenario, seed: 7 });
  const s = { phases: DEFAULT_PHASES.map(p => ({ ...p })) };
  for (const p of s.phases) {
    const frames = [], times = [];
    for (let i = 0; i < 8 * 12; i++) { frames.push(frame(i / 12, p.gait, p.kind !== "saddle")); times.push(i * 83); }
    p.result = analyzeRecording(frames, undefined, times);
  }
  return evaluateSession(s);
}
const flagged = (s, id) => s.phases.some(p => p.verdict.checks.some(c => c.id === id && c.status === "fail"));

test("demo: a good fit passes every phase", () => {
  const s = simulate("good");
  assert.equal(s.overall, "pass", JSON.stringify(s.phases.map(p => p.verdict.checks.filter(c => c.status !== "pass" && c.status !== "info"))));
});

test("demo: each faulty scenario fails on the check it simulates", () => {
  const expect = { bridging: "bridging", rocking: "bridging", narrow: "front", wide: "back", channel: "channel", left: "balance", riderLeft: "riderShift" };
  for (const [scenario, id] of Object.entries(expect)) {
    const s = simulate(scenario);
    assert.equal(s.overall, "fail", scenario);
    assert.ok(flagged(s, id), `${scenario} should fail ${id}`);
  }
  assert.deepEqual(Object.keys(SCENARIOS).sort(), ["good", ...Object.keys(expect)].sort());
});

test("demo: rider shift only appears once a rider is on", () => {
  const s = simulate("riderLeft");
  assert.equal(s.phases[0].verdict.checks.find(c => c.id === "balance").status, "pass");
  assert.ok(!s.phases[0].verdict.checks.some(c => c.id === "riderShift"));
});

test("sync: last writer wins, underscore fields stay local", () => {
  assert.equal(takeRemote(null, { updatedAt: 1 }), true);
  assert.equal(takeRemote({ updatedAt: 5 }, { updatedAt: 6 }), true);
  assert.equal(takeRemote({ updatedAt: 6 }, { updatedAt: 6 }), false);
  assert.equal(takeRemote({ updatedAt: 7, _dirty: true }, { updatedAt: 6 }), false);
  assert.deepEqual(forUpload({ id: "a", updatedAt: 1, _dirty: true, _syncError: "x" }), { id: "a", updatedAt: 1 });
});
