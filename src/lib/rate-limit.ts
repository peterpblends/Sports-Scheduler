import { HttpError } from './http'

/**
 * Fixed-window rate limiting for the endpoints worth brute-forcing.
 *
 * Deliberately in-process and dependency-free. That is a real limitation and it is
 * stated rather than hidden: with more than one server process each keeps its own
 * counters, so the effective limit is the configured one multiplied by the number of
 * processes. It is still the difference between thousands of password guesses a
 * minute and a handful, which is the attack that matters. `createRateLimiter` takes
 * its own store so a shared backend (Redis, or a Postgres table) can be substituted
 * without touching a single call site.
 *
 * Two axes, checked independently, because each catches what the other misses:
 *
 *  * **per identifier** (the submitted email) stops one account being ground through
 *    a password list from many addresses;
 *  * **per client** (IP) stops one host working through many accounts.
 *
 * A rejected request is a 429 carrying `Retry-After`, and — importantly — rejection
 * happens *before* the password is verified, so it also caps the argon2 work an
 * anonymous caller can force the server to do. Without that, the hashing parameters
 * are themselves a denial-of-service lever.
 */

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

type Counter = { count: number; resetAt: number }

export type RateLimitResult = {
  ok: boolean
  /** Seconds until the window rolls over. Populated whether or not it is allowed. */
  retryAfterSeconds: number
  remaining: number
}

export interface RateLimitStore {
  hit(key: string, rule: RateLimitRule, now: number): RateLimitResult
  /** Drops one key's counter. Used to clear a budget after a successful attempt. */
  clear(key: string): void
  reset(): void
}

/**
 * In-memory store with opportunistic eviction.
 *
 * Expired entries are dropped on write rather than on a timer, so the map cannot
 * grow without bound from a spray of one-shot keys — which is itself the memory
 * exhaustion a naive rate limiter introduces while trying to prevent one. A hard cap
 * bounds the worst case if eviction cannot keep up.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, Counter>()
  private readonly maxKeys: number

  constructor(maxKeys = 20_000) {
    this.maxKeys = maxKeys
  }

  hit(key: string, rule: RateLimitRule, now: number): RateLimitResult {
    const existing = this.counters.get(key)

    if (!existing || existing.resetAt <= now) {
      this.evict(now)
      const resetAt = now + rule.windowMs
      this.counters.set(key, { count: 1, resetAt })
      return {
        ok: true,
        retryAfterSeconds: Math.ceil(rule.windowMs / 1000),
        remaining: rule.limit - 1,
      }
    }

    existing.count += 1
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    return {
      ok: existing.count <= rule.limit,
      retryAfterSeconds,
      remaining: Math.max(0, rule.limit - existing.count),
    }
  }

  clear(key: string): void {
    this.counters.delete(key)
  }

  reset(): void {
    this.counters.clear()
  }

  private evict(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key)
    }
    if (this.counters.size < this.maxKeys) return
    // Still over the cap after dropping expired entries: shed the oldest windows.
    const ordered = [...this.counters.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    for (const [key] of ordered.slice(0, Math.ceil(this.maxKeys / 10))) this.counters.delete(key)
  }
}

export const rateLimitStore: RateLimitStore = new MemoryRateLimitStore()

/** Thrown as a 429 with `Retry-After`, which well-behaved clients honour. */
export function tooManyRequests(retryAfterSeconds: number, message: string): HttpError {
  return new HttpError(429, message, { retryAfterSeconds })
}

export type RateLimitCheck = {
  /** Namespace, so the same email cannot consume the login and reset budgets as one. */
  bucket: string
  /** Usually the normalised email. Omitted when only the client matters. */
  identifier?: string | null
  /** Client address, from `clientIp`. */
  ip?: string | null
  perIdentifier?: RateLimitRule
  perIp?: RateLimitRule
  message?: string
}

/**
 * Applies whichever rules were given and throws on the first one exceeded.
 *
 * Both axes are *recorded* even when an earlier one rejects, so a caller cannot
 * spend one budget for free by tripping the other.
 */
export function enforceRateLimit(
  check: RateLimitCheck,
  now: number = Date.now(),
  store: RateLimitStore = rateLimitStore,
): void {
  const results: RateLimitResult[] = []

  if (check.perIdentifier && check.identifier) {
    // Lower-cased so `Admin@x` and `admin@x` share one budget, matching how the
    // account itself is looked up.
    results.push(
      store.hit(`${check.bucket}:id:${check.identifier.toLowerCase()}`, check.perIdentifier, now),
    )
  }
  if (check.perIp && check.ip) {
    results.push(store.hit(`${check.bucket}:ip:${check.ip}`, check.perIp, now))
  }

  const rejected = results.find((result) => !result.ok)
  if (rejected) {
    throw tooManyRequests(
      rejected.retryAfterSeconds,
      check.message ?? 'Too many attempts. Try again shortly.',
    )
  }
}

/**
 * Forgets an identifier's budget in a bucket.
 *
 * Called after a *successful* authentication so a user who proves who they are is not
 * left throttled by somebody else's failed guesses against their address. Per-email
 * limiting has an inherent cost — an attacker can burn a victim's budget and delay
 * their sign-in — and this does not remove that, but it stops the delay outlasting the
 * moment the real user gets in. The per-IP budget is deliberately *not* cleared: that
 * one is tracking the caller, and a caller who just authenticated once has not earned
 * an unlimited allowance.
 */
export function clearIdentifierLimit(
  bucket: string,
  identifier: string,
  store: RateLimitStore = rateLimitStore,
): void {
  store.clear(`${bucket}:id:${identifier.toLowerCase()}`)
}

/** Limits for the endpoints an anonymous caller can reach. */
export const AUTH_LIMITS = {
  /** Password guessing. Tight per account, looser per host for shared NATs. */
  login: {
    perIdentifier: { limit: 8, windowMs: 10 * 60 * 1000 },
    perIp: { limit: 40, windowMs: 10 * 60 * 1000 },
  },
  /** Account creation, which also sends no mail — cheap to abuse, easy to cap. */
  signup: {
    perIp: { limit: 10, windowMs: 60 * 60 * 1000 },
  },
  /** Sends an email, so this is an outbound-spam lever as much as an auth one. */
  passwordReset: {
    perIdentifier: { limit: 5, windowMs: 60 * 60 * 1000 },
    perIp: { limit: 20, windowMs: 60 * 60 * 1000 },
  },
  /** Token guessing against reset and invitation links. */
  tokenSubmission: {
    perIp: { limit: 30, windowMs: 10 * 60 * 1000 },
  },
  /** Authenticated but still worth capping: each one sends mail. */
  invitation: {
    perIdentifier: { limit: 50, windowMs: 60 * 60 * 1000 },
  },
} as const
