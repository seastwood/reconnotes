import * as Y from 'yjs'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { createNote, getContent, noteDocName } from '@reconnotes/core'
import { addAttachment } from './attachments'
import { sync } from './sync'

/**
 * Things shared to ReconNotes (iOS share sheet, or "Open in / Copy to
 * ReconNotes" from other apps) wait in a native inbox; when the app opens
 * each share becomes a new note: links, text, pictures, recordings, files.
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
}
interface ShareInboxPlugin {
  take(): Promise<{ shares: Share[] }>
  remove(options: { ids: string[] }): Promise<void>
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

async function toNote(share: Share): Promise<string> {
  // Markdown files (shared, or opened from the Files app) become notes of their own
  const files = share.items.filter((i) => i.kind === 'file' && i.file)
  const { isMarkdownFile, noteFromMarkdown } = await import('./markdownNotes')
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
    else if (item.kind === 'file' && item.file) {
      const res = await fetch(Capacitor.convertFileSrc(`${share.dir}/${item.file}`))
      const blob = await res.blob()
      const mime = item.mime || blob.type || 'application/octet-stream'
      const name = item.name || item.file
      const id = await addAttachment(new File([blob], name, { type: mime }), name)
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file'
      const el = new Y.XmlElement(kind)
      el.setAttribute('attachmentId', id)
      if (kind === 'image') el.setAttribute('alt', name.replace(/\.[^.]+$/, ''))
      else el.setAttribute('name', name)
      if (kind === 'file') el.setAttribute('mime', mime)
      blocks.push(el)
    }
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

export function startShareInbox(openNote: (id: string) => void) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('ShareInbox')) return
  const run = () => void check(openNote)
  void sync.workspace.loaded.then(run)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && run())
  window.addEventListener('reconnotes:share-inbox', run)
}
