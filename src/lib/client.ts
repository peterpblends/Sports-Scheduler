'use client'

export type ApiError = { error: string; details?: unknown }

/**
 * Error carrying the server's `details` payload.
 *
 * The conflict list a refused placement comes back with is the whole point of the
 * drag-and-drop flow — the UI has to name which hard constraint broke — so it must
 * survive the throw rather than being flattened into a message.
 */
export class RequestError extends Error {
  readonly status: number
  readonly details: unknown

  constructor(message: string, status: number, details: unknown) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.details = details
  }
}

/** Thin fetch wrapper: same-origin JSON, cookies included, errors surfaced as messages. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  })

  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null

  if (!res.ok) {
    const payload = data as ApiError | null
    throw new RequestError(
      payload?.error ?? `Request failed (${res.status}).`,
      res.status,
      payload?.details ?? null,
    )
  }
  return data as T
}
