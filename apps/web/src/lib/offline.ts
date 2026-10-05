import { descendantFolderIds, extractNote, listFolders, listNotes, noteDocName } from '@reconnotes/core'
import { metaDb } from './db'
import { apiUrl, authHeaders, isSyncConfigured } from './settings'
import { Store, safeLocalGet, safeLocalSet, useStore } from './store'
import { sync, syncStatus } from './sync'
import { workspaceDoc } from './workspace'

/**
 * Keep a folder offline
 * =====================
 *
 * Every note's text and ink is always on every device. Pictures, recordings
 * and files are downloaded when first shown – unless their folder is kept
 * offline on this device: then they're all downloaded ahead of time (and
 * new ones as they arrive), so nothing says "not downloaded yet" on a plane.
 * The choice is per device.
 */

const KEY = 'reconnotes.offlineFolders'

export interface OfflineState {
  folders: string[]
  /** downloading now: what's done of how many */
  progress: { done: number; total: number } | null
}

export const offline = new Store<OfflineState>({ folders: safeLocalGet<string[]>(KEY, []), progress: null })
export const useOffline = <S,>(select: (s: OfflineState) => S) => useStore(offline, select)

export function setKeepOffline(folderId: string, keep: boolean) {
  const folders = offline.get().folders.filter((f) => f !== folderId)
  if (keep) folders.push(folderId)
  offline.set({ folders })
  safeLocalSet(KEY, folders)
  if (keep) void downloadOfflineFolders()
}

/** A folder is kept offline itself or inside one that is. */
export function isKeptOffline(folderId: string): 'self' | 'parent' | null {
  const kept = offline.get().folders
  if (kept.includes(folderId)) return 'self'
  const folders = listFolders(workspaceDoc)
  return kept.some((k) => descendantFolderIds(folders, k).has(folderId)) ? 'parent' : null
}

let running: Promise<void> | null = null

/** Download every attachment in the folders kept offline that isn't on this device yet. */
export function downloadOfflineFolders(): Promise<void> {
  if (!isSyncConfigured() || !offline.get().folders.length) return Promise.resolve()
  running ??= (async () => {
    try {
      const folders = listFolders(workspaceDoc)
      const wanted = new Set<string>()
      for (const k of offline.get().folders) for (const id of descendantFolderIds(folders, k)) wanted.add(id)
      for (const k of offline.get().folders) wanted.add(k)
      const notes = listNotes(workspaceDoc).filter((n) => !n.trashedAt && n.folderId && wanted.has(n.folderId))

      // which attachments these notes hold
      const ids = new Set<string>()
      for (const n of notes) {
        const { handle, close } = sync.open(noteDocName(n.id))
        try {
          await handle.loaded
          for (const a of extractNote(handle.doc).attachments) ids.add(a)
        } finally {
          close()
        }
      }
      const db = await metaDb()
      const missing: string[] = []
      for (const id of ids) if (!(await db.get('blobs', id))) missing.push(id)
      if (!missing.length) return
      let done = 0
      offline.set({ progress: { done, total: missing.length } })
      for (const id of missing) {
        try {
          const res = await fetch(apiUrl(`/api/attachments/${id}`), { headers: authHeaders() })
          if (res.ok) await db.put('blobs', { id, blob: await res.blob(), name: '', uploaded: true })
        } catch {
          break // offline again: carry on next time
        }
        offline.set({ progress: { done: ++done, total: missing.length } })
      }
    } finally {
      offline.set({ progress: null })
      running = null
    }
  })()
  return running
}

/** Keep the offline folders complete: when connected, and every 10 minutes. */
export function startOfflineFolders() {
  let was = syncStatus.get().state
  syncStatus.subscribe(() => {
    const now = syncStatus.get().state
    if (now === 'online' && was !== 'online') setTimeout(() => void downloadOfflineFolders(), 3000)
    was = now
  })
  setInterval(() => void downloadOfflineFolders(), 10 * 60_000)
  setTimeout(() => void downloadOfflineFolders(), 5000)
}
