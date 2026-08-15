/**
 * THE YARD's mark: a geometric Y that reads as goalposts. Straight lines only, one
 * path, so it holds up from a 16px favicon to a header lockup without redrawing.
 *
 * Rendered as a fixed iron-tile-with-gold-Y crest — like a real team crest, this does
 * not invert with the light/dark toggle. The colors are the literal hex values (not
 * `currentColor`/CSS variables) because this markup is reused verbatim in
 * `src/app/icon.svg`, a static file Next serves directly as the favicon outside any
 * page's stylesheet — it has no `--color-*` custom properties to resolve.
 */
const TILE = '#171512'
const GOLD = '#F2B01E'
const Y_PATH = 'M10 13 L41 55 L41 87 L59 87 L59 55 L90 13 L68 13 L50 38 L32 13 Z'

export function YardMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="THE YARD"
      className={className}
    >
      <rect width="100" height="100" rx="22" fill={TILE} />
      <path d={Y_PATH} fill={GOLD} />
    </svg>
  )
}

/** Crest plus wordmark — the brand link used in every header. */
export function YardLockup({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <YardMark size={size} />
      <span className="text-sm font-black tracking-tight uppercase">THE YARD</span>
    </span>
  )
}
