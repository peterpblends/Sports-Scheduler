import type { NextConfig } from 'next'

/**
 * Static response headers.
 *
 * The Content-Security-Policy is deliberately NOT here — it needs a per-request
 * nonce, so it is set in src/middleware.ts. See the note there for why a static
 * `script-src 'self'` breaks Next's inline hydration scripts.
 *
 * Everything below is request-independent and costs nothing to emit from config.
 * `frame-ancestors 'none'` lives in the middleware CSP; `X-Frame-Options` is the
 * equivalent for browsers that predate it, and the schedule editor is a
 * drag-and-drop surface worth protecting from clickjacking.
 */
const securityHeaders = [
  // Blocks MIME sniffing, which is what turns an innocuous upload into script.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Full URLs can carry invitation and reset tokens in the query string; never send
  // them to another origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here needs any of these, so none is granted.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@node-rs/argon2', '@prisma/client'],
  // Version and framework fingerprinting that buys an attacker reconnaissance and
  // buys the app nothing.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
