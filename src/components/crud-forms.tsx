'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'
import { Alert, Label, buttonClass, dangerButtonClass, inputClass } from './ui'

export type FieldSpec = {
  name: string
  label: string
  type?: 'text' | 'email' | 'tel' | 'date' | 'time' | 'color' | 'number' | 'select' | 'textarea'
  options?: { value: string; label: string }[]
  required?: boolean
  placeholder?: string
  defaultValue?: string
  /** Sent as a number rather than a string. */
  numeric?: boolean
  help?: string
}

/**
 * Turns a FormData into a JSON body: blanks become null (so a cleared optional
 * field is explicitly cleared rather than silently skipped), and numeric fields
 * are coerced.
 */
function toBody(form: FormData, fields: FieldSpec[], fixed: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...fixed }
  for (const field of fields) {
    const raw = form.get(field.name)
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') {
      if (field.required) return { error: `${field.label} is required.` }
      body[field.name] = null
      continue
    }
    body[field.name] = field.numeric ? Number(value) : value
  }
  return { body }
}

/**
 * Inline create/edit form. Sends to `endpoint`, then refreshes the server
 * components so the page reflects the write. Pass `method: 'PATCH'` to edit an
 * existing row rather than create one.
 */
export function CreateForm({
  endpoint,
  fields,
  fixed = {},
  submitLabel = 'Add',
  onCreated,
  layout = 'inline',
  method = 'POST',
}: {
  endpoint: string
  fields: FieldSpec[]
  fixed?: Record<string, unknown>
  submitLabel?: string
  onCreated?: (created: unknown) => void
  layout?: 'inline' | 'stacked'
  method?: 'POST' | 'PATCH'
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formEl = event.currentTarget
    setError(null)

    const result = toBody(new FormData(formEl), fields, fixed)
    if ('error' in result) {
      setError(result.error!)
      return
    }

    setBusy(true)
    try {
      const created = await api(endpoint, { method, body: result.body })
      // An edit keeps its values on screen; a create clears the form for the next one.
      if (method === 'POST') formEl.reset()
      onCreated?.(created)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className={layout === 'inline' ? 'flex flex-wrap items-end gap-3' : 'space-y-4'}
    >
      {error && (
        <div className="w-full">
          <Alert>{error}</Alert>
        </div>
      )}
      {fields.map((field) => (
        <div key={field.name} className={layout === 'inline' ? 'min-w-40 flex-1' : ''}>
          <Label htmlFor={`${endpoint}-${field.name}`}>{field.label}</Label>
          {field.type === 'select' ? (
            <select
              id={`${endpoint}-${field.name}`}
              name={field.name}
              defaultValue={field.defaultValue}
              className={inputClass}
            >
              {!field.required && <option value="">—</option>}
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : field.type === 'textarea' ? (
            <textarea
              id={`${endpoint}-${field.name}`}
              name={field.name}
              rows={3}
              placeholder={field.placeholder}
              defaultValue={field.defaultValue}
              className={inputClass}
            />
          ) : (
            <input
              id={`${endpoint}-${field.name}`}
              name={field.name}
              type={field.type ?? 'text'}
              placeholder={field.placeholder}
              defaultValue={field.defaultValue}
              className={inputClass}
            />
          )}
          {field.help && (
            <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">{field.help}</p>
          )}
        </div>
      ))}
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}

/**
 * Soft-delete button. The server never hard-deletes, so the label says "Remove"
 * rather than "Delete" — the row and its history stay.
 */
export function RemoveButton({
  endpoint,
  label = 'Remove',
  confirmText,
}: {
  endpoint: string
  label?: string
  confirmText?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        className={dangerButtonClass}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return
          setBusy(true)
          setError(null)
          try {
            await api(endpoint, { method: 'DELETE' })
            router.refresh()
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not remove.')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '…' : label}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-300">{error}</span>}
    </span>
  )
}

/** Inline single-field editor, used for statuses and quick renames. */
export function InlineSelect({
  endpoint,
  name,
  value,
  options,
  disabled,
}: {
  endpoint: string
  name: string
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(value)

  return (
    <span className="inline-flex flex-col gap-1">
      <select
        value={current}
        disabled={disabled}
        className={`${inputClass} w-36`}
        onChange={async (event) => {
          const next = event.target.value
          const previous = current
          setCurrent(next)
          setError(null)
          try {
            await api(endpoint, { method: 'PATCH', body: { [name]: next } })
            router.refresh()
          } catch (err) {
            setCurrent(previous)
            setError(err instanceof Error ? err.message : 'Could not update.')
          }
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-red-600 dark:text-red-300">{error}</span>}
    </span>
  )
}

/**
 * Time-slot form. Kept separate from `CreateForm` because a slot is either
 * recurring or one-off, and the two shapes need different fields.
 */
export function TimeSlotForm({ orgId, fieldId, timezone }: { orgId: string; fieldId: string; timezone: string }) {
  const router = useRouter()
  const [kind, setKind] = useState<'recurring' | 'one_off'>('recurring')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    setError(null)
    setBusy(true)
    try {
      await api(`/api/orgs/${orgId}/fields/${fieldId}/timeslots`, {
        body:
          kind === 'recurring'
            ? {
                kind,
                dayOfWeek: Number(form.get('dayOfWeek')),
                startTime: form.get('startTime'),
                endTime: form.get('endTime'),
                effectiveFrom: form.get('effectiveFrom') || null,
                effectiveTo: form.get('effectiveTo') || null,
              }
            : {
                kind,
                specificDate: form.get('specificDate'),
                startTime: form.get('startTime'),
                endTime: form.get('endTime'),
              },
      })
      formEl.reset()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-3 border-t border-ink-200 pt-3 dark:border-ink-700">
      {error && (
        <div className="w-full">
          <Alert>{error}</Alert>
        </div>
      )}
      <div>
        <Label>Kind</Label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'recurring' | 'one_off')}
          className={`${inputClass} w-32`}
        >
          <option value="recurring">Weekly</option>
          <option value="one_off">One-off</option>
        </select>
      </div>

      {kind === 'recurring' ? (
        <div>
          <Label>Day</Label>
          <select name="dayOfWeek" defaultValue="6" className={`${inputClass} w-32`}>
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
              (day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ),
            )}
          </select>
        </div>
      ) : (
        <div>
          <Label>Date</Label>
          <input name="specificDate" type="date" className={`${inputClass} w-40`} />
        </div>
      )}

      <div>
        <Label>From</Label>
        <input name="startTime" type="time" defaultValue="08:00" className={`${inputClass} w-28`} />
      </div>
      <div>
        <Label>To</Label>
        <input name="endTime" type="time" defaultValue="18:00" className={`${inputClass} w-28`} />
      </div>

      {kind === 'recurring' && (
        <>
          <div>
            <Label>Effective from</Label>
            <input name="effectiveFrom" type="date" className={`${inputClass} w-40`} />
          </div>
          <div>
            <Label>Effective to</Label>
            <input name="effectiveTo" type="date" className={`${inputClass} w-40`} />
          </div>
        </>
      )}

      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? 'Saving…' : 'Add slot'}
      </button>
      <p className="w-full text-xs text-ink-500 dark:text-ink-400">
        Times are local to {timezone}. Stored as a wall-clock rule, so 8am stays 8am across a
        daylight-saving change.
      </p>
    </form>
  )
}

/** Wraps children in a collapsible block, to keep dense setup pages scannable. */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-sm font-medium text-turf-600 hover:underline">
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}
