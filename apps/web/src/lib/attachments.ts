import { newId } from '@reconnotes/core'
import { metaDb } from './db'
import { apiUrl, authHeaders, isSyncConfigured } from './settings'

/**
 * Attachments (images, audio, files) are stored in IndexedDB first so they
 * work offline, then uploaded to the server in the background. Other devices
 * download them on demand and cache them locally.
 */

const urlCache = new Map<string, string>()

export async function addAttachment(file: Blob, name = ''): Promise<string> {
  const id = newId()
  const db = await metaDb()
  await db.put('blobs', { id, blob: file, name, uploaded: false })
  void flushUploads()
  return id
}

let flushing: Promise<void> | null = null
/** asked to upload while a round was already going: another round after it (a file added since) */
let again = false

/** Upload what hasn't been: resolves once everything added before the call is on the server (or it couldn't be). */
export function flushUploads(): Promise<void> {
  if (!isSyncConfigured()) return Promise.resolve()
  if (flushing) {
    again = true
    return flushing
  }
  flushing = (async () => {
    try {
      do {
        again = false
        if (!(await uploadPending())) break
      } while (again)
    } finally {
      flushing = null
    }
  })()
  return flushing
}

/** One round: every file not uploaded yet. false: stopped (offline, or the server said no) – retried on reconnect. */
async function uploadPending(): Promise<boolean> {
  try {
    const db = await metaDb()
    for (const rec of await db.getAll('blobs')) {
      if (rec.uploaded) continue
      const res = await fetch(apiUrl(`/api/attachments/${rec.id}`), {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'Content-Type': rec.blob.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(rec.name),
        },
        body: rec.blob,
      })
      if (!res.ok) return false
      await db.put('blobs', { ...rec, uploaded: true })
    }
    return true
  } catch {
    return false
  }
}

/** The attachment's file, from this device or downloaded from the server. */
export async function attachmentBlob(id: string): Promise<Blob | null> {
  const db = await metaDb()
  const rec = await db.get('blobs', id)
  if (rec) return rec.blob
  if (!isSyncConfigured()) return null
  try {
    const res = await fetch(apiUrl(`/api/attachments/${id}`), { headers: authHeaders() })
    return res.ok ? await res.blob() : null
  } catch {
    return null
  }
}

/** Get a displayable URL for an attachment, fetching and caching it if needed. */
export async function attachmentUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const db = await metaDb()
  let rec = await db.get('blobs', id)
  if (!rec && isSyncConfigured()) {
    try {
      const res = await fetch(apiUrl(`/api/attachments/${id}`), { headers: authHeaders() })
      if (res.ok) {
        rec = { id, blob: await res.blob(), name: '', uploaded: true }
        await db.put('blobs', rec)
      }
    } catch {
      /* offline */
    }
  }
  if (!rec) return null
  const url = URL.createObjectURL(rec.blob)
  urlCache.set(id, url)
  return url
}
