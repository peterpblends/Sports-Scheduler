import { orient, analyzeFrame, analyzeRecording, evaluateSession, hotspots, worst, DEFAULT_ANALYSIS, DEFAULT_RULES, DEFAULT_PHASES, PHASE_KINDS } from "./analysis.js";
import { drawHeatmap, SCALE_CSS } from "./heatmap.js";
import { connectMat, startDemo } from "./mat.js";
import { SCENARIOS } from "./demo.js";
import * as store from "./store.js";
import { createSync, pendingCount } from "./sync.js";

const APP_VERSION = "1.0.0";
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = v => (!isFinite(v) ? "—" : Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const pct = v => (isFinite(v) ? v.toFixed(0) + "%" : "—");
const clone = o => JSON.parse(JSON.stringify(o));
const VERDICT = { pass: "Fit verified", caution: "Review", fail: "Adjust fit", none: "Not captured", info: "Info" };
const ICON = { pass: "✓", caution: "!", fail: "✕", none: "–", info: "i" };
const badge = (status, text, big) => `<span class="badge ${status}${big ? " big" : ""}">${ICON[status] || ""} ${esc(text ?? VERDICT[status])}</span>`;

// ---------- settings ----------

const DEFAULTS = {
  matUrl: "http://10.0.0.1", viaServer: true, withers: "top", mirror: false,
  threshold: 0, channelWidth: 0.12, hotspotAbs: 0, hotspotRel: 2, units: "",
  colorTop: 0, smooth: true, guides: true, showCop: true, keepFrames: true,
  syncEnabled: true, syncUrl: "", syncToken: "", demoScenario: "good",
  rules: clone(DEFAULT_RULES),
};
let S = clone(DEFAULTS);
const analysisCfg = () => ({ ...DEFAULT_ANALYSIS, threshold: S.threshold, channelWidth: S.channelWidth, hotspotAbs: S.hotspotAbs, hotspotRel: S.hotspotRel });
let saveTimer = null;
function saveSettings() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.setMeta("settings", S).catch(() => {}), 250); }
const unit = () => (S.units ? " " + S.units : "");

// ---------- app state ----------

let server = null;               // /api/health response when served by server.py
let source = null;               // { kind: "mat" | "demo", close }
let latest = null;               // { raw, grid (saddle-oriented), stats, t }
let autoTop = 0;
let fps = 0, fpsCount = 0, fpsAt = performance.now();
let recorder = null;             // { sessionId, phaseKey, seconds, frames, times, startedAt }
let demoGait = { gait: "halt", mounted: true };
let activeId = null;             // session open in the Fit check tab
let view = "live";
let lastReadout = 0;

const sync = createSync({
  getConfig: () => S,
  onStatus: renderSync,
  onChange: () => { if (view === "sessions") renderSessions(); if (activeId) refreshActive(); },
});

// ---------- toast ----------

let toastTimer = null;
function toast(text) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- tabs ----------

function show(v) {
  view = v;
  for (const b of document.querySelectorAll("nav.tabs button")) b.classList.toggle("on", b.dataset.view === v);
  for (const s of document.querySelectorAll("main > .view")) s.hidden = s.id !== "view-" + v;
  if (v === "sessions") { $("report").hidden = true; $("sessionsList").hidden = false; renderSessions(); }
  if (v === "check") renderCheck();
  if (v === "settings") renderSettings();
  if (latest) drawLive(true);
  scrollTo(0, 0);
}
for (const b of document.querySelectorAll("nav.tabs button")) b.onclick = () => show(b.dataset.view);

// ---------- frames ----------

function onFrame(raw, t) {
  if (!Array.isArray(raw) || !raw.length || !Array.isArray(raw[0])) return;
  const grid = orient(raw, S.withers, S.mirror);
  const stats = analyzeFrame(grid, analysisCfg());
  latest = { raw, grid, stats, t };
  autoTop = Math.max(stats.peak, autoTop * 0.97, 1);
  fpsCount++;
  const now = performance.now();
  if (now - fpsAt >= 1000) { fps = Math.round((fpsCount * 1000) / (now - fpsAt)); fpsCount = 0; fpsAt = now; }
  if (recorder) {
    recorder.frames.push(raw); recorder.times.push(t);
    const left = recorder.seconds - (Date.now() - recorder.startedAt) / 1000;
    if (left <= 0) finishRecording();
    else renderCountdown(left);
  }
  drawLive(false);
}

// Re-derive the current frame after a settings change, without feeding the recorder.
function recompute() {
  if (!latest) return;
  latest.grid = orient(latest.raw, S.withers, S.mirror);
  latest.stats = analyzeFrame(latest.grid, analysisCfg());
  drawLive(true);
}

