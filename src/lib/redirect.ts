/**
 * Validation for post-login redirect targets.
 *
 * `?next=` is attacker-supplied: a phishing link can point at this app's real login
 * page and still land the victim somewhere else once they authenticate, which is
 * exactly what makes an open redirect useful. So the target is validated rather than
 * merely checked for a leading slash.
 *
 * `startsWith('/')` is not sufficient, and that is the trap this replaces:
 *
 *  * `//evil.example` is a **protocol-relative** URL. It starts with `/`, and every
 *    browser resolves it to `https://evil.example`.
 *  * `/\evil.example` and `/\/evil.example` are normalised by several browsers by
 *    turning the backslash into a slash, arriving at the same place.
 *  * `/%09//evil.example` and friends smuggle control characters that some parsers
 *    strip before resolving.
 *
 * Deliberately in `src/lib` with no server-only imports, because the server page and
 * the client form both redirect and must agree. Two copies of this rule is how one of
 * them ends up lenient.
 */

const DEFAULT_PATH = '/app'

export function safeRedirectPath(next: string | null | undefined, fallback = DEFAULT_PATH): string {
  if (!next) return fallback

  // Control characters and whitespace can be stripped or normalised downstream,
  // changing what the value means after this check has passed.
  if (/[\u0000-\u0020\u007f-\u009f]/.test(next)) return fallback

  // Must be a rooted path, and must not be protocol-relative in any spelling.
  if (!next.startsWith('/')) return fallback
  if (next.startsWith('//')) return fallback
  if (next.startsWith('/\\')) return fallback

  // A backslash anywhere in the leading segment can be re-read as a slash.
  if (next.includes('\\')) return fallback

  // Anything that parses as absolute against a throwaway base has an authority
  // component, which a same-origin path never does. This is the backstop for
  // spellings not enumerated above.
  try {
    const resolved = new URL(next, 'https://redirect.invalid')
    if (resolved.origin !== 'https://redirect.invalid') return fallback
  } catch {
    return fallback
  }

  return next
}
