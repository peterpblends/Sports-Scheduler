import { NextResponse, type NextRequest } from 'next/server'

/**
 * Per-request Content-Security-Policy with a nonce.
 *
 * This exists because a static `script-src 'self'` header is not merely imperfect
 * here — it breaks the application outright. Next streams the React payload to the
 * browser in inline `<script>` blocks (`self.__next_f.push(...)`), five of them on a
 * plain login page. With no nonce and no `'unsafe-inline'`, the browser refuses all
 * of them, React never hydrates, and every client component — the login form, the
 * drag-and-drop schedule editor, the accept/decline buttons — silently does nothing.
 *
 * The fix is a nonce rather than `'unsafe-inline'`, because `'unsafe-inline'` on
 * `script-src` gives up the part of CSP that actually matters. Next reads the nonce
 * out of the `Content-Security-Policy` header on the *request* and stamps it onto the
 * script tags it generates, so the policy and the markup agree without either being
 * hand-maintained.
 *
 * `'strict-dynamic'` is required alongside the nonce: the nonce'd bootstrap script
 * loads the route's chunks, and without it those chunk loads are refused.
 *
 * Everything that does not need a nonce stays in next.config.ts, where it costs
 * nothing per request.
 */
export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID()

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // The trailing `https: 'unsafe-inline'` is not the mistake it looks like. A
    // browser that understands `'strict-dynamic'` ignores both the host allowlist and
    // `'unsafe-inline'` entirely, so the effective policy there is nonce-only. They
    // are fallbacks for older browsers, which would otherwise refuse everything and
    // serve a blank page. This is the layered form Google's CSP guidance recommends.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    // Next injects critical CSS inline, and there is no nonce mechanism for it.
    // Scoped to styles, which cannot execute.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')

  // Next looks for the nonce on the request headers. `x-nonce` is additionally
  // available to server components that need to nonce something themselves.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', csp)
  return response
}

export const config = {
  /**
   * Skips Next's own static assets and the image optimizer. Those are immutable,
   * fingerprinted files that execute nothing, and running middleware for each one
   * would add a nonce computation per asset for no benefit.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