function drawLive(force) {
  if (!latest) return;
  const { grid, stats } = latest;
  const top = S.colorTop > 0 ? S.colorTop : autoTop;
  const opts = {
    top, threshold: S.threshold, smooth: S.smooth, guides: S.guides, channelWidth: S.channelWidth,
    cop: S.showCop && stats.area ? [stats.copLat, stats.copLong] : null,
  };
  const maxH = Math.min(innerHeight * (innerWidth < 760 ? 0.5 : 0.62), 580);
  if (view === "live") { drawHeatmap($("liveMap"), grid, { ...opts, fitHeight: maxH }); $("liveEmpty").hidden = true; }
  if (view === "check" && activeId) { drawHeatmap($("checkMap"), grid, { ...opts, fitHeight: Math.min(maxH, 460) }); $("checkEmpty").hidden = true; }
  const now = performance.now();
  if (!force && now - lastReadout < 200) return;
  lastReadout = now;
  $("scaleMax").textContent = fmt(top) + unit();
  $("fpsHint").textContent = `Grid: ${latest.raw.length} rows × ${latest.raw[0].length} cols · ${fps} fps${source?.kind === "demo" ? " · simulated" : ""}`;
  $("btnCsv").disabled = false;
  if (!stats.area) {
    for (const id of ["rLeft", "rRight", "rFront", "rMid", "rBack", "rChannel", "rMean"]) $(id).textContent = "—";
    $("rPeak").textContent = fmt(stats.peak); $("rArea").textContent = "0%";
    return;
  }
  $("rLeft").textContent = pct(stats.leftPct); $("rRight").textContent = pct(stats.rightPct);
  $("barLeft").style.width = stats.leftPct + "%";
  $("rFront").textContent = pct(stats.frontPct); $("rMid").textContent = pct(stats.midPct); $("rBack").textContent = pct(stats.backPct);
  $("barFront").style.width = stats.frontPct + "%"; $("barMid").style.width = stats.midPct + "%"; $("barBack").style.width = stats.backPct + "%";
  $("rChannel").textContent = stats.channelPct.toFixed(1) + "%";
  $("rPeak").textContent = fmt(stats.peak) + unit();
  $("rArea").textContent = stats.areaPct.toFixed(0) + "%";
  $("rMean").textContent = fmt(stats.meanContact) + unit();
  const want = Math.max(10, Math.ceil(stats.peak * 1.5));
  if (+$("colorTop").max < want) $("colorTop").max = want;
}
addEventListener("resize", () => { if (latest) drawLive(true); });

// ---------- connection ----------

function setMatStatus(text, cls) { $("matText").textContent = text; $("dot").className = "dot " + (cls || ""); }
function matMsg(t) { $("matMsg").textContent = t; $("matMsg").hidden = !t; }

function stopSource() {
  if (recorder) cancelRecording("Recording stopped: the frame source was disconnected.");
  if (source) { source.close(); source = null; }
  setMatStatus("Mat off", "");
  $("btnConnect").textContent = "Connect"; $("btnDemo").textContent = "Demo";
}

function useProxy() { return !!(server && server.matProxy && S.viaServer); }

function connect() {
  stopSource(); matMsg("");
  const base = useProxy() ? "mat" : S.matUrl.trim();
  if (!useProxy() && location.protocol === "https:" && base.startsWith("http:")) {
    matMsg("This page is on HTTPS, so the browser blocks plain-HTTP calls to the mat. At the barn, open the app from server.py over http:// instead (see README). Sessions still sync.");
    return;
  }
  source = { kind: "mat", ...connectMat({ base, onFrame, onStatus: setMatStatus, onError: matMsg }) };
  $("btnConnect").textContent = "Disconnect";
}
$("btnConnect").onclick = () => (source?.kind === "mat" ? stopSource() : connect());

