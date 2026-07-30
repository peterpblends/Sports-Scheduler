'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { RequestError, api } from '@/lib/client'
import { Alert, Card, buttonClass, inputClass, secondaryButtonClass } from './ui'

/**
 * Roster CSV import with preview-and-fix.
 *
 * The file is never trusted or parsed here — it goes to the server, which validates it
 * and sends back every problem it found. The operator edits the text in place, presses
 * Check again, and only once the file is clean does Import become available.
 *
 * Validating client-side as well would drift from the server's rules and give people a
 * green light the API then refuses. One validator, on the side that owns the data.
 */

type ImportError = { line: number; column: string; message: string }

type PlanEntry = {
  line: number
  name: string
  role: string
  jersey: string | null
  personId: string | null
  action: 'create_person_and_add' | 'add_existing_person' | 'update_membership'
}

type Preview = {
  committed: boolean
  columns: string[]
  unknownColumns: string[]
  summary: { rows: number; created: number; added: number; updated: number }
  plan: PlanEntry[]
  errors: ImportError[]
}

const ACTION_LABELS: Record<PlanEntry['action'], string> = {
  create_person_and_add: 'new person',
  add_existing_person: 'existing person, added to team',
  update_membership: 'already on team, will update',
}

const TEMPLATE = `name,email,phone,role,jersey,dob,notes
Ada Okonkwo,ada@example.com,555-0100,player,7,2013-04-02,
Ben Alvarez,ben@example.com,,player,9,2013-11-18,keeper
Chris Nwosu,chris@example.com,,coach,,,`

export function RosterImport({
  orgId,
  teamId,
  teamName,
}: {
  orgId: string
  teamId: string
  teamName: string
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const clean = preview !== null && preview.errors.length === 0 && preview.summary.rows > 0

  async function send(commit: boolean) {
    if (csv.trim() === '') {
      setError('Paste a CSV or choose a file first.')
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const data = await api<Preview>(`/api/orgs/${orgId}/teams/${teamId}/import`, {
        method: 'POST',
        body: { csv, commit },
      })
      setPreview(data)
      if (data.committed) {
        setDone(
          `Imported ${data.summary.rows} row${data.summary.rows === 1 ? '' : 's'} into ${teamName}: ` +
            `${data.summary.created} new ${data.summary.created === 1 ? 'person' : 'people'}, ` +
            `${data.summary.added} added, ${data.summary.updated} updated.`,
        )
        setCsv('')
        setPreview(null)
        router.refresh()
      }
    } catch (err) {
      // 422 is a refused commit and still carries the full report, which is the useful
      // part — show it rather than a bare message.
      if (err instanceof RequestError && err.status === 422 && err.details) {
        setPreview(err.details as Preview)
        setError('That file still has problems, so nothing was imported.')
      } else if (err instanceof RequestError && err.status === 422) {
        setPreview(null)
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Could not read that file.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function onFile(file: File) {
    setCsv(await file.text())
    setPreview(null)
    setDone(null)
    setError(null)
  }

  const errorsByLine = new Map<number, ImportError[]>()
  for (const entry of preview?.errors ?? []) {
    const bucket = errorsByLine.get(entry.line)
    if (bucket) bucket.push(entry)
    else errorsByLine.set(entry.line, [entry])
  }
  const fileLevel = errorsByLine.get(0) ?? []

  return (
    <Card>
      <h2 className="text-base font-semibold">Import a roster</h2>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        A <code className="text-xs">name</code> column is required. Optional:{' '}
        <code className="text-xs">email</code>, <code className="text-xs">phone</code>,{' '}
        <code className="text-xs">role</code>, <code className="text-xs">jersey</code>,{' '}
        <code className="text-xs">dob</code>, <code className="text-xs">notes</code>. Rows are
        matched to existing people by email, then by name.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void onFile(file)
          }}
        />
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => fileInput.current?.click()}
        >
          Choose a CSV file
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => {
            setCsv(TEMPLATE)
            setPreview(null)
            setDone(null)
          }}
        >
          Use the example
        </button>
      </div>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-medium">CSV</span>
        <textarea
          className={clsx(inputClass, 'h-40 font-mono text-xs')}
          value={csv}
          onChange={(event) => {
            setCsv(event.target.value)
            setPreview(null)
            setDone(null)
          }}
          placeholder="name,email,role,jersey&#10;Ada Okonkwo,ada@example.com,player,7"
          spellCheck={false}
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void send(false)}>
          {busy ? 'Checking…' : 'Check the file'}
        </button>
        <button type="button" className={buttonClass} disabled={busy || !clean} onClick={() => void send(true)}>
          {clean ? `Import ${preview!.summary.rows} rows` : 'Import'}
        </button>
      </div>
      {!clean && preview === null && (
        <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
          Check the file first — nothing is written until it passes.
        </p>
      )}

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {done && (
        <div className="mt-4">
          <Alert kind="success">{done}</Alert>
        </div>
      )}

      {preview && (
        <div className="mt-5 border-t border-ink-200 pt-4 dark:border-ink-700">
          {fileLevel.length > 0 ? (
            <Alert>
              {fileLevel.map((entry) => (
                <div key={entry.message}>{entry.message}</div>
              ))}
            </Alert>
          ) : preview.errors.length === 0 ? (
            <Alert kind="success">
              {preview.summary.rows} row{preview.summary.rows === 1 ? '' : 's'} look good —{' '}
              {preview.summary.created} new {preview.summary.created === 1 ? 'person' : 'people'},{' '}
              {preview.summary.added} to add, {preview.summary.updated} to update.
            </Alert>
          ) : (
            <Alert>
              {preview.errors.length} problem{preview.errors.length === 1 ? '' : 's'} across{' '}
              {errorsByLine.size} line{errorsByLine.size === 1 ? '' : 's'}. Fix them above and check
              again.
            </Alert>
          )}

          {preview.unknownColumns.length > 0 && (
            <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
              Ignored columns: {preview.unknownColumns.join(', ')}.
            </p>
          )}

          {preview.plan.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-ink-500 dark:text-ink-400">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Line</th>
                    <th className="pb-2 pr-3 font-medium">Name</th>
                    <th className="pb-2 pr-3 font-medium">Role</th>
                    <th className="pb-2 pr-3 font-medium">Jersey</th>
                    <th className="pb-2 font-medium">What will happen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-200 dark:divide-ink-700">
                  {preview.plan.map((entry) => {
                    const rowErrors = errorsByLine.get(entry.line) ?? []
                    return (
                      <tr
                        key={entry.line}
                        className={rowErrors.length > 0 ? 'bg-red-500/5' : undefined}
                      >
                        <td className="py-2 pr-3 tabular-nums text-xs text-ink-500 dark:text-ink-400">
                          {entry.line}
                        </td>
                        <td className="py-2 pr-3">
                          {entry.name || <span className="text-red-700 dark:text-red-300">—</span>}
                          {rowErrors.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-xs text-red-700 dark:text-red-300">
                              {rowErrors.map((rowError, index) => (
                                <li key={index}>
                                  <span className="font-mono">{rowError.column}</span>:{' '}
                                  {rowError.message}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs">{entry.role}</td>
                        <td className="py-2 pr-3 text-xs tabular-nums">{entry.jersey ?? '—'}</td>
                        <td className="py-2 text-xs text-ink-600 dark:text-ink-300">
                          {ACTION_LABELS[entry.action]}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
