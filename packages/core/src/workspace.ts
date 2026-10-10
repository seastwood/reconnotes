import * as Y from 'yjs'
import { generateKeyBetween } from 'fractional-indexing'
import {
  type FolderData,
  type NoteData,
  type SortMode,
  getFolders,
  getNotes,
  readFolder,
  readNote,
} from './schema'
import { newId } from './ids'

/**
 * Mutations on the workspace document (folder tree + note list).
 *
 * All functions run inside a single Yjs transaction so a mutation is applied
 * (and synced) atomically.
 */

export interface TreeNode {
  folder: FolderData
  children: TreeNode[]
}

export function compareByOrder(a: { order: string; id: string }, b: { order: string; id: string }) {
  // Two devices can independently produce the same key for the same slot;
  // the id is a deterministic tie-breaker so every device shows the same order.
  if (a.order < b.order) return -1
  if (a.order > b.order) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function sortFolders(folders: FolderData[], mode: SortMode): FolderData[] {
  const out = [...folders]
  switch (mode) {
    case 'title':
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    case 'created':
      return out.sort((a, b) => b.createdAt - a.createdAt)
    case 'updated': // folders have no updated time; fall back to newest first
      return out.sort((a, b) => b.createdAt - a.createdAt)
    default:
      return out.sort(compareByOrder)
  }
}

export function sortNotes(notes: NoteData[], mode: SortMode): NoteData[] {
  const out = [...notes]
  const pinnedFirst = (a: NoteData, b: NoteData) => Number(b.pinned) - Number(a.pinned)
  switch (mode) {
    case 'title':
      return out.sort(
        (a, b) =>
          pinnedFirst(a, b) ||
          (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, { numeric: true, sensitivity: 'base' }),
      )
    case 'created':
      return out.sort((a, b) => pinnedFirst(a, b) || b.createdAt - a.createdAt)
    case 'manual':
      return out.sort((a, b) => pinnedFirst(a, b) || compareByOrder(a, b))
    default:
      return out.sort((a, b) => pinnedFirst(a, b) || b.updatedAt - a.updatedAt)
  }
}

/**
 * Build the visible folder tree.
 *
 * Because devices can make conflicting changes offline (device A moves folder
 * X into Y while device B moves Y into X), the flat parent pointers can form a
 * cycle or point at a folder that was deleted. We never drop such folders:
 * anything whose parent chain is broken or cyclic is shown at the top level,
 * so nothing ever becomes unreachable.
 */
export function buildTree(folders: FolderData[], rootSort: SortMode = 'manual'): TreeNode[] {
  const live = folders.filter((f) => !f.trashedAt)
  const byId = new Map(live.map((f) => [f.id, f]))

  const effectiveParent = new Map<string, string | null>()
  for (const f of live) {
    effectiveParent.set(f.id, resolveParent(f, byId))
  }

  const childrenOf = new Map<string | null, FolderData[]>()
  for (const f of live) {
    const p = effectiveParent.get(f.id) ?? null
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p)!.push(f)
  }

  const build = (parentId: string | null, mode: SortMode): TreeNode[] =>
    sortFolders(childrenOf.get(parentId) ?? [], mode).map((folder) => ({
      folder,
      children: build(folder.id, folder.sort),
    }))

  return build(null, rootSort)
}

function resolveParent(f: FolderData, byId: Map<string, FolderData>): string | null {
  if (!f.parentId || !byId.has(f.parentId)) return null
  // Walk up; if we come back to f, there is a cycle -> treat f as top level
  // only if it is the "smallest" id in the cycle, so exactly one folder of the
  // cycle is promoted and the rest keep their structure.
  const seen = new Set<string>([f.id])
  let cur: FolderData | undefined = byId.get(f.parentId)
  const cycle: string[] = [f.id]
  while (cur) {
    if (seen.has(cur.id)) {
      if (cur.id !== f.id) return f.parentId // f is above a cycle, not in it
      const min = cycle.slice().sort()[0]
      return min === f.id ? null : f.parentId
    }
    seen.add(cur.id)
    cycle.push(cur.id)
    if (!cur.parentId || !byId.has(cur.parentId)) return f.parentId
    cur = byId.get(cur.parentId)
  }
  return f.parentId
}

