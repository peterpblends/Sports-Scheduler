// Heatmap rendering for saddle-oriented grids (withers at the top of the canvas).

const STOPS = [[15, 20, 27], [35, 48, 107], [30, 127, 208], [46, 208, 168], [242, 226, 74], [242, 140, 40], [196, 30, 30]];
const LUT = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = (i / 255) * (STOPS.length - 1), k = Math.min(Math.floor(t), STOPS.length - 2), f = t - k;
  for (let c = 0; c < 3; c++) LUT[i * 3 + c] = STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * f;
}
export const SCALE_CSS = `linear-gradient(90deg, ${STOPS.map(s => `rgb(${s.join(",")})`).join(", ")})`;

const off = document.createElement("canvas"), octx = off.getContext("2d");

// opts: top (colour-scale max), threshold, smooth, guides, channelWidth, fitHeight (px),
//       cop [lat, long] (0–1), trace [[lat, long]…], hot [[r, c]…]
export function drawHeatmap(canvas, grid, opts = {}) {
  const R = grid.length, C = grid[0].length;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let cssW;
  if (opts.fitHeight) {
    // Fill the parent's width, but no taller than fitHeight; keep cells square.
    let w = canvas.parentElement.clientWidth || C * 8, h = (w * R) / C;
    if (h > opts.fitHeight) { h = opts.fitHeight; w = (h * C) / R; }
    w = Math.floor(w); h = Math.floor(h);
    if (canvas.style.width !== w + "px") { canvas.style.width = w + "px"; canvas.style.height = h + "px"; }
    cssW = w;
  } else {
    cssW = canvas.clientWidth || C * 8; // CSS sets the width; height follows the bitmap ratio
  }
  const W = Math.max(C, Math.round(cssW * dpr)), H = Math.round((W * R) / C);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

  if (off.width !== C || off.height !== R) { off.width = C; off.height = R; }
  const img = octx.createImageData(C, R), d = img.data;
  const top = opts.top > 0 ? opts.top : 1, thr = opts.threshold || 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const v = grid[r][c], i = (r * C + c) * 4;
    const n = v > thr ? Math.max(1, Math.min(255, Math.round((v / top) * 255))) : 0;
    d[i] = LUT[n * 3]; d[i + 1] = LUT[n * 3 + 1]; d[i + 2] = LUT[n * 3 + 2]; d[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = !!opts.smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, W, H);

  const cw = W / C, ch = H / R, lw = Math.max(1, dpr);
  if (opts.guides) {
    const half = (opts.channelWidth || 0) / 2;
    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(W * (0.5 - half), 0, W * half * 2, H);
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = lw; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 3); ctx.lineTo(W, H / 3);
    ctx.moveTo(0, (2 * H) / 3); ctx.lineTo(W, (2 * H) / 3);
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (opts.hot && opts.hot.length) {
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = lw;
    for (const [r, c] of opts.hot) ctx.strokeRect(c * cw + lw / 2, r * ch + lw / 2, cw - lw, ch - lw);
  }
  if (opts.trace && opts.trace.length > 1) {
    ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = lw;
    ctx.beginPath();
    opts.trace.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    ctx.stroke();
  }
  if (opts.cop) {
    const x = opts.cop[0] * W, y = opts.cop[1] * H, s = Math.max(6, W / 18);
    ctx.lineWidth = 2 * lw; ctx.strokeStyle = "rgba(0,0,0,.55)";
    cross(ctx, x, y, s); ctx.lineWidth = lw; ctx.strokeStyle = "#fff"; cross(ctx, x, y, s);
  }
}

function cross(ctx, x, y, s) {
  ctx.beginPath(); ctx.arc(x, y, s * 0.45, 0, Math.PI * 2);
  ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
  ctx.stroke();
}
