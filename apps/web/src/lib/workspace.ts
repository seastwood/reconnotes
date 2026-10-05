import { useEffect, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { getFolders, getNotes, getSettings, listFolders, listNotes, type FolderData, type NoteData, type SortMode } from '@reconnotes/core'
import { sync } from './sync'

/** Snapshot of the workspace for rendering; recomputed on every change. */
export interface WorkspaceSnapshot {
  folders: FolderData[]
  notes: NoteData[]
  rootSort: SortMode
  loaded: boolean
}

let snapshot: WorkspaceSnapshot = { folders: [], notes: [], rootSort: 'manual', loaded: false }
const listeners = new Set<() => void>()
const doc = sync.workspace.doc

function recompute() {
  snapshot = {
    folders: listFolders(doc),
    notes: listNotes(doc),
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