/** Ids of a folder and all its (live) descendants. */
export function descendantFolderIds(folders: FolderData[], folderId: string): Set<string> {
  const out = new Set<string>([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id)
        changed = true
      }
    }
  }
  return out
}

/**
 * Folders a note should be considered "in" for display. A note whose folder
 * was deleted on another device (while it was being created here) is shown at
 * the top level instead of disappearing.
 */
export function effectiveFolderId(note: NoteData, liveFolderIds: Set<string>): string | null {
  return note.folderId && liveFolderIds.has(note.folderId) ? note.folderId : null
}

/** Order key that puts an item after every sibling. */
export function orderAtEnd(siblings: { order: string; id: string }[]): string {
  const sorted = [...siblings].sort(compareByOrder)
  const last = sorted[sorted.length - 1]
  return generateKeyBetween(last ? last.order : null, null)
}

/** Order key that puts an item before every sibling. */
export function orderAtStart(siblings: { order: string; id: string }[]): string {
  const sorted = [...siblings].sort(compareByOrder)
  const first = sorted[0]
  return generateKeyBetween(null, first ? first.order : null)
}

/**
 * Order key to place an item at `index` among `siblings` (which must not
 * include the item itself).
 */
export function orderAtIndex(siblings: { order: string; id: string }[], index: number): string {
  const sorted = [...siblings].sort(compareByOrder)
  const before = sorted[index - 1]
  const after = sorted[index]
  let a = before ? before.order : null
  let b = after ? after.order : null
  if (a !== null && b !== null && a >= b) {
    // Siblings share a key (concurrent inserts); just go after `before`.
    b = null
    const next = sorted.slice(index).find((s) => s.order > a!)
    if (next) b = next.order
  }
  return generateKeyBetween(a, b)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function createFolder(
  doc: Y.Doc,
  opts: { name: string; parentId?: string | null; id?: string },
): string {
  const id = opts.id ?? newId()
  doc.transact(() => {
    const folders = getFolders(doc)
    const siblings: FolderData[] = []
    folders.forEach((m) => {
      const f = readFolder(m)
      if (!f.trashedAt && (f.parentId ?? null) === (opts.parentId ?? null)) siblings.push(f)
    })
    const m = new Y.Map<unknown>()
    m.set('id', id)
    m.set('name', opts.name)
    m.set('parentId', opts.parentId ?? null)
    m.set('order', orderAtEnd(siblings))
    m.set('createdAt', Date.now())
    m.set('sort', 'manual')
    m.set('trashedAt', null)
    folders.set(id, m)
  })
  return id
}

export function updateFolder(doc: Y.Doc, id: string, patch: Partial<Omit<FolderData, 'id'>>) {
  const m = getFolders(doc).get(id)
  if (!m) return
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) m.set(k, v)
  })
}

/**
 * Move a folder under a new parent at the given position. Refuses moves that
 * would put a folder inside itself.
 */
export function moveFolder(doc: Y.Doc, id: string, parentId: string | null, index?: number): boolean {
  const all: FolderData[] = []
  getFolders(doc).forEach((m) => all.push(readFolder(m)))
  if (parentId && descendantFolderIds(all, id).has(parentId)) return false
  const siblings = all.filter((f) => !f.trashedAt && f.id !== id && (f.parentId ?? null) === parentId)
  const order = index === undefined ? orderAtEnd(siblings) : orderAtIndex(siblings, index)
  updateFolder(doc, id, { parentId, order })
  return true
}

