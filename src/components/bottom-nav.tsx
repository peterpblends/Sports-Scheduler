'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

/**
 * The mobile bottom tab bar — the fixed row of icon buttons many phone apps use
 * instead of (or alongside) a drawer, so the handful of things a role actually does
 * are one thumb-reach away instead of two taps behind the "Menu" drawer.
 *
 * This is additive to, not a replacement for, the drawer built in the org layout:
 * the drawer still carries the full role-permitted list (Leagues, Setup, switching
 * organizations, and so on) for the less-frequent trip. This bar is deliberately
 * short — five icons at most, Dashboard always the center one — because a bottom
 * bar that needs its own horizontal scroll has stopped being a bottom bar.
 *
 * Needs `usePathname`, so it is the one client component in an otherwise
 * server-rendered layout — the same trade the drawer's `SignOutButton` already
 * makes. `hidden md:hidden` at the call site keeps it mobile-only; the desktop nav
 * row above md already puts every one of these within a single click.
 */

const ICONS = {
  dashboard: (
    <path d="M4 11.5 12 4l8 7.5M6 10v9a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1v-9" />
  ),
  schedule: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M3.5 10h17" />
    </>
  ),
  officiating: <path d="M5 3v18M5 4.5h12l-2.5 3.25L17 11H5" />,
  members: (
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.75 20c.4-3.5 3-6 6.25-6s5.85 2.5 6.25 6" />
      <circle cx="17" cy="8.5" r="2.25" />
      <path d="M15 14.3c2.4.5 4.1 2.6 4.4 5.7" />
    </>
  ),
  venues: (
    <>
      <path d="M12 21s6.5-6 6.5-10.75a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21Z" />
      <circle cx="12" cy="10" r="2.25" />
    </>
  ),
  team: (
    <path d="M8.5 3 4.5 6l2 3.25 2-1.1V19a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V8.15l2 1.1 2-3.25L15.5 3l-2 2h-3Z" />
  ),
  alerts: (
    <>
      <path d="M6.25 9a5.75 5.75 0 1 1 11.5 0c0 4.1 1.5 5.5 1.5 5.5h-14.5s1.5-1.4 1.5-5.5Z" />
      <path d="M9.75 17a2.25 2.25 0 0 0 4.5 0" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20c.35-3.75 3.6-6.5 7.5-6.5s7.15 2.75 7.5 6.5" />
    </>
  ),
} as const

export type BottomNavIcon = keyof typeof ICONS

export type BottomNavItem = {
  href: string
  label: string
  icon: BottomNavIcon
  badge?: number
  /** Only Dashboard needs this — its href is a prefix of every other item's href. */
  exact?: boolean
}

function matches(pathname: string, item: BottomNavItem) {
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

/**
 * The single active tab, chosen by longest matching href rather than "does it
 * match at all". Officiating's href (`/schedule/officials`) sits under Schedule's
 * (`/schedule`), so on `/schedule/officials` both match as prefixes — without this,
 * Schedule (checked first) would win and the tab you're actually on would look
 * unselected. Longest match = most specific route = correct tab.
 */
function activeHref(pathname: string, items: BottomNavItem[]): string | null {
  let best: string | null = null
  for (const item of items) {
    if (matches(pathname, item) && (best === null || item.href.length > best.length)) {
      best = item.href
    }
  }
  return best
}

export function BottomNav({ items }: { items: BottomNavItem[] }) {
  const pathname = usePathname()
  const current = activeHref(pathname, items)

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden dark:border-ink-700 dark:bg-ink-800"
    >
      <div className="mx-auto flex max-w-6xl">
        {items.map((item) => {
          const active = item.href === current
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs font-medium',
                active ? 'text-turf-600' : 'text-ink-500 dark:text-ink-300',
              )}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6"
                aria-hidden="true"
              >
                {ICONS[item.icon]}
              </svg>
              <span className="max-w-full truncate px-1">{item.label}</span>
              {!!item.badge && item.badge > 0 && (
                <span
                  className="absolute top-1 right-1/4 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
                  aria-label={`${item.badge} waiting on you`}
                >
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              )}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