function demo() {
  stopSource(); matMsg("");
  source = { kind: "demo", ...startDemo({ scenario: S.demoScenario, getGait: () => demoGait, onFrame, onStatus: setMatStatus }) };
  $("btnDemo").textContent = "Stop demo";
}
$("btnDemo").onclick = () => (source?.kind === "demo" ? stopSource() : demo());
$("demoScenario").innerHTML = Object.entries(SCENARIOS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
$("demoScenario").onchange = e => { S.demoScenario = e.target.value; saveSettings(); if (source?.kind === "demo") demo(); };
$("matUrl").onchange = e => { S.matUrl = e.target.value.trim() || DEFAULTS.matUrl; saveSettings(); };
$("viaServer").onchange = e => { S.viaServer = e.target.checked; saveSettings(); };

// ---------- display controls ----------

$("scaleBar").style.background = SCALE_CSS;
$("colorTop").oninput = e => { S.colorTop = +e.target.value; $("topLabel").textContent = S.colorTop ? fmt(S.colorTop) : "auto"; saveSettings(); drawLive(true); };
$("threshold").oninput = e => { S.threshold = +e.target.value; $("thrLabel").textContent = S.threshold; saveSettings(); recompute(); };
for (const k of ["smooth", "guides", "showCop"]) $(k).onchange = e => { S[k] = e.target.checked; saveSettings(); drawLive(true); };
$("btnCsv").onclick = () => { if (latest) download(`frame-${stamp()}.csv`, latest.grid.map(r => r.join(",")).join("\n"), "text/csv"); };

function applyDisplayControls() {
  $("matUrl").value = S.matUrl; $("viaServer").checked = S.viaServer;
  $("demoScenario").value = S.demoScenario;
  $("colorTop").max = Math.max(100, S.colorTop); $("colorTop").value = S.colorTop; $("topLabel").textContent = S.colorTop ? fmt(S.colorTop) : "auto";
  $("threshold").max = Math.max(50, S.threshold); $("threshold").value = S.threshold; $("thrLabel").textContent = S.threshold;
  for (const k of ["smooth", "guides", "showCop"]) $(k).checked = S[k];
}

// ---------- fit check ----------

$("setupForm").onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const session = {
    id: store.newId(), createdAt: Date.now(), appVersion: APP_VERSION,
    horse: f.horse.trim(), rider: f.rider.trim(), saddle: f.saddle.trim(), saddleSize: f.saddleSize.trim(),
    pad: f.pad.trim(), fitter: f.fitter.trim(), location: f.location.trim(), notes: f.notes.trim(),
    device: await store.deviceId(),
    phases: DEFAULT_PHASES.map(p => ({ ...p })), overall: "none",
  };
  await store.saveSession(session);
  if (f.fitter.trim()) await store.setMeta("lastFitter", f.fitter.trim());
  e.target.reset();
  navigator.storage?.persist?.().catch(() => {});
  openCheck(session.id);
  sync.sync();
};

async function openCheck(id) {
  activeId = id;
  await store.setMeta("activeSession", id);
  show("check");
}

async function renderCheck() {
  const session = activeId ? await store.getSession(activeId) : null;
  if (!session || session.deleted) {
    activeId = null;
    $("checkSetup").hidden = false; $("checkActive").hidden = true;
    const fitter = await store.getMeta("lastFitter");
    const input = $("setupForm").elements.fitter;
    if (fitter && !input.value) input.value = fitter;
    return;
  }
  $("checkSetup").hidden = true; $("checkActive").hidden = false;
  refreshActive(session);
  if (latest) drawLive(true);
}