/** Move a folder, its subfolders and all notes in them to the trash. */
export function trashFolder(doc: Y.Doc, id: string) {
  const all: FolderData[] = []
  getFolders(doc).forEach((m) => all.push(readFolder(m)))
  const ids = descendantFolderIds(all, id)
  const now = Date.now()
  doc.transact(() => {
    for (const fid of ids) {
      const m = getFolders(doc).get(fid)
      if (m && !m.get('trashedAt')) m.set('trashedAt', now)
    }
    getNotes(doc).forEach((m) => {
      if (ids.has(m.get('folderId') as string) && !m.get('trashedAt')) m.set('trashedAt', now)
    })
  })
}

export function restoreFolder(doc: Y.Doc, id: string) {
  const m = getFolders(doc).get(id)
  if (!m) return
  const trashedAt = m.get('trashedAt')
  const all: FolderData[] = []
  getFolders(doc).forEach((f) => all.push(readFolder(f)))
  const ids = descendantFolderIds(all, id)
  doc.transact(() => {
    for (const fid of ids) {
      const f = getFolders(doc).get(fid)
      if (f && f.get('trashedAt') === trashedAt) f.set('trashedAt', null)
    }
    getNotes(doc).forEach((n) => {
      if (ids.has(n.get('folderId') as string) && n.get('trashedAt') === trashedAt) n.set('trashedAt', null)
    })
  })
}

export function createNote(doc: Y.Doc, opts: { folderId?: string | null; id?: string; title?: string } = {}): string {
  const id = opts.id ?? newId()
  const now = Date.now()
  doc.transact(() => {
    const notes = getNotes(doc)
    const siblings: NoteData[] = []
    notes.forEach((m) => {
      const n = readNote(m)
      if ((n.folderId ?? null) === (opts.folderId ?? null)) siblings.push(n)
    })
    const m = new Y.Map<unknown>()
    m.set('id', id)
    m.set('title', opts.title ?? '')
    m.set('snippet', '')
    m.set('folderId', opts.folderId ?? null)
    m.set('order', orderAtStart(siblings))
    m.set('createdAt', now)
    m.set('updatedAt', now)
    m.set('pinned', false)
    m.set('trashedAt', null)
    notes.set(id, m)
  })
  return id
}

export function updateNote(doc: Y.Doc, id: string, patch: Partial<Omit<NoteData, 'id'>>) {
  const m = getNotes(doc).get(id)
  if (!m) return
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (m.get(k) !== v) m.set(k, v)
    }
  })
}

export function moveNote(doc: Y.Doc, id: string, folderId: string | null, index?: number) {
  const siblings: NoteData[] = []
  getNotes(doc).forEach((m) => {
    const n = readNote(m)
    if (n.id !== id && !n.trashedAt && (n.folderId ?? null) === folderId) siblings.push(n)
  })
  const order = index === undefined ? orderAtStart(siblings) : orderAtIndex(siblings, index)
  updateNote(doc, id, { folderId, order })
}

/** Permanently remove a trashed note's metadata. Its content doc is purged by the server. */
export function deleteNoteForever(doc: Y.Doc, id: string) {
  getNotes(doc).delete(id)
}

export function emptyTrash(doc: Y.Doc): string[] {
  const removedNotes: string[] = []
  doc.transact(() => {
    const notes = getNotes(doc)
    notes.forEach((m, id) => {
      if (m.get('trashedAt')) {
        notes.delete(id)
        removedNotes.push(id)
      }
    })
    const folders = getFolders(doc)
    folders.forEach((m, id) => {
      if (m.get('trashedAt')) folders.delete(id)
    })
  })
  return removedNotes
}

export interface FolderRule {
  /** the folder whose password guards this one (itself or a folder it's in), or null */
  lockedBy: string | null
  /** left out of search: set on it or a folder it's in */
  noSearch: boolean
  /** read only: set on it or a folder it's in – the folder it's set on (or null) */
  readOnlyBy: string | null
}

