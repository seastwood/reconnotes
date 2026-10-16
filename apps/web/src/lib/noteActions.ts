import * as Y from 'yjs'
import { emptyTrash, getContent, getFolders, getNotes, listFolders, noteDocName, readNote, moveNote, restoreFolder, trashFolder, updateNote } from '@reconnotes/core'
import { workspaceDoc } from './workspace'
import { sync } from './sync'
import { showToast } from './toast'

/**
 * Things done to one or several notes from the list (buttons, swipes,
 * multi-select, drag and drop). Each says what happened, with Undo.
 */

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`)

function snapshot(ids: string[], keys: ('folderId' | 'order' | 'trashedAt' | 'pinned')[]) {
  const notes = getNotes(workspaceDoc)
  return ids.flatMap((id) => {
    const m = notes.get(id)
    if (!m) return []
    const n = readNote(m)
    return [{ id, before: Object.fromEntries(keys.map((k) => [k, n[k]])) }]
  })
}

function restore(saved: ReturnType<typeof snapshot>) {
  workspaceDoc.transact(() => {
    for (const s of saved) updateNote(workspaceDoc, s.id, s.before)
  })
}

export function trashNotes(ids: string[]) {
  if (!ids.length) return
  const saved = snapshot(ids, ['trashedAt'])
  const now = Date.now()
  workspaceDoc.transact(() => ids.forEach((id) => updateNote(workspaceDoc, id, { trashedAt: now })))
  showToast(`${plural(ids.length, 'note')} moved to Recently Deleted`, () => restore(saved))
}

/** A folder (its subfolders and notes too) to Recently Deleted – with Undo. */
export function trashFolderUndoable(id: string) {
  const name = listFolders(workspaceDoc).find((f) => f.id === id)?.name
  trashFolder(workspaceDoc, id)
  showToast(`${name ? `“${name}”` : 'Folder'} moved to Recently Deleted`, () => restoreFolder(workspaceDoc, id))
}

/** Notes' and folders' entries, as they are (to put back after a permanent delete). */
function entries(kind: 'notes' | 'folders', ids: string[]) {
  const map = kind === 'notes' ? getNotes(workspaceDoc) : getFolders(workspaceDoc)
  return ids.flatMap((id) => {
    const m = map.get(id)
    return m ? [{ id, data: m.toJSON() as Record<string, unknown> }] : []
  })
}
function putBack(kind: 'notes' | 'folders', saved: ReturnType<typeof entries>) {
  const map = kind === 'notes' ? getNotes(workspaceDoc) : getFolders(workspaceDoc)
  workspaceDoc.transact(() => {
    for (const { id, data } of saved) {
      if (map.has(id)) continue
      const m = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(data)) m.set(k, v)
      map.set(id, m as never)
    }
  })
}

/**
 * Delete notes for good (from Recently Deleted) – with Undo for a little while: their contents are
 * still on the server, so putting their entries back brings them back whole.
 */
export function deleteNotesForever(ids: string[]) {
  const saved = entries('notes', ids)
  const map = getNotes(workspaceDoc)
  workspaceDoc.transact(() => ids.forEach((id) => map.delete(id)))
  showToast(`${plural(saved.length, 'note')} deleted`, () => putBack('notes', saved), 8000)
}

/** Empty Recently Deleted – with Undo for a little while. */
export function emptyTrashUndoable() {
  const notes: string[] = []
  const folders: string[] = []
  getNotes(workspaceDoc).forEach((m, id) => void (m.get('trashedAt') && notes.push(id)))
  getFolders(workspaceDoc).forEach((m, id) => void (m.get('trashedAt') && folders.push(id)))
  const saved = { notes: entries('notes', notes), folders: entries('folders', folders) }
  emptyTrash(workspaceDoc)
  showToast(`Recently Deleted emptied`, () => (putBack('folders', saved.folders), putBack('notes', saved.notes)), 8000)
}

export function restoreNotes(ids: string[]) {
  const saved = snapshot(ids, ['trashedAt'])
  workspaceDoc.transact(() => ids.forEach((id) => updateNote(workspaceDoc, id, { trashedAt: null })))
  showToast(`${plural(ids.length, 'note')} restored`, () => restore(saved))
}

export function moveNotes(ids: string[], folderId: string | null) {
  const saved = snapshot(ids, ['folderId', 'order'])
  if (saved.every((s) => (s.before.folderId ?? null) === folderId)) return
  workspaceDoc.transact(() => [...ids].reverse().forEach((id) => moveNote(workspaceDoc, id, folderId)))
  const name = folderId ? listFolders(workspaceDoc).find((f) => f.id === folderId)?.name : null
  showToast(`${plural(ids.length, 'note')} moved to ${name ? `“${name}”` : 'No folder'}`, () => restore(saved))
}

export function pinNotes(ids: string[], pinned: boolean) {
  const saved = snapshot(ids, ['pinned'])
  workspaceDoc.transact(() => ids.forEach((id) => updateNote(workspaceDoc, id, { pinned })))
  showToast(`${plural(ids.length, 'note')} ${pinned ? 'pinned' : 'unpinned'}`, () => restore(saved), 3500)
}

/** Add a #tag to notes (as text at the end of each note, where tags live). */
export async function tagNotes(ids: string[], tag: string) {
  const clean = tag.trim().replace(/^#+/, '').replace(/\s+/g, '-')
  if (!clean) return
  for (const id of ids) {
    const meta = getNotes(workspaceDoc).get(id)
    if (meta && readNote(meta).tags.includes(clean.toLowerCase())) continue
    const { handle, close } = sync.open(noteDocName(id))
    try {
      await handle.loaded
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(`#${clean}`)])
      const content = getContent(handle.doc)
      content.insert(content.length, [p])
      if (meta) updateNote(workspaceDoc, id, { tags: [...readNote(meta).tags, clean.toLowerCase()] })
    } finally {
      close()
    }
  }
  showToast(`Tagged ${plural(ids.length, 'note')} #${clean}`)
}
