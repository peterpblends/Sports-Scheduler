import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 256 bits of entropy, url-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Tokens are stored as SHA-256 digests. They are already high-entropy random
 * values, so a slow KDF buys nothing here — but a leaked table must not hand
 * anyone a usable session or reset link.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