/** Locks and "leave out of search" apply to subfolders too. */
export function folderRules(folders: FolderData[]): Map<string, FolderRule> {
  const byId = new Map(folders.filter((f) => !f.trashedAt).map((f) => [f.id, f]))
  const out = new Map<string, FolderRule>()
  for (const f of byId.values()) {
    let lockedBy: string | null = null
    let noSearch = false
    let readOnlyBy: string | null = null
    const seen = new Set<string>()
    for (let cur: FolderData | undefined = f; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      seen.add(cur.id)
      // the outermost lock wins: one password opens everything inside it
      if (cur.lock) lockedBy = cur.id
      if (cur.noSearch) noSearch = true
      if (cur.readOnly && !readOnlyBy) readOnlyBy = cur.id
    }
    out.set(f.id, { lockedBy, noSearch, readOnlyBy })
  }
  return out
}

/** Each live folder's path from the top: ['Coding', 'Projects', 'ReconNotes']. */
export function folderPaths(folders: FolderData[]): Map<string, string[]> {
  const byId = new Map(folders.filter((f) => !f.trashedAt).map((f) => [f.id, f]))
  const out = new Map<string, string[]>()
  for (const f of byId.values()) {
    const path: string[] = []
    const seen = new Set<string>()
    for (let cur: FolderData | undefined = f; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      seen.add(cur.id)
      path.unshift(cur.name)
    }
    out.set(f.id, path)
  }
  return out
}

/**
 * Folders a search or question names: a folder whose whole name appears in
 * it ("FRC", "To Do"), with their subfolders. Returns the folder ids and the
 * text left once the folder names are taken out.
 */
export function foldersNamedIn(query: string, folders: FolderData[]): { ids: Set<string>; rest: string } {
  const live = folders.filter((f) => !f.trashedAt && f.name.trim().length >= 2)
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  let q = norm(query)
  const named: string[] = []
  // longest names first, so "To Do" wins over a folder called "Do"
  for (const f of [...live].sort((a, b) => b.name.length - a.name.length)) {
    const n = norm(f.name)
    if (n.trim().length < 2 || !q.includes(n)) continue
    // generic words aren't folder references on their own
    if (/^ (new folder|notes?|untitled folder|folder) $/.test(n)) continue
    named.push(f.id)
    q = q.replace(n, ' ')
  }
  const ids = new Set(named)
  let grew = true
  while (grew && ids.size) {
    grew = false
    for (const f of live) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
  }
  return { ids, rest: q.replace(/\s+/g, ' ').trim() }
}

/**
 * The group a note belongs to: its top-level folder ('' outside any folder). Meetings in one group
 * don't learn from another's – the voices named, the people suggested, the words fixed in a work
 * folder stay out of a robotics folder.
 */
export function noteGroup(ws: Y.Doc, noteId: string): string {
  const m = getNotes(ws).get(noteId)
  if (!m) return ''
  const folders = getFolders(ws)
  let id = readNote(m).folderId
  let top = ''
  const seen = new Set<string>()
  while (id && folders.has(id) && !seen.has(id)) {
    seen.add(id)
    top = id
    id = readFolder(folders.get(id)!).parentId
  }
  return top
}

/**
 * Is a note read only (so it isn't edited by accident)? Set on the note itself, or on its folder or
 * a folder that's in – unless the note is set to be editable anyway. `by`: where it comes from.
 */
export function noteReadOnly(note: Pick<NoteData, 'readOnly' | 'folderId'>, rules: Map<string, FolderRule>): { readOnly: boolean; by: 'note' | 'folder' | null; folderId: string | null } {
  const folder = note.folderId ? (rules.get(note.folderId)?.readOnlyBy ?? null) : null
  if (note.readOnly === true) return { readOnly: true, by: 'note', folderId: folder }
  if (note.readOnly === false) return { readOnly: false, by: folder ? 'note' : null, folderId: folder }
  return { readOnly: Boolean(folder), by: folder ? 'folder' : null, folderId: folder }
}
