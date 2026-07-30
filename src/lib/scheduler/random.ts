/**
 * Deterministic randomness.
 *
 * Non-negotiable #5: the same config and the same seed must produce the same
 * schedule. `Math.random()` would break that, so the engine uses this instead and
 * never touches the global RNG or the clock.
 *
 * mulberry32 — small, fast, and good enough for tie-breaking and shuffling.
 */
export type Rng = {
  /** Float in [0, 1). */
  next: () => number
  /** Integer in [0, max). */
  int: (max: number) => number
  /** A new independent stream, derived from a label. Keeps phases from interfering. */
  fork: (label: string) => Rng
}

export function createRng(seed: number): Rng {
  let state = (seed >>> 0) || 1

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (max) => (max <= 0 ? 0 : Math.floor(next() * max)),
    fork: (label) => createRng(mixSeed(seed, label)),
  }
}

/** Folds a label into a seed, so `fork('officials')` is stable across runs. */
export function mixSeed(seed: number, label: string): number {
  let hash = seed >>> 0
  for (let i = 0; i < label.length; i++) {
    hash = (Math.imul(hash ^ label.charCodeAt(i), 0x01000193) >>> 0) + 1
  }
  return hash >>> 0
}

/** Fisher–Yates, driven by `rng`. Returns a new array; does not mutate the input. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const a = out[i]!
    const b = out[j]!
    out[i] = b
    out[j] = a
  }
  return out
}
