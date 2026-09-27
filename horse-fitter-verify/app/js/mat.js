// Frame sources: the Tactilus mat over its WiFi module, or the demo simulator.
// Both call onFrame(grid, timestampMs) with the raw (un-oriented) grid.

import { makeDemo } from "./demo.js";

// Tactilus stream: PUT /api/frequency to start, then Server-Sent Events on /api/sse
// with "newframe" events whose data is { readings: [grid], timestamp }.
// base: "http://10.0.0.1" for direct, or "mat" (relative) when server.py proxies it.
export function connectMat({ base, onFrame, onStatus, onError }) {
  let es = null, closed = false, gotFrame = false;
  const root = base.replace(/\/+$/, "");
  (async () => {
    onStatus("Connecting…", "");
    try {
      // The vendor sample sends 10800 (3 hours, in seconds) to keep the stream alive.
      await fetch(root + "/api/frequency", {
        method: "PUT",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "10800",
      });
    } catch {
      onError(`Couldn't reach the mat at ${root}. Check this device is on the mat's WiFi. Trying the stream anyway…`);
    }
    if (closed) return;
    es = new EventSource(root + "/api/sse");
    es.onopen = () => { if (!gotFrame) onStatus("Stream open, waiting for frames", "live"); };
    es.onerror = () => { if (!closed) onStatus(gotFrame ? "Stream dropped, reconnecting…" : "Can't open the mat stream, retrying…", "err"); };
    es.addEventListener("newframe", e => {
      let p;
      try { p = JSON.parse(e.data); } catch { onError("Got a frame the app couldn't parse: " + String(e.data).slice(0, 80)); return; }
      const grid = p && p.readings ? p.readings[0] : Array.isArray(p) ? p : null;
      if (!Array.isArray(grid) || !Array.isArray(grid[0])) return;
      if (!gotFrame) { gotFrame = true; onError(""); }
      onStatus("Live", "live");
      onFrame(grid, typeof p.timestamp === "number" ? p.timestamp : Date.now());
    });
  })();
  return { close() { closed = true; if (es) es.close(); } };
}

// Demo: 12 fps. getGait() is read every frame so a fit-check phase can switch the
// simulated horse between standing, walk, trot and canter.
export function startDemo({ scenario, getGait, onFrame, onStatus }) {
  const frame = makeDemo({ scenario, seed: Date.now() });
  const t0 = performance.now();
  onStatus("Demo (simulated)", "live");
  const id = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const { gait, mounted } = getGait();
    onFrame(frame(t, gait, mounted), Date.now());
  }, 1000 / 12);
  return { close() { clearInterval(id); } };
}
