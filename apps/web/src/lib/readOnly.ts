import { useMemo } from 'react'
import { folderRules, noteReadOnly, updateFolder, updateNote } from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from './workspace'
import { getNotes, listFolders, readNote } from '@reconnotes/core'
import { showToast } from './toast'

/**
 * Read-only notes and folders
 * ===========================
 *
 * A note you don't want to change by accident – or every note in a folder (and its subfolders) –
 * opens read only: no editing toolbar, no keyboard, nothing typed, ticked or drawn in it. The ⋯ menu
 * still has everything that leaves it as it is, and "Make editable" (for a note in a read-only
 * folder: just that note, the folder staying read only).
 */
export interface ReadOnlyState {
  readOnly: boolean
  /** set on the note itself, or on a folder it's in */
  by: 'note' | 'folder' | null
  /** the read-only folder it's in (if any), and its name */
  folderId: string | null
  folderName: string
  /** set on the note itself to read only (true), to editable in a read-only folder (false), or neither */
  own: boolean | null
}

export function useNoteReadOnly(noteId: string): ReadOnlyState {
  const ws = useWorkspace()
  return useMemo(() => {
    const note = ws.allNotes.find((n) => n.id === noteId)
    const rules = folderRules(ws.folders)
    const r = note ? noteReadOnly(note, rules) : { readOnly: false, by: null, folderId: null }
    const folderName = r.folderId ? (ws.folders.find((f) => f.id === r.folderId)?.name ?? 'Folder') : ''
    return { ...r, folderName, own: note?.readOnly ?? null }
  }, [ws.allNotes, ws.folders, noteId])
}

/** Read only, or editable again. In a read-only folder, "editable" is for this note only. */
export function setNoteReadOnly(noteId: string, state: ReadOnlyState, readOnly: boolean) {
  // back to as its folder is, when that's what's wanted; otherwise set on the note
  const value = state.folderId ? (readOnly ? null : false) : readOnly ? true : null
  updateNote(workspaceDoc, noteId, { readOnly: value })
  showToast(readOnly ? 'Read only – nothing in it can be changed by accident' : state.folderId ? `Editable – just this note (“${state.folderName}” stays read only)` : 'Editable again')
}

export function setFolderReadOnly(folderId: string, readOnly: boolean) {
  updateFolder(workspaceDoc, folderId, { readOnly })
  showToast(readOnly ? 'Read only – its notes (and its subfolders’) can’t be changed by accident' : 'Its notes can be edited again')
}

/**
 * Is this note read only now? (For ticking a to-do from the Tasks or Due lists – which would change
 * the note.) Says so when it is.
 */
export function refuseIfReadOnly(noteId: string): boolean {
  const m = getNotes(workspaceDoc).get(noteId)
  if (!m) return false
  const note = readNote(m)
  if (!noteReadOnly(note, folderRules(listFolders(workspaceDoc))).readOnly) return false
  showToast(`“${note.title || 'This note'}” is read only – open it and make it editable (⋯) to tick this`)
  return true
}