async function refreshActive(session) {
  session = session || (activeId && (await store.getSession(activeId)));
  if (!session || view !== "check") return;
  evaluateSession(session, S.rules);
  $("checkHead").innerHTML = `
    <div><h3>${esc(session.horse || "Unnamed horse")}</h3>
    <p>${esc([session.rider, session.saddle, session.saddleSize].filter(Boolean).join(" · ") || "No rider or saddle details")}</p></div>
    ${badge(session.overall)}`;
  $("phaseList").innerHTML = session.phases.map((p, i) => {
    const rec = recorder && recorder.sessionId === session.id && recorder.phaseKey === p.key;
    const meta = p.result
      ? `${p.result.frameCount} frames · ${(p.result.durationMs / 1000).toFixed(0)} s · captured ${new Date(p.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : `${PHASE_KINDS[p.kind]} · ${p.seconds} s`;
    return `<li class="${rec ? "active" : ""}">
      <span class="pname">${i + 1}. ${esc(p.label)}</span>
      ${p.verdict ? badge(p.verdict.status) : rec ? `<span class="badge fail">● Rec</span>` : `<span class="badge none">Not captured</span>`}
      <span class="pmeta">${meta}</span>
      <span class="pbtns">
        ${rec ? `<button type="button" data-act="stop">Stop and analyse</button><button type="button" data-act="cancel">Cancel</button>`
              : `<button type="button" data-act="rec" data-key="${esc(p.key)}" ${recorder ? "disabled" : ""} class="${p.result ? "" : "primary"}">${p.result ? "Re-record" : "Record"}</button>
                 ${p.result ? "" : `<button type="button" data-act="remove" data-key="${esc(p.key)}" ${recorder ? "disabled" : ""}>Remove</button>`}`}
      </span></li>`;
  }).join("");
}

$("phaseList").onclick = async e => {
  const b = e.target.closest("button"); if (!b) return;
  const act = b.dataset.act;
  if (act === "rec") startRecording(b.dataset.key);
  else if (act === "stop") finishRecording();
  else if (act === "cancel") cancelRecording("Recording cancelled.");
  else if (act === "remove") {
    const s = await store.getSession(activeId);
    s.phases = s.phases.filter(p => p.key !== b.dataset.key);
    await store.saveSession(s); refreshActive(s); sync.sync();
  }
};

$("addPhaseForm").onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const s = await store.getSession(activeId);
  const key = "p" + Date.now().toString(36);
  const gait = f.kind === "saddle" ? "none" : f.kind === "halt" ? "halt" : "walk";
  s.phases.push({ key, label: f.label.trim(), kind: f.kind, gait, seconds: Math.max(3, Math.min(300, +f.seconds || 30)) });
  await store.saveSession(s);
  e.target.reset(); e.target.closest("details").open = false;
  refreshActive(s); sync.sync();
};

$("btnReport").onclick = () => { const id = activeId; show("sessions"); openReport(id); };
$("btnCloseCheck").onclick = async () => {
  if (recorder) return toast("Stop the recording first.");
  activeId = null; await store.setMeta("activeSession", null); renderCheck();
};

async function startRecording(phaseKey) {
  if (!source) { toast("Connect the mat or start the demo on the Live tab first."); return; }
  const s = await store.getSession(activeId);
  const p = s.phases.find(x => x.key === phaseKey);
  if (!p) return;
  demoGait = { gait: p.gait || (p.kind === "saddle" ? "none" : p.kind === "halt" ? "halt" : "walk"), mounted: p.kind !== "saddle" };
  recorder = { sessionId: s.id, phaseKey, label: p.label, seconds: p.seconds || 15, frames: [], times: [], startedAt: Date.now() };
  $("recBar").hidden = false;
  renderCountdown(recorder.seconds);
  refreshActive(s);
}

function renderCountdown(left) {
  const txt = `Recording ${recorder.label}: ${Math.ceil(left)} s left`;
  $("recText").textContent = txt;
  const c = $("countdown"); c.hidden = false;
  c.innerHTML = `${Math.ceil(left)} s<small>${esc(recorder.label)} · ${recorder.frames.length} frames</small>`;
}

function endRecorderUi() {
  recorder = null; $("recBar").hidden = true; $("countdown").hidden = true;
}

function cancelRecording(message) {
  if (!recorder) return;
  endRecorderUi(); toast(message); refreshActive();
}

async function finishRecording() {
  if (!recorder) return;
  const rec = recorder; endRecorderUi();
  if (rec.frames.length < 3) { toast("Too few frames to analyse. Check the mat stream and record again."); refreshActive(); return; }
  const cfg = analysisCfg();
  let result;
  try { result = analyzeRecording(rec.frames.map(g => orient(g, S.withers, S.mirror)), cfg, rec.times); }
  catch (err) { toast("Couldn't analyse that capture: " + err.message); refreshActive(); return; }
  const s = await store.getSession(rec.sessionId);
  const p = s && s.phases.find(x => x.key === rec.phaseKey);
  if (!p) return;
  p.result = { ...result, withers: S.withers, mirror: S.mirror, cfg };
  p.capturedAt = Date.now();
  p.source = source?.kind || "mat";
  evaluateSession(s, S.rules);
  await store.saveSession(s);
  if (S.keepFrames) {
    store.putFrames(s.id, p.key, { rows: rec.frames[0].length, cols: rec.frames[0][0].length, frames: rec.frames, times: rec.times, withers: S.withers, mirror: S.mirror })
      .catch(err => toast("Saved the analysis, but not the raw frames: " + err.message));
  }
  toast(`${p.label}: ${VERDICT[p.verdict.status]}`);
  refreshActive(s);
  sync.sync();
}
$("recBarStop").onclick = () => finishRecording();

// ---------- sessions list ----------

function syncMark(s) {
  if (s._syncError) return `<span class="syncmark err">Sync error</span>`;
  if (s._dirty) return `<span class="syncmark pending">Not synced yet</span>`;
  return `<span class="syncmark">Synced</span>`;
}

async function renderSessions() {
  const q = $("search").value.trim().toLowerCase();
  const all = await store.listSessions();
  const hits = all.filter(s => !q || [s.horse, s.rider, s.saddle, s.fitter, s.location].join(" ").toLowerCase().includes(q));
  $("sessionItems").innerHTML = hits.length ? hits.map(s => {
    evaluateSession(s, S.rules);
    return `<li><button type="button" data-id="${esc(s.id)}">
      <span class="t">${esc(s.horse || "Unnamed horse")}</span>
      <span class="r">${badge(s.overall)}${syncMark(s)}</span>
      <span class="s">${esc(new Date(s.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · ${esc([s.rider, s.saddle].filter(Boolean).join(" · ") || "—")}</span>
    </button></li>`;
  }).join("") : `<li class="emptylist">${all.length ? "No sessions match." : "No sessions yet. Start one from the Fit check tab."}</li>`;
}
$("search").oninput = renderSessions;
$("sessionItems").onclick = e => { const b = e.target.closest("button[data-id]"); if (b) openReport(b.dataset.id); };

// ---------- report ----------

const players = new Map();

async function openReport(id) {
  for (const p of players.values()) clearInterval(p);
  players.clear();
  const s = await store.getSession(id);
  if (!s || s.deleted) { toast("That session no longer exists."); renderSessions(); return; }
  evaluateSession(s, S.rules);
  $("sessionsList").hidden = true;
  const el = $("report"); el.hidden = false;
  const captured = s.phases.filter(p => p.result);
  const top = Math.max(1, ...captured.map(p => p.result.metrics.peakMean));
  const field = (label, v) => (v ? `<div><span>${label}</span>${esc(v)}</div>` : "");
  el.innerHTML = `<div class="report">
    <div class="row noprint">
      <button type="button" data-act="back">← Sessions</button>
      <button type="button" data-act="edit">Continue capture</button>
      <button type="button" data-act="recheck">New check, same setup</button>
    </div>
    <div class="card">
      <div class="sessionhead">
        <div><h3>${esc(s.horse || "Unnamed horse")}: saddle fit report</h3>
        <p>${esc(new Date(s.createdAt).toLocaleString([], { dateStyle: "long", timeStyle: "short" }))}</p></div>
        ${badge(s.overall, null, true)}
      </div>
      <div class="meta">
        ${field("Rider", s.rider)}${field("Saddle", s.saddle)}${field("Size / tree", s.saddleSize)}
        ${field("Pad / shims", s.pad)}${field("Fitter", s.fitter)}${field("Location", s.location)}
      </div>
      ${s.notes ? `<p class="hint">${esc(s.notes)}</p>` : ""}
      <p class="hint">${summaryLine(s)}</p>
    </div>
    ${captured.length ? captured.map(p => phaseCard(s, p)).join("") : `<div class="card"><p class="hint">No phases captured yet.</p></div>`}
    <p class="disclaimer">Verdicts compare the mat readings against the thresholds set in Settings. They support a qualified fitter's judgement, not replace it. Map: withers at the top, horse's left on the left; dashed lines mark thirds and the spine; outlined cells are hotspots; the white line is the centre-of-pressure path.</p>
    <div class="row noprint">
      <button type="button" data-act="print">Print / PDF</button>
      <button type="button" data-act="csv">Metrics CSV</button>
      <button type="button" data-act="json">Export session</button>
      <button type="button" data-act="reanalyse">Re-analyse</button>
      <button type="button" class="danger" data-act="delete">Delete</button>
    </div>
  </div>`;
  el.dataset.id = s.id;
  for (const p of captured) drawPhase(s, p, "mean", top);
  el.querySelectorAll(".segs").forEach(g => g.addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    const p = s.phases.find(x => x.key === g.dataset.key);
    if (b.dataset.mode === "replay") return replay(s, p, b, top);
    g.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    stopReplay(p.key, g);
    drawPhase(s, p, b.dataset.mode, top);
  }));
  scrollTo(0, 0);
}

function summaryLine(s) {
  const done = s.phases.filter(p => p.verdict);
  if (!done.length) return "No phases captured yet.";
  const issues = new Map();
  for (const p of done) for (const c of p.verdict.checks) if (c.status === "fail" || c.status === "caution") {
    const cur = issues.get(c.label);
    issues.set(c.label, cur ? worst([cur, c.status]) : c.status);
  }
  if (!issues.size) return `All ${done.length} captured phase${done.length > 1 ? "s" : ""} within thresholds.`;
  return "Flagged: " + [...issues].map(([k, v]) => `${esc(k)} (${v})`).join(", ") + ".";
}

function phaseCard(s, p) {
  const m = p.result.metrics;
  return `<div class="card phase-card">
    <div class="mini">
      <canvas class="minimap" id="mm-${esc(p.key)}" aria-label="${esc(p.label)} pressure map"></canvas>
      <div class="segs noprint" data-key="${esc(p.key)}">
        <button type="button" data-mode="mean" class="on">Mean</button><button type="button" data-mode="peak">Peak</button><button type="button" data-mode="replay">Replay</button>
      </div>
    </div>
    <div>
      <h3>${esc(p.label)} ${badge(p.verdict.status)}</h3>
      <p class="hint">${PHASE_KINDS[p.kind]} · ${p.result.frameCount} frames · ${(p.result.durationMs / 1000).toFixed(1)} s · peak ${fmt(m.peakMax)}${unit()}${p.source === "demo" ? " · simulated" : ""}</p>
      <table class="checks"><tbody>
        ${p.verdict.checks.map(c => `<tr><td>${badge(c.status, c.status === "info" ? "Info" : c.status === "pass" ? "OK" : c.status === "caution" ? "Caution" : "Fail")}</td>
          <td>${esc(c.label)}<span class="adv">${esc(c.detail)}${c.advice ? " " + esc(c.advice) : ""}</span></td>
          <td class="v">${esc(c.value)}</td></tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;
}

function drawPhase(s, p, mode, top) {
  const r = p.result, cv = $("mm-" + p.key); if (!cv) return;
  const grid = mode === "peak" ? r.peakGrid : r.meanGrid;
  const t = mode === "peak" ? Math.max(1, ...s.phases.filter(x => x.result).map(x => x.result.metrics.peakMax)) : top;
  const cfg = r.cfg || analysisCfg();
  drawHeatmap(cv, grid, {
    top: t, threshold: cfg.threshold, smooth: S.smooth, guides: true, channelWidth: cfg.channelWidth,
    hot: mode === "mean" ? hotspots(r.meanGrid, cfg).cells : null,
    trace: mode === "mean" ? r.copTrace : null,
    cop: mode === "mean" ? [r.metrics.copLat, r.metrics.copLong] : null,
  });
}

function stopReplay(key, group) {
  if (players.has(key)) { clearInterval(players.get(key)); players.delete(key); }
  const b = group && group.querySelector('[data-mode="replay"]'); if (b) b.textContent = "Replay";
}

async function replay(s, p, btn, top) {
  const group = btn.parentElement;
  if (players.has(p.key)) { stopReplay(p.key, group); return; }
  const rec = await store.getFrames(s.id, p.key);
  if (!rec || !rec.frames.length) { toast("No raw frames on this device for that phase."); return; }
  group.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === btn));
  btn.textContent = "Stop";
  const cv = $("mm-" + p.key), cfg = p.result.cfg || analysisCfg();
  const peakTop = Math.max(1, p.result.metrics.peakMax);
  let i = 0;
  players.set(p.key, setInterval(() => {
    if (!cv.isConnected) return stopReplay(p.key);
    const g = orient(rec.frames[i], rec.withers, rec.mirror), st = analyzeFrame(g, cfg);
    drawHeatmap(cv, g, { top: peakTop, threshold: cfg.threshold, smooth: S.smooth, guides: true, channelWidth: cfg.channelWidth, cop: st.area ? [st.copLat, st.copLong] : null });
    i = (i + 1) % rec.frames.length;
  }, 1000 / 12));
}

$("report").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = $("report").dataset.id, s = await store.getSession(id);
  switch (b.dataset.act) {
    case "back": for (const k of [...players.keys()]) stopReplay(k); $("report").hidden = true; $("sessionsList").hidden = false; renderSessions(); break;
    case "edit": openCheck(id); break;
    case "recheck": {
      const copy = {
        ...pick(s, ["horse", "rider", "saddle", "saddleSize", "pad", "fitter", "location"]),
        id: store.newId(), createdAt: Date.now(), appVersion: APP_VERSION, notes: `Re-check after ${new Date(s.createdAt).toLocaleString()}`,
        device: await store.deviceId(), previousId: s.id,
        phases: s.phases.map(p => pick(p, ["key", "label", "kind", "gait", "seconds"])), overall: "none",
      };
      await store.saveSession(copy); sync.sync(); openCheck(copy.id); break;
    }
    case "print": window.print(); break;
    case "csv": download(`fit-${slug(s)}.csv`, metricsCsv(s), "text/csv"); break;
    case "json": exportSessions([s]); break;
    case "reanalyse": await reanalyse(s); break;
    case "delete":
      if (!confirm(`Delete the fit check for ${s.horse || "this horse"}? This also deletes it on the sync server and other devices.`)) return;
      await store.deleteSession(id);
      if (activeId === id) { activeId = null; await store.setMeta("activeSession", null); }
      toast("Session deleted."); sync.sync();
      $("report").hidden = true; $("sessionsList").hidden = false; renderSessions();
      break;
  }
});

async function reanalyse(s) {
  let n = 0;
  const cfg = analysisCfg();
  for (const p of s.phases.filter(x => x.result)) {
    const rec = await store.getFrames(s.id, p.key);
    if (!rec) continue;
    p.result = { ...analyzeRecording(rec.frames.map(g => orient(g, S.withers, S.mirror)), cfg, rec.times), withers: S.withers, mirror: S.mirror, cfg };
    n++;
  }
  evaluateSession(s, S.rules);
  await store.saveSession(s); sync.sync();
  toast(n ? `Re-analysed ${n} phase${n > 1 ? "s" : ""} with the current orientation and analysis settings.` : "Verdicts refreshed. No raw frames on this device to re-analyse from.");
  openReport(s.id);
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const slug = s => `${(s.horse || "horse").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date(s.createdAt).toISOString().slice(0, 10)}`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function metricsCsv(s) {
  const cols = ["leftPct", "rightPct", "frontPct", "midPct", "backPct", "channelPct", "hotspotPct", "hotspotCells", "peakMax", "peakMean", "meanContact", "areaPct", "copLat", "copLong", "swayLat", "swayLong"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["horse", "rider", "saddle", "date", "phase", "kind", "verdict", "frames", "seconds", ...cols].join(",")];
  for (const p of s.phases.filter(x => x.result)) {
    lines.push([q(s.horse), q(s.rider), q(s.saddle), new Date(s.createdAt).toISOString(), q(p.label), p.kind, p.verdict.status, p.result.frameCount,
      (p.result.durationMs / 1000).toFixed(1), ...cols.map(c => +(+p.result.metrics[c]).toFixed(4))].join(","));
  }
  return lines.join("\n");
}

// ---------- export / import ----------

async function exportSessions(list) {
  const out = { format: "horse-fitter-verify", version: 1, exportedAt: new Date().toISOString(), sessions: [] };
  for (const s of list) {
    const frames = {};
    for (const p of s.phases || []) {
      const rec = await store.getFrames(s.id, p.key);
      if (rec) frames[p.key] = rec;
    }
    const clean = Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_")));
    out.sessions.push({ session: clean, frames });
  }
  download(list.length === 1 ? `fit-${slug(list[0])}.json` : `fit-sessions-${stamp()}.json`, JSON.stringify(out), "application/json");
}
$("btnExportAll").onclick = async () => { const all = await store.listSessions(); if (!all.length) return toast("No sessions to export."); exportSessions(all); };

$("btnImport").onclick = () => $("fileIn").click();
$("fileIn").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    let n = 0;
    if (data.format === "horse-fitter-verify") {
      for (const { session, frames } of data.sessions || []) {
        if (!session || !session.id) continue;
        const local = await store.getSession(session.id);
        if (local && local.updatedAt >= session.updatedAt) continue;
        await store.putSessionRaw({ ...session, _dirty: true });
        for (const [key, rec] of Object.entries(frames || {})) await store.putFrames(session.id, key, rec);
        n++;
      }
    } else if (Array.isArray(data.frames) && data.frames[0]?.g) {
      // Recording exported by the earlier Tactilus Mat app.
      const raws = data.frames.map(x => x.g), times = data.frames.map(x => x.t);
      const cfg = analysisCfg();
      const phase = { key: "import", label: "Imported recording", kind: "halt", gait: "halt", seconds: Math.round((times.at(-1) - times[0]) / 1000) || 0 };
      phase.result = { ...analyzeRecording(raws.map(g => orient(g, S.withers, S.mirror)), cfg, times), withers: S.withers, mirror: S.mirror, cfg };
      phase.capturedAt = Date.parse(data.startedAt) || Date.now();
      const s = { id: store.newId(), createdAt: phase.capturedAt, appVersion: APP_VERSION, horse: f.name.replace(/\.json$/i, ""), notes: "Imported from a Tactilus Mat recording.", device: await store.deviceId(), phases: [phase] };
      evaluateSession(s, S.rules);
      await store.saveSession(s);
      await store.putFrames(s.id, "import", { rows: raws[0].length, cols: raws[0][0].length, frames: raws, times, withers: S.withers, mirror: S.mirror });
      n = 1;
    } else throw new Error("not a recognised file");
    toast(n ? `Imported ${n} session${n > 1 ? "s" : ""}.` : "Nothing new in that file.");
    renderSessions(); sync.sync();
  } catch (err) { toast("That file isn't a session export from this app (" + err.message + ")."); }
};

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// ---------- sync UI ----------

function renderSync(st) {
  const dot = $("syncDot"), text = $("syncText");
  const pending = st.pending || 0;
  if (st.state === "syncing") { dot.className = "sdot busy"; text.textContent = "Syncing…"; }
  else if (st.state === "off") { dot.className = "sdot"; text.textContent = pending ? `Sync off · ${pending}` : "Sync off"; }
  else if (st.state === "ok") { dot.className = "sdot " + (pending ? "pending" : "ok"); text.textContent = pending ? `${pending} to sync` : "Synced"; }
  else if (st.state === "offline") { dot.className = "sdot pending"; text.textContent = pending ? `Offline · ${pending} saved` : "Offline"; }
  else if (st.state === "error") { dot.className = "sdot err"; text.textContent = "Sync error"; }
  $("syncPill").title = st.message || (st.at ? "Last synced " + new Date(st.at).toLocaleTimeString() : "Sync now");
  if (view === "settings") renderSyncDetail(st);
}
function renderSyncDetail(st = sync.status) {
  const base = S.syncUrl.trim() || (server ? location.origin + " (this server)" : "not set");
  const parts = [`Server: ${base}.`];
  if (st.at) parts.push(`Last sync ${new Date(st.at).toLocaleString()}.`);
  if (st.pending) parts.push(`${st.pending} session${st.pending > 1 ? "s" : ""} waiting to upload.`);
  if (st.message) parts.push(st.message);
  if (!S.syncUrl.trim() && !server) parts.push("This copy of the app wasn't opened from server.py, so enter a sync server address to sync.");
  $("syncDetail").textContent = parts.join(" ");
}
$("syncPill").onclick = () => { if (!S.syncEnabled) { show("settings"); return; } sync.sync(); };
$("btnSyncNow").onclick = () => sync.sync();

// ---------- settings UI ----------

const RULE_LABELS = {
  balance: ["Left / right imbalance", "pts"], bridging: ["Bridging: middle-third share below", "%"], rocking: ["Rocking: middle-third share above", "%"],
  frontLoad: ["Front-third share above", "%"], backLoad: ["Back-third share above", "%"], channel: ["Load on spine channel above", "%"],
  hotspots: ["Hotspot area above (% of contact)", "%"], riderShift: ["Rider shift vs saddle only", "pts"],
  swayLat: ["Side-to-side sway (SD, fraction of width)", ""], swayLong: ["Front-to-back sway (SD, fraction of length)", ""],
};

function renderSettings() {
  $("syncEnabled").checked = S.syncEnabled; $("syncUrl").value = S.syncUrl; $("syncToken").value = S.syncToken;
  $("withers").value = S.withers; $("mirror").checked = S.mirror;
  $("units").value = S.units; $("channelWidth").value = Math.round(S.channelWidth * 100);
  $("hotspotAbs").value = S.hotspotAbs; $("hotspotRel").value = S.hotspotRel; $("keepFrames").checked = S.keepFrames;
  $("rulesTable").tBodies[0].innerHTML = Object.entries(RULE_LABELS).map(([k, [label, u]]) => `<tr><td>${esc(label)}${u ? ` <span class="hint">(${u})</span>` : ""}</td>
    <td><input type="number" step="any" data-rule="${k}" data-lvl="caution" value="${S.rules[k].caution}"></td>
    <td><input type="number" step="any" data-rule="${k}" data-lvl="fail" value="${S.rules[k].fail}"></td></tr>`).join("");
  renderSyncDetail();
  renderDevice();
}

async function renderDevice() {
  const bits = [`Version ${APP_VERSION}.`];
  const sw = navigator.serviceWorker?.controller;
  bits.push(sw ? "Offline app: installed, opens without a connection." : window.isSecureContext
    ? "Offline app: installing (reload once)." : "Offline app shell needs HTTPS or localhost; on the barn server the app loads over the local network without internet.");
  if (server) bits.push(`Served by server.py${server.matProxy ? " with mat proxy" : ""}${server.upstream ? ", forwarding to " + server.upstream : ""}.`);
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) bits.push(`Storage used ${(est.usage / 1048576).toFixed(1)} MB${persisted ? " (persistent)" : ""}.`);
  } catch {}
  bits.push(`${await pendingCount()} session(s) waiting to sync.`);
  $("deviceInfo").textContent = bits.join(" ");
}

$("view-settings").addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.rule) {
    const v = parseFloat(t.value);
    if (isFinite(v)) S.rules[t.dataset.rule][t.dataset.lvl] = v;
  } else switch (t.id) {
    case "syncEnabled": S.syncEnabled = t.checked; break;
    case "syncUrl": S.syncUrl = t.value.trim(); break;
    case "syncToken": S.syncToken = t.value.trim(); break;
    case "withers": S.withers = t.value; autoTop = 0; break;
    case "mirror": S.mirror = t.checked; break;
    case "units": S.units = t.value.trim(); break;
    case "channelWidth": S.channelWidth = Math.max(0, Math.min(50, +t.value || 0)) / 100; break;
    case "hotspotAbs": S.hotspotAbs = Math.max(0, +t.value || 0); break;
    case "hotspotRel": S.hotspotRel = Math.max(1, +t.value || 2); break;
    case "keepFrames": S.keepFrames = t.checked; break;
    default: return;
  }
  saveSettings();
  if (["syncEnabled", "syncUrl", "syncToken"].includes(t.id)) sync.sync();
  recompute();
  renderSyncDetail();
});
$("btnRulesReset").onclick = () => { S.rules = clone(DEFAULT_RULES); saveSettings(); renderSettings(); toast("Thresholds reset to defaults."); };

let installPrompt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; $("btnInstall").hidden = false; });
$("btnInstall").onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $("btnInstall").hidden = true; };

// ---------- boot ----------

(async function boot() {
  try {
    const saved = await store.getMeta("settings");
    if (saved) S = { ...clone(DEFAULTS), ...saved, rules: { ...clone(DEFAULT_RULES), ...(saved.rules || {}) } };
  } catch (err) { toast("Local storage is unavailable, so sessions can't be saved: " + err.message); }
  applyDisplayControls();

  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
    const r = await fetch("api/health", { cache: "no-store", signal: ctl.signal });
    if (r.ok) { const j = await r.json(); if (j.app === "horse-fitter-verify") server = j; }
  } catch {}
  $("viaServerRow").hidden = !(server && server.matProxy);

  activeId = (await store.getMeta("activeSession").catch(() => null)) || null;
  if (location.hash === "#check") show("check"); else if (location.hash === "#sessions") show("sessions"); else show("live");

  sync.start();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", e => { if (e.data === "sync") sync.sync(); });
    navigator.serviceWorker.ready.then(reg => reg.sync?.register("hfv-sync")).catch(() => {});
  }
})();
