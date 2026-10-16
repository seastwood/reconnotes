import * as Y from 'yjs'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { createNote, getContent, getNotes, noteDocName, readNote, updateNote } from '@reconnotes/core'
import { addAttachment } from './attachments'
import { sync } from './sync'
import { onWorkspaceChange, type WorkspaceSnapshot } from './workspace'
import { onRecentNotes, recentNoteIds } from './recentNotes'
import { isMarkdownFile, noteFromMarkdown } from './markdownNotes'

/**
 * Things shared to ReconNotes (iOS share sheet, or "Open in / Copy to
 * ReconNotes" from other apps) wait in a native inbox; when the app opens
 * each share becomes a new note: links, text, pictures, recordings, files –
 * or goes at the end of the note picked in the share sheet (it offers your
 * pinned and recent notes, kept up to date here with setTargets).
 */

interface ShareItem {
  kind: 'url' | 'text' | 'file'
  url?: string
  text?: string
  name?: string
  mime?: string
  file?: string
}
interface Share {
  id: string
  createdAt: number
  title?: string
  items: ShareItem[]
  dir: string
  /** a note picked in the share sheet: added to its end (else a new note) */
  target?: string
}
interface ShareInboxPlugin {
  take(): Promise<{ shares: Share[] }>
  remove(options: { ids: string[] }): Promise<void>
  setTargets(options: { notes: { id: string; title: string }[] }): Promise<void>
}
const ShareInbox = registerPlugin<ShareInboxPlugin>('ShareInbox')

function paragraph(text: string, link?: string) {
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text, link ? { link: { href: link, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } } : undefined)
  p.insert(0, [t])
  return p
}

