import { useEffect, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { effectiveFolderId, folderRules, getFolders, getNotes, getSettings, listFolders, listNotes, type FolderData, type NoteData, type SortMode } from '@reconnotes/core'
import { sync } from './sync'
import { Store } from './store'

/** folders whose password was given on this device (see folderLock.ts) */
export const unlockedFolders = new Store<{ ids: Set<string> }>({ ids: new Set() })

/** Snapshot of the workspace for rendering; recomputed on every change. */
export interface WorkspaceSnapshot {
  folders: FolderData[]
  /** the notes you can see: not those in password-protected folders that are locked */
  notes: NoteData[]
  /** how many notes locked folders hide */
  hiddenNotes: number
  /** every note, locked or not – only for things that must keep working while locked (reminders) */
  allNotes: NoteData[]
  /** notes in a password-protected folder (locked or unlocked) */
  lockedNoteIds: Set<string>
  rootSort: SortMode
  loaded: boolean
}

let snapshot: WorkspaceSnapshot = { folders: [], notes: [], hiddenNotes: 0, allNotes: [], lockedNoteIds: new Set(), rootSort: 'manual', loaded: false }
const listeners = new Set<() => void>()
const doc = sync.workspace.doc

function recompute() {
  const folders = listFolders(doc)
  const all = listNotes(doc)
  const rules = folderRules(folders)
  const live = new Set(rules.keys())
  const open = unlockedFolders.get().ids
  const notes = all.filter((n) => {
    const by = rules.get(effectiveFolderId(n, live) ?? '')?.lockedBy
    return !by || open.has(by)
  })
  snapshot = {
    folders,
    notes,
    hiddenNotes: all.length - notes.length,
    allNotes: all,
    lockedNoteIds: new Set(all.filter((n) => rules.get(effectiveFolderId(n, live) ?? '')?.lockedBy).map((n) => n.id)),
    rootSort: (getSettings(doc).get('rootSort') as SortMode) ?? 'manual',
    loaded: true,
  }
  listeners.forEach((l) => l())
}

let scheduled = false
const schedule = () => {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    recompute()
  })
}
getFolders(doc).observeDeep(schedule)
getNotes(doc).observeDeep(schedule)
getSettings(doc).observe(schedule)
unlockedFolders.subscribe(schedule)
void sync.workspace.loaded.then(recompute)

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot,
  )
}

export const workspaceDoc = doc

/** Open a note document for the lifetime of a component. */
export function useNoteDoc(noteId: string | null): { doc: Y.Doc; ready: boolean; provider: unknown } | null {
  const [state, setState] = useState<{ doc: Y.Doc; ready: boolean; provider: unknown } | null>(null)
  useEffect(() => {
    if (!noteId) {
      setState(null)
      return
    }
    const { handle, close } = sync.open(`note:${noteId}`)
    let alive = true
    setState({ doc: handle.doc, ready: false, provider: handle.provider })
    void handle.loaded.then(() => alive && setState({ doc: handle.doc, ready: true, provider: handle.provider }))
    return () => {
      alive = false
      close()
    }
  }, [noteId])
  return state
}

/** Listen for workspace changes outside React (e.g. to schedule reminders). */
export function onWorkspaceChange(fn: (s: WorkspaceSnapshot) => void): () => void {
  const l = () => fn(snapshot)
  listeners.add(l)
  if (snapshot.loaded) l()
  return () => listeners.delete(l)
}
