import fs from 'node:fs'
import path from 'node:path'
import {
  WORKSPACE_DOC,
  buildTree,
  extractNote,
  getStrokes,
  listFolders,
  listNotes,
  noteDocName,
  noteToMarkdown,
  type TreeNode,
} from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { renderDrawingPng } from './ai'
import { safeName } from './backup'
import { writeZip } from './zip'

/**
 * Export everything
 * =================
 *
 * One zip with every note as a Markdown file in its folders, plus the
 * pictures, recordings and files they contain (`_files/`) and each drawing as
 * a picture (`_drawings/`), linked from the notes. Opens in any Markdown app
 * (Obsidian, Bear, iA Writer, VS Code…) and imports back into ReconNotes.
 */
export function exportZip(store: Store, sync: SyncEngine): { zip: Buffer; notes: number } {
  sync.hocuspocus.flushPendingStores()
  const ws = sync.getDoc(WORKSPACE_DOC)
  const files: { name: string; data: Buffer; modified?: Date }[] = []
  if (!ws) return { zip: writeZip(files), notes: 0 }
  const ROOT = 'ReconNotes'
  const folderPath = new Map<string, string>()
  const walk = (nodes: TreeNode[], base: string) => {
    for (const n of nodes) {
      const p = `${base}/${safeName(n.folder.name)}`
      folderPath.set(n.folder.id, p)
      walk(n.children, p)
    }
  }
  walk(buildTree(listFolders(ws).filter((f) => !f.trashedAt)), ROOT)

  const added = new Set<string>()
  const addFile = (name: string, data: () => Buffer | null) => {
    if (added.has(name)) return
    const d = data()
    if (!d) return
    added.add(name)
    files.push({ name, data: d })
  }
  const used = new Set<string>()
  let notes = 0
  for (const note of listNotes(ws)) {
    if (note.trashedAt) continue
    const doc = sync.getDoc(noteDocName(note.id))
    if (!doc) continue
    const dir = note.template ? `${ROOT}/Templates` : (note.folderId && folderPath.get(note.folderId)) || ROOT
    const up = path.posix.relative(dir, ROOT) || '.'
    const title = safeName(note.title || extractNote(doc).title || 'Untitled')
    let file = `${dir}/${title}.md`
    for (let i = 2; used.has(file.toLowerCase()); i++) file = `${dir}/${title} (${i}).md`
    used.add(file.toLowerCase())

    const md = noteToMarkdown(doc, {
      attachmentUrl: (id) => {
        const att = store.getAttachment(id)
        const name = `_files/${id.slice(0, 8)}-${safeName(att?.name || id)}${att?.name || !att ? '' : extFor(att.mime)}`
        addFile(`${ROOT}/${name}`, () => (store.hasBlob(id) ? fs.readFileSync(store.blobPath(id)) : null))
        return encodeURI(`${up}/${name}`)
      },
      drawingPlaceholder: (id) => {
        const name = `_drawings/${id}.png`
        let ok = false
        addFile(`${ROOT}/${name}`, () => {
          const png = renderDrawingPng(getStrokes(doc, id).toArray())
          ok = Boolean(png)
          return png
        })
        return ok || added.has(`${ROOT}/${name}`) ? `![Drawing](${encodeURI(`${up}/${name}`)})` : ''
      },
    })
    files.push({ name: file, data: Buffer.from(md), modified: new Date(note.updatedAt || Date.now()) })
    notes++
  }
  return { zip: writeZip(files), notes }
}

function extFor(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/webm': '.webm',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
  }
  return map[mime] ?? ''
}
