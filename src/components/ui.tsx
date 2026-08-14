import clsx from 'clsx'
import type { ReactNode } from 'react'

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-ink-200 bg-white p-6 shadow-sm dark:border-ink-700 dark:bg-ink-800',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink-700 dark:text-ink-200">
      {children}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-ink-400 focus:border-turf-500 focus:ring-2 focus:ring-turf-500/20 dark:border-ink-600 dark:bg-ink-900'

// min-h-11 (44px) on all three: referees and coaches use these standing in a
// parking lot on a phone, and py-2 alone lands under both Apple's and Material's
// tap-target guidance.
export const buttonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-turf-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-turf-700 focus:outline-none focus:ring-2 focus:ring-turf-500/40 disabled:cursor-not-allowed disabled:opacity-60'

export const secondaryButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 transition hover:bg-ink-100 disabled:opacity-60 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700'

export const dangerButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/40'

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={clsx('rounded-lg border px-3 py-2 text-sm', {
        'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200':
          kind === 'error',
        'border-turf-500/40 bg-turf-500/10 text-turf-700 dark:text-turf-500': kind === 'success',
        'border-ink-300 bg-ink-100 text-ink-700 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-200':
          kind === 'info',
      })}
    >
      {children}
    </div>
  )
}

export function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={clsx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', {
        'bg-turf-500/15 text-turf-700 dark:text-turf-500': role === 'owner',
        'bg-blue-500/15 text-blue-700 dark:text-blue-300': role === 'admin',
        'bg-violet-500/15 text-violet-700 dark:text-violet-300': role === 'scheduler',
        'bg-amber-500/15 text-amber-700 dark:text-amber-300': role === 'coach',
        'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300': role === 'referee',
        'bg-ink-500/15 text-ink-600 dark:text-ink-300': role === 'viewer',
      })}
    >
      {role}
    </span>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-ink-300 px-4 py-6 text-center text-sm text-ink-500 dark:border-ink-600 dark:text-ink-300">
      {children}
    </p>
  )
}
