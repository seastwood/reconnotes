import { useMemo } from 'react'
import { effectiveFolderId, folderRules, getFolders, readFolder, updateFolder, type FolderData, type FolderLock, type NoteData } from '@reconnotes/core'
import { useStore } from './store'
import { unlockedFolders as unlocked, useWorkspace, workspaceDoc } from './workspace'

/**
 * Password-protected folders
 * ==========================
 *
 * A folder can have a password: its notes (and its subfolders') are hidden
 * everywhere – lists, search, tags, Due, "Ask your notes" – until it's
 * unlocked on this device. It locks again when the app has been in the
 * background for a minute, or with "Lock now".
 *
 * This is a privacy lock, not encryption: the password is kept only as a
 * salted hash (synced, so it's the same on every device), but the notes
 * themselves are stored and synced as usual, so your server can still
 * search them and its AI read them when you ask from an unlocked device.
 */

const ITERATIONS = 210_000
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256))
}

export async function makeLock(password: string): Promise<FolderLock> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { salt: hex(salt.buffer), hash: await derive(password, salt, ITERATIONS), iter: ITERATIONS }
}

export async function checkPassword(lock: FolderLock, password: string): Promise<boolean> {
  return (await derive(password, unhex(lock.salt), lock.iter)) === lock.hash
}

export const useUnlocked = () => useStore(unlocked, (s) => s.ids)
export const isUnlocked = (folderId: string) => unlocked.get().ids.has(folderId)
export function lockAll() {
  if (unlocked.get().ids.size) unlocked.set({ ids: new Set() })
}
export function lockFolder(folderId: string) {
  const ids = new Set(unlocked.get().ids)
  ids.delete(folderId)
  unlocked.set({ ids })
}

const folder = (id: string): FolderData | null => {
  const m = getFolders(workspaceDoc).get(id)
  return m ? readFolder(m) : null
}

/** Try a password; true (and unlocked) if it's right. */
export async function unlockFolder(folderId: string, password: string): Promise<boolean> {
  const f = folder(folderId)
  if (!f?.lock) return true
  if (!(await checkPassword(f.lock, password))) return false
  unlocked.set({ ids: new Set([...unlocked.get().ids, folderId]) })
  return true
}

export async function setFolderPassword(folderId: string, password: string) {
  updateFolder(workspaceDoc, folderId, { lock: await makeLock(password) })
  unlocked.set({ ids: new Set([...unlocked.get().ids, folderId]) })
}

export async function removeFolderPassword(folderId: string, password: string): Promise<boolean> {
  const f = folder(folderId)
  if (f?.lock && !(await checkPassword(f.lock, password))) return false
  updateFolder(workspaceDoc, folderId, { lock: null })
  lockFolder(folderId)
  return true
}

// lock again after a minute in the background
let hiddenAt = 0
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now()
    else if (hiddenAt && Date.now() - hiddenAt > 60_000) lockAll()
  })

/**
 * What's hidden right now: the locked folders (not unlocked here), and the
 * notes inside them; plus the folders left out of search.
 */
export function useFolderAccess() {
  const ws = useWorkspace()
  const ids = useUnlocked()
  return useMemo(() => {
    const rules = folderRules(ws.folders)
    const live = new Set(ws.folders.filter((f) => !f.trashedAt).map((f) => f.id))
    const lockedFolder = (folderId: string | null | undefined) => {
      const by = folderId ? rules.get(folderId)?.lockedBy : null
      return Boolean(by && !ids.has(by))
    }
    const noteFolder = (n: NoteData) => effectiveFolderId(n, live)
    return {
      rules,
      /** this folder is locked (by itself or a folder it's in) and not unlocked here */
      lockedFolder,
      /** the folder whose password opens this one */
      lockOwner: (folderId: string) => rules.get(folderId)?.lockedBy ?? null,
      /** this note is in a locked folder */
      noteHidden: (n: NoteData) => lockedFolder(noteFolder(n)),
      /** left out of search (unless that folder is searched on purpose) */
      noteNoSearch: (n: NoteData) => {
        const f = noteFolder(n)
        return Boolean(f && rules.get(f)?.noSearch)
      },
      /** unlocked folders that have a lock: the server may search these */
      unlockedIds: [...ids],
    }
  }, [ws.folders, ids])
}