function titleFor(share: Share): string {
  if (share.title) return share.title.split('\n')[0].slice(0, 120)
  const url = share.items.find((i) => i.kind === 'url')?.url
  if (url) {
    try {
      return `Link from ${new URL(url).hostname.replace(/^www\./, '')}`
    } catch {
      /* not a URL */
    }
  }
  const text = share.items.find((i) => i.kind === 'text')?.text
  if (text) return text.split('\n')[0].slice(0, 80)
  const files = share.items.filter((i) => i.kind === 'file')
  if (files.length === 1) return files[0].name?.replace(/\.[^.]+$/, '') || 'Shared file'
  return `Shared ${new Date(share.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** A shared file as an attachment block (picture, recording or file). */
async function fileBlock(share: Share, item: ShareItem): Promise<Y.XmlElement> {
  const res = await fetch(Capacitor.convertFileSrc(`${share.dir}/${item.file}`))
  const blob = await res.blob()
  const mime = item.mime || blob.type || 'application/octet-stream'
  const name = item.name || item.file!
  const id = await addAttachment(new File([blob], name, { type: mime }), name)
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file'
  const el = new Y.XmlElement(kind)
  el.setAttribute('attachmentId', id)
  if (kind === 'image') el.setAttribute('alt', name.replace(/\.[^.]+$/, ''))
  else el.setAttribute('name', name)
  if (kind === 'file') el.setAttribute('mime', mime)
  return el
}

/** Add a share to the end of a note (picked in the share sheet). False: that note isn't there any more. */
async function appendTo(noteId: string, share: Share): Promise<boolean> {
  const meta = getNotes(sync.workspace.doc).get(noteId)
  if (!meta || readNote(meta).trashedAt) return false
  const blocks: Y.XmlElement[] = []
  const url = share.items.find((i) => i.kind === 'url')?.url
  for (const item of share.items) {
    // a link: its page's title as the link's words, when it came with one
    if (item.kind === 'url' && item.url) blocks.push(paragraph(share.title && item.url === url ? share.title.split('\n')[0] : item.url, item.url))
    else if (item.kind === 'text' && item.text) for (const line of item.text.split('\n')) blocks.push(paragraph(line))
    else if (item.kind === 'file' && item.file) blocks.push(await fileBlock(share, item))
  }
  if (!url && share.title && !share.items.some((i) => i.kind === 'text' && i.text?.includes(share.title!.trim()))) blocks.unshift(paragraph(share.title))
  if (!blocks.length) return true
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    await handle.loaded
    const content = getContent(handle.doc)
    // after a blank line, unless the note ends with one
    const last = content.length ? content.get(content.length - 1) : null
    const endsBlank = last instanceof Y.XmlElement && last.nodeName === 'paragraph' && !last.toString().replace(/<[^>]+>/g, '').trim()
    content.insert(content.length, endsBlank ? blocks : [new Y.XmlElement('paragraph'), ...blocks])
  } finally {
    close()
  }
  updateNote(sync.workspace.doc, noteId, { updatedAt: Date.now() })
  return true
}

async function toNote(share: Share): Promise<string> {
  if (share.target && (await appendTo(share.target, share))) return share.target
  // Markdown files (shared, or opened from the Files app) become notes of their own
  const files = share.items.filter((i) => i.kind === 'file' && i.file)
  if (files.length && files.length === share.items.length && files.every((f) => isMarkdownFile(f.name ?? f.file!, f.mime))) {
    let last = ''
    for (const f of files) {
      const res = await fetch(Capacitor.convertFileSrc(`${share.dir}/${f.file}`))
      last = await noteFromMarkdown(await res.text(), f.name ?? f.file!, null)
    }
    return last
  }
  // text shared from a Markdown app (Obsidian, Bear…): formatted, not line by line
  const only = share.items.length === 1 && share.items[0].kind === 'text' ? share.items[0].text ?? '' : ''
  if (/^(#{1,6} |\s*[-*+] |\s*\d+[.)] |\s*> )/m.test(only)) {
    const name = (share.title || only.split('\n').find((l) => l.trim()) || 'Shared').replace(/^#+\s*/, '').slice(0, 120)
    return noteFromMarkdown(only, name + '.md', null)
  }
  const title = titleFor(share)
  const blocks: Y.XmlElement[] = [paragraph(title)]
  for (const item of share.items) {
    if (item.kind === 'url' && item.url) blocks.push(paragraph(item.url, item.url))
    else if (item.kind === 'text' && item.text && item.text.trim() !== title) for (const line of item.text.split('\n')) blocks.push(paragraph(line))
    else if (item.kind === 'file' && item.file) blocks.push(await fileBlock(share, item))
  }
  blocks.push(new Y.XmlElement('paragraph'))
  const id = createNote(sync.workspace.doc, { title })
  const { handle, close } = sync.open(noteDocName(id))
  try {
    await handle.loaded
    getContent(handle.doc).insert(0, blocks)
  } finally {
    close()
  }
  return id
}

let running = false

/** Turn waiting shares into notes; opens the last one. */
async function check(openNote: (id: string) => void) {
  if (running) return
  running = true
  try {
    const { shares } = await ShareInbox.take()
    if (!shares.length) return
    let last: string | null = null
    for (const share of shares.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        last = await toNote(share)
        await ShareInbox.remove({ ids: [share.id] })
      } catch (err) {
        console.warn('could not import a shared item', err)
      }
    }
    if (last) openNote(last)
  } finally {
    running = false
  }
}

/**
 * The notes the share sheet offers to add to: pinned ones, then the ones opened last (never ones in
 * a locked folder – their titles would show outside the app).
 */
function keepTargets() {
  let last = ''
  let ws: WorkspaceSnapshot | null = null
  const update = () => {
    const now = ws
    if (!now) return
    const live = new Map(now.notes.filter((n) => !n.trashedAt && !n.template && !n.file && !now.lockedNoteIds.has(n.id)).map((n) => [n.id, n]))
    const ids = [...[...live.values()].filter((n) => n.pinned).map((n) => n.id), ...recentNoteIds().filter((id) => live.has(id))]
    const notes = [...new Set(ids)].slice(0, 8).map((id) => ({ id, title: live.get(id)!.title || 'Untitled' }))
    const sig = JSON.stringify(notes)
    if (sig === last) return
    last = sig
    void ShareInbox.setTargets({ notes }).catch(() => {})
  }
  onWorkspaceChange((s) => {
    ws = s
    update()
  })
  onRecentNotes(update)
}

export function startShareInbox(openNote: (id: string) => void) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('ShareInbox')) return
  keepTargets()
  const run = () => void check(openNote)
  void sync.workspace.loaded.then(run)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && run())
  window.addEventListener('reconnotes:share-inbox', run)
}
