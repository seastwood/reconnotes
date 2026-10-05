import { apiUrl, authHeaders, isSyncConfigured } from './settings'

/** Call the ReconNotes server's JSON API; throws with the server's message. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!isSyncConfigured()) throw new Error('Connect a ReconNotes server in Settings first.')
  const res = await fetch(apiUrl(path), {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Server error ${res.status}`)
  return json as T
}
