import * as Y from 'yjs'
import { createNote, getNotes, noteDocName, readNote, updateNote } from '@reconnotes/core'
import { sync } from './sync'

/**
 * Templates
 * =========
 *
 * A template is an ordinary note marked `template` – edited like any note,
 * listed under Templates. A new note from a template gets a full copy of it
 * (text, drawings, pictures), with {{date}} and {{time}} filled in.
 */

/** Wait until a note's content is on this device (downloading it if needed). */
async function loadNoteDoc(noteId: string) {
  const opened = sync.open(noteDocName(noteId))
  await opened.handle.loaded
  const start = Date.now()
  while (!opened.handle.doc.share.size && !opened.handle.synced && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 150))
  return opened
}

/** Copy one note's content into another (empty) note. */
async function copyContent(fromId: string, toId: string, fill: boolean) {
  const from = await loadNoteDoc(fromId)
  const to = sync.open(noteDocName(toId))
  try {
    await to.handle.loaded
    Y.applyUpdate(to.handle.doc, Y.encodeStateAsUpdate(from.handle.doc))
    if (fill) fillPlaceholders(to.handle.doc)
  } finally {
    from.close()
    to.close()
  }
}

/** {{date}}, {{time}} and {{weekday}} → today's values. */
export function fillPlaceholders(doc: Y.Doc) {
  const now = new Date()
  const values: Record<string, string> = {
    date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    time: now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
  }
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      for (;;) {
        const text = node.toString().replace(/<[^>]+>/g, '') // toString() includes formatting tags
        const plain = node.toDelta().map((d: { insert: unknown }) => (typeof d.insert === 'string' ? d.insert : '￼')).join('')
        const m = /\{\{\s*(date|time|weekday)\s*\}\}/i.exec(plain)
        if (!m || !text) break
        node.delete(m.index, m[0].length)
        node.insert(m.index, values[m[1].toLowerCase()])
      }
      return
    }
    node.toArray().forEach((c) => walk(c as Y.XmlElement | Y.XmlText))
  }
  doc.transact(() => walk(doc.getXmlFragment('content')))
}

/** A new note from a template; returns its id. */
export async function newNoteFromTemplate(templateId: string, folderId: string | null): Promise<string> {
  const ws = sync.workspace.doc
  const meta = getNotes(ws).get(templateId)
  const t = meta ? readNote(meta) : null
  const id = createNote(ws, { folderId, title: t?.title ?? '' })
  await copyContent(templateId, id, true)
  return id
}

/** Save a copy of a note as a template; returns the template's id. */
export async function saveAsTemplate(noteId: string): Promise<string> {
  const ws = sync.workspace.doc
  const meta = getNotes(ws).get(noteId)
  const n = meta ? readNote(meta) : null
  const id = createNote(ws, { folderId: null, title: n?.title ?? 'Template' })
  updateNote(ws, id, { template: true })
  await copyContent(noteId, id, false)
  return id
}
