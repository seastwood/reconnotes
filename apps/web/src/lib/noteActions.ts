import * as Y from 'yjs'
import { getContent, getNotes, listFolders, noteDocName, readNote, moveNote, updateNote } from '@reconnotes/core'
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
