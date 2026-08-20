/**
 * Request guards: where a request is allowed to come from, and how often.
 *
 * SameSite=Lax cookies already stop a cross-site form post from carrying the
 * session, so this is a second line rather than the only one. It is cheap, it
 * has no state to configure, and it turns a whole class of mistake into a 403.
 */
import type { IncomingMessage } from 'node:http';

/** Fixed-window counter. Small, predictable, and it forgets. */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** True when the caller is within its allowance. */
  allow(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const entry = this.hits.get(key);
    if (entry === undefined || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (entry === undefined) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /**
   * Drop expired entries. Without this the map is a slow memory leak on any
   * machine that is reachable from the internet and gets scanned.
   */
  private sweep(now: number): void {
    if (this.hits.size < 512) {
      // Cheap path: only sweep when the map is big enough to matter.
      return;
    }
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

export function clientKey(request: IncomingMessage): string {
  // Behind a proxy the socket address is the proxy's, so prefer the forwarded
  // address when one is present. Only the first hop is meaningful.
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded !== '') return forwarded;
  return request.socket.remoteAddress ?? 'unknown';
}

/**
 * Does this state-changing request look like it came from our own pages?
 *
 * A missing Origin is accepted: some browsers omit it on same-origin form
 * submissions, and rejecting those would break the app for real users. A present
 * but foreign Origin, or an explicit cross-site fetch, is refused.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return false;

  const origin = request.headers.origin;
  if (origin === undefined || origin === 'null' || origin === '') return true;

  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
