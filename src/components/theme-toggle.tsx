'use client'

import { useEffect, useState } from 'react'
import clsx from 'clsx'

/**
 * Light / Dark / Auto. The mode a person picked is what persists (`localStorage`);
 * "Auto" is resolved to a concrete `light`/`dark` and written onto
 * `<html data-theme>`, which is the only thing `globals.css`'s `dark:` variant
 * actually looks at — see the comment there for why. A blocking script in the root
 * layout applies the stored (or system) choice before first paint, so this component
 * only ever needs to handle *changes*, not the initial flash.
 */

export const THEME_STORAGE_KEY = 'yard-theme'
type Mode = 'light' | 'dark' | 'auto'

function isMode(value: string | null): value is Mode {
  return value === 'light' || value === 'dark' || value === 'auto'
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(mode: Mode) {
  const resolved = mode === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  document.documentElement.setAttribute('data-theme', resolved)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Private browsing or a full storage quota — the toggle still works for this
    // load, it just will not be remembered next time.
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('auto')
  // Until this flips true, the toggle shows nothing pressed — reading localStorage
  // during the server render is impossible, so guessing here would either mismatch
  // the client's real preference or fight the pre-paint script's own read of it.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      // Ignored — falls through to the 'auto' default.
    }
    setMode(isMode(stored) ? stored : 'auto')
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    apply(mode)
    if (mode !== 'auto') return
    // Auto keeps following the OS live, not just at the moment it was selected.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('auto')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode, mounted])

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-ink-300 bg-ink-100 p-1 dark:border-ink-600 dark:bg-ink-800"
    >
      {(['light', 'dark', 'auto'] as const).map((option) => {
        const pressed = mounted && mode === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={pressed}
            onClick={() => setMode(option)}
            className={clsx(
              'min-h-9 min-w-11 rounded-full px-3 text-xs font-semibold capitalize transition',
              pressed
                ? 'bg-gold text-ink-900'
                : 'text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-50',
            )}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}
