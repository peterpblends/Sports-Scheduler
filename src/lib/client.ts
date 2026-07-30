'use client'

export type ApiError = { error: string; details?: unknown }

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
    throw new Error(payload?.error ?? `Request failed (${res.status}).`)
  }
  return data as T
}
