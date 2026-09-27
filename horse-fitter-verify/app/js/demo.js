// Simulated saddle on a 64 × 27 mat (withers at row 0), so every screen and every
// verdict can be exercised without the mat. Pure: frame(t) returns a new grid.

export const SCENARIOS = {
  good: "Good fit",
  bridging: "Bridging (tree too straight)",
  rocking: "Rocking (tree too curved)",
  narrow: "Too narrow (pinching at front)",
  wide: "Too wide (tipping onto the back)",
  channel: "Channel too narrow (on the spine)",
  left: "Uneven (heavier on the left)",
  riderLeft: "Rider sitting to the left",
};

const GAITS = {
  none: { hz: 0, lat: 0, long: 0, bounce: 0 },
  halt: { hz: 0.25, lat: 0.004, long: 0.004, bounce: 0.02 },
  walk: { hz: 0.9, lat: 0.012, long: 0.02, bounce: 0.08 },
  trot: { hz: 1.45, lat: 0.008, long: 0.02, bounce: 0.3 },
  canter: { hz: 1.9, lat: 0.012, long: 0.06, bounce: 0.25 },
};

export function makeDemo({ scenario = "good", rows = 64, cols = 27, seed = 1 } = {}) {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  // Longitudinal load profile along the panel (0 = front, 1 = back).
  const profile = y => {
    const bump = (c, w) => Math.exp(-(((y - c) / w) ** 2));
    switch (scenario) {
      case "bridging": return 1.25 * bump(0.12, 0.12) + 0.12 * bump(0.5, 0.2) + 1.1 * bump(0.86, 0.12);
      case "rocking": return 0.2 * bump(0.1, 0.1) + 1.3 * bump(0.5, 0.2) + 0.15 * bump(0.9, 0.1);
      case "narrow": return 1.9 * bump(0.1, 0.1) + 0.5 * bump(0.45, 0.25) + 0.3 * bump(0.85, 0.15);
      case "wide": return 0.25 * bump(0.12, 0.1) + 0.5 * bump(0.5, 0.25) + 1.6 * bump(0.86, 0.14);
      default: return 0.75 * bump(0.18, 0.18) + 0.65 * bump(0.5, 0.25) + 0.6 * bump(0.82, 0.18);
    }
  };
  const panelGap = scenario === "channel" ? 0.02 : 0.14;   // half-width of the spine channel
  const panelW = 0.2;                                       // half-width of each panel
  const sideBias = scenario === "left" ? 0.3 : 0;          // saddle asymmetry
  const riderBias = scenario === "riderLeft" ? 0.35 : 0;   // extra rider load on the left

  // gait: key of GAITS; mounted: rider on board.
  return function frame(t, gait = "halt", mounted = gait !== "none") {
    const G = GAITS[gait] || GAITS.halt;
    const w = 2 * Math.PI * G.hz * t;
    const latShift = G.lat * Math.sin(w) + (scenario === "riderLeft" && mounted ? -0.02 : 0);
    const longShift = G.long * Math.sin(w + 0.7);
    const load = (mounted ? 1 : 0.18) * (1 + G.bounce * Math.sin(2 * w)) * (1 + 0.03 * Math.sin(t * 0.7));
    const g = [];
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) / rows;
      const inSaddle = y > 0.05 && y < 0.95;
      const py = profile(Math.min(1, Math.max(0, (y - longShift - 0.05) / 0.9)));
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) / cols - 0.5 - latShift;           // −0.5 … 0.5, 0 = spine
        const ax = Math.abs(x), isLeft = x < 0;
        let v = 0;
        if (inSaddle) {
          const edge = (ax - panelGap) / panelW;               // 0 = inner edge, 1 = outer edge
          const px = edge < -0.3 ? 0 : edge < 0 ? (edge + 0.3) / 0.3 * 0.5 : Math.exp(-(((edge - 0.45) / 0.55) ** 2));
          const sideK = 1 + (isLeft ? sideBias : -sideBias * 0.8) + (mounted ? (isLeft ? riderBias : -riderBias * 0.8) : 0);
          v = px * py * sideK * load * 42;
          if (scenario === "channel" && ax < 0.06) v += 14 * load * py;
        }
        v += (rand() - 0.5) * 1.2;
        row[c] = v < 1.5 ? 0 : Math.round(v * 10) / 10;
      }
      g.push(row);
    }
    return g;
  };
}
