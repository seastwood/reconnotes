import path from 'node:path'
import * as Y from 'yjs'
import { marked, type Token, type Tokens } from 'marked'
import {
  WORKSPACE_DOC,
  createFolder,
  createNote,
  extractNote,
  getContent,
  getFolders,
  newId,
  noteDocName,
  readFolder,
  updateNote,
} from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import { initialTextStatus, queueAttachment } from './attachments'
import { readZip } from './zip'

/**
 * Import notes
 * ============
 *
 * Markdown files (one, several, or a zip of folders – an export from
 * ReconNotes, Obsidian, Bear, Notion…) become notes in the same folders.
 * Pictures and files they link to come along as attachments, [[links]]
 * between them become note links, and other files in a zip become file
 * notes, just like adding files to a folder in the app.
 */

export interface ImportFile {
  /** path inside the zip, or just the file name */
  path: string
  data: Buffer
}

const MD = /\.(md|markdown|mdown|txt)$/i
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}
const mimeOf = (name: string) => MIME[/\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** The files in an upload: a zip's contents, or the file itself. */
export function unpack(name: string, data: Buffer): ImportFile[] {
  if (/\.zip$/i.test(name) || (data.length > 4 && data.readUInt32LE(0) === 0x04034b50 && !MD.test(name))) {
    return readZip(data)
      .filter((e) => !e.name.endsWith('/') && !/(^|\/)(__MACOSX|\.[^/]+)(\/|$)/.test(e.name))
      .map((e) => ({ path: e.name, data: e.data() }))
  }
  return [{ path: path.posix.basename(name.replace(/\\/g, '/')) || 'Imported.md', data }]
}

export async function importNotes(
  config: Config,
  store: Store,
  ai: Ai,
  sync: SyncEngine,
  input: ImportFile[],
  targetFolderId: string | null,
): Promise<{ notes: number; files: number; noteIds: string[] }> {
  let files = input.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\/+/, '') }))
  // one folder around everything (like "ReconNotes/" or "My Vault/"): drop it
  const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')))
  if (tops.size === 1 && !tops.has('')) {
    const top = [...tops][0] + '/'
    files = files.map((f) => ({ ...f, path: f.path.slice(top.length) }))
  }
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]))
  const notesIn = files.filter((f) => MD.test(f.path) && !f.path.startsWith('Templates/'))
  const templatesIn = files.filter((f) => MD.test(f.path) && f.path.startsWith('Templates/'))

  // 1. folders and note ids (so [[links]] can point at notes made later)
  const ids = new Map<string, string>() // md path → note id
  const titles = new Map<string, string>() // lower-case title → note id
  for (const f of [...notesIn, ...templatesIn]) {
    const id = newId()
    ids.set(f.path, id)
    titles.set(baseTitle(f.path).toLowerCase(), id)
  }
  const folderIds = new Map<string, string | null>([['', targetFolderId]])
  await sync.change(WORKSPACE_DOC, (ws) => {
    const folderFor = (dir: string): string | null => {
      if (folderIds.has(dir)) return folderIds.get(dir)!
      const parent = folderFor(path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir))
      const name = path.posix.basename(dir)
      let id: string | null = null
      getFolders(ws).forEach((m) => {
        const f = readFolder(m)
        if (!id && !f.trashedAt && f.parentId === parent && f.name.toLowerCase() === name.toLowerCase()) id = f.id
      })
      id ??= createFolder(ws, { name, parentId: parent })
      folderIds.set(dir, id)
      return id
    }
    for (const f of notesIn) {
      const dir = path.posix.dirname(f.path)
      createNote(ws, { id: ids.get(f.path)!, folderId: folderFor(dir === '.' ? '' : dir), title: baseTitle(f.path) })
    }
    for (const f of templatesIn) {
      createNote(ws, { id: ids.get(f.path)!, folderId: null, title: baseTitle(f.path) })
      updateNote(ws, ids.get(f.path)!, { template: true })
    }
  })

  // 2. attachments, stored once each
  const attached = new Map<string, { id: string; name: string; mime: string; size: number }>()
  const attach = (p: string) => {
    const key = p.toLowerCase()
    if (attached.has(key)) return attached.get(key)!
    const f = byPath.get(key)
    if (!f) return null
    const name = path.posix.basename(f.path).replace(/^[a-z0-9]{8}-/, '') // our export's id prefix
    const mime = mimeOf(name)
    const a = { id: newId(), name, mime, size: f.data.length }
    store.putAttachment({ id: a.id, mime, name, size: f.data.length, created_at: Date.now() }, f.data, initialTextStatus(config, ai, mime, name))
    queueAttachment(config, store, ai, sync, a.id)
    attached.set(key, a)
    return a
  }

  // 3. each note's content
  for (const f of [...notesIn, ...templatesIn]) {
    const id = ids.get(f.path)!
    const dir = path.posix.dirname(f.path)
    const resolve = (href: string): string | null => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null
      let p = href.split('#')[0].split('?')[0]
      try {
        p = decodeURI(p)
      } catch {
        /* keep as is */
      }
      return path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, p)).replace(/^(\.\.\/)+/, '')
    }
    const ctx: Ctx = {
      attach: (href) => {
        const p = resolve(href)
        return p && !MD.test(p) ? attach(p) : null
      },
      noteFor: (target) => {
        const p = resolve(target)
        if (p && MD.test(p) && ids.has(p)) return ids.get(p)!
        return titles.get(target.replace(/\.md$/i, '').toLowerCase()) ?? null
      },
    }
    let md = f.data.toString('utf8').replace(/^﻿/, '').replace(/^---\n[\s\S]*?\n---\n/, '') // front matter
    if (/\.txt$/i.test(f.path)) md = md.replace(/([*_`#>\[\]\\])/g, '\\$1')
    await sync.change(noteDocName(id), (doc) => {
      const nodes = markdownToNodes(md, ctx)
      // the first line is a note's title: keep the file name if the text doesn't start with it
      const first = nodes[0] ? plain(nodes[0]).trim() : ''
      const title = baseTitle(f.path)
      if (first.toLowerCase() !== title.toLowerCase() && !/^untitled/i.test(title)) nodes.unshift(para([text(title)]))
      if (nodes.length) getContent(doc).insert(0, nodes)
    })
    const doc = sync.getDoc(noteDocName(id))
    if (doc) {
      const ex = extractNote(doc)
      await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, id, { title: ex.title, snippet: ex.snippet, tags: ex.tags, links: ex.links }))
    }
  }

  // 4. other files (not linked from a note): file notes, like adding files to a folder
  const linked = new Set(attached.keys())
  let fileNotes = 0
  for (const f of files) {
    if (MD.test(f.path) || linked.has(f.path.toLowerCase()) || /^_(files|drawings)\//.test(f.path)) continue
    const a = attach(f.path)
    if (!a) continue
    const id = newId()
    const dir = path.posix.dirname(f.path)
    await sync.change(WORKSPACE_DOC, (ws) => {
      createNote(ws, { id, folderId: folderIds.get(dir === '.' ? '' : dir) ?? targetFolderId, title: a.name })
      updateNote(ws, id, { file: { name: a.name, mime: a.mime, size: a.size } })
    })
    await sync.change(noteDocName(id), (doc) => {
      getContent(doc).insert(0, [para([text(a.name)]), fileNode(a), para([])])
    })
    fileNotes++
  }
  sync.reindexAll()
  return { notes: notesIn.length + templatesIn.length, files: attached.size, noteIds: [...ids.values()] }
}

const baseTitle = (p: string) => path.posix.basename(p).replace(MD, '').trim() || 'Untitled'

// --- Markdown → the note's rich text (the editor's node names) -------------

export interface Ctx {
  attach(href: string): { id: string; name: string; mime: string; size: number } | null
  noteFor(target: string): string | null
  /** a paragraph that is only this text becomes this block instead (e.g. ⟦AUDIO:id⟧) */
  blockFor?(text: string): Y.XmlElement | null
  /** "!2026-10-14" → a due date's attributes */
  dueFor?(date: string): Record<string, unknown> | null
  /** a link to a note that points at a place in it ("G206"): the text to find there */
  findFor?(target: string): string | null
}

type Inline = Y.XmlText | Y.XmlElement
type Marks = Record<string, object>

const pendingChildren = new WeakMap<Y.XmlElement, (Y.XmlElement | Y.XmlText)[]>()
function el(name: string, attrs: Record<string, unknown>, children: (Y.XmlElement | Y.XmlText)[] = []): Y.XmlElement {
  const e = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string)
  if (children.length) e.insert(0, children)
  pendingChildren.set(e, children)
  return e
}
const para = (children: Inline[]) => el('paragraph', {}, children)
/** The text of runs not yet in a document (Yjs can't read them back until then). */
const runText = new WeakMap<Y.XmlText, string>()
function text(t: string, marks: Marks = {}): Y.XmlText {
  const x = new Y.XmlText()
  runText.set(x, t)
  x.insert(0, t, Object.keys(marks).length ? marks : undefined)
  return x
}
function fileNode(a: { id: string; name: string; mime: string; size: number }): Y.XmlElement {
  if (a.mime.startsWith('image/')) return el('image', { attachmentId: a.id, alt: a.name.replace(/\.[^.]+$/, '') })
  if (a.mime.startsWith('audio/')) return el('audio', { attachmentId: a.id, name: a.name })
  return el('file', { attachmentId: a.id, name: a.name, mime: a.mime, size: a.size })
}
function plain(n: Y.XmlElement | Y.XmlText): string {
  if (n instanceof Y.XmlText) return runText.get(n) ?? ''
  return [...pendingChildren.get(n) ?? []].map((c) => plain(c)).join('')
}

/** Inline tokens → runs of text (with bold/italic/… marks), note links and pictures. */
function inlines(tokens: Token[] | undefined, ctx: Ctx, marks: Marks = {}): (Inline | { block: Y.XmlElement })[] {
  const out: (Inline | { block: Y.XmlElement })[] = []
  const push = (t: string, m: Marks = marks) => {
    // [[Note title]] / [[Note|label]] links between notes
    // and !due dates, when the caller knows them
    let last = 0
    for (const match of t.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]|!(\d{4}-\d{2}-\d{2}[^\s.,;:)]*)|⸢([^⸣\n]{1,60})⸣/g)) {
      let node: Y.XmlElement | Y.XmlText | null = null
      if (match[4] !== undefined) {
        // a word the AI guessed: shown with a dotted underline in the note
        node = text(match[4], { ...m, uncertain: {} })
      } else if (match[3] !== undefined) {
        const attrs = ctx.dueFor?.(match[3])
        if (attrs) node = el('dueDate', { ...attrs, id: newId() })
      } else {
        const id = ctx.noteFor(match[1].trim())
        // [[Note|its own words]]: the words kept as the link's label
        if (id) node = el('noteLink', { noteId: id, title: match[1].trim(), ...(match[2] && match[2].trim() !== match[1].trim() ? { label: match[2].trim() } : {}) })
      }
      if (!node) continue
      if (match.index! > last) out.push(text(t.slice(last, match.index), m))
      out.push(node as Inline)
      last = match.index! + match[0].length
    }
    if (last < t.length) out.push(text(t.slice(last), m))
  }
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'text':
      case 'escape':
        if ('tokens' in tok && tok.tokens?.length) out.push(...inlines(tok.tokens, ctx, marks))
        else push(decode((tok as Tokens.Text).text))
        break
      case 'strong':
        out.push(...inlines((tok as Tokens.Strong).tokens, ctx, { ...marks, bold: {} }))
        break
      case 'em':
        out.push(...inlines((tok as Tokens.Em).tokens, ctx, { ...marks, italic: {} }))
        break
      case 'del':
        out.push(...inlines((tok as Tokens.Del).tokens, ctx, { ...marks, strike: {} }))
        break
      case 'codespan':
        out.push(text(decode((tok as Tokens.Codespan).text), { ...marks, code: {} }))
        break
      case 'br':
        out.push(el('hardBreak', {}))
        break
      case 'link': {
        const l = tok as Tokens.Link
        const att = ctx.attach(l.href)
        const note = att ? null : /^[a-z][a-z0-9+.-]*:/i.test(l.href) ? null : ctx.noteFor(l.href)
        if (att) out.push({ block: fileNode(att) })
        else if (note) {
          // the link's own words stay (not replaced by the note's title), and where it points
          const find = ctx.findFor?.(l.href)
          out.push(el('noteLink', { noteId: note, title: l.text, label: l.text, ...(find ? { find } : {}) }))
        }
        else out.push(...inlines(l.tokens, ctx, { ...marks, link: { href: l.href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }))
        break
      }
      case 'image': {
        const i = tok as Tokens.Image
        const att = ctx.attach(i.href)
        if (att) out.push({ block: att.mime.startsWith('image/') ? el('image', { attachmentId: att.id, alt: i.text }) : fileNode(att) })
        else if (i.href) out.push(text(i.text || i.href, { ...marks, link: { href: i.href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }))
        break
      }
      case 'html':
        push((tok as Tokens.HTML).text.replace(/<[^>]+>/g, ''))
        break
      default:
        if ('text' in tok && typeof tok.text === 'string') push(decode(tok.text))
    }
  }
  return out
}

/** Paragraph content; pictures and files inside it become blocks of their own. */
function paragraphs(tokens: Token[] | undefined, ctx: Ctx): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  let run: Inline[] = []
  const flush = () => {
    const only = ctx.blockFor && run.every((n) => n instanceof Y.XmlText) ? ctx.blockFor(run.map((n) => runText.get(n as Y.XmlText) ?? '').join('').trim()) : null
    if (only) out.push(only)
    else if (run.some((n) => !(n instanceof Y.XmlText) || runText.get(n)?.trim())) out.push(para(run))
    run = []
  }
  for (const n of inlines(tokens, ctx)) {
    if ('block' in n) {
      flush()
      out.push(n.block)
    } else run.push(n)
  }
  flush()
  return out
}

function blocks(tokens: Token[], ctx: Ctx): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading': {
        const h = tok as Tokens.Heading
        const content = inlines(h.tokens, ctx).filter((n): n is Inline => !('block' in n))
        out.push(el('heading', { level: h.depth }, content))
        break
      }
      case 'paragraph':
      case 'text':
        out.push(...paragraphs((tok as Tokens.Paragraph).tokens ?? [{ type: 'text', raw: tok.raw, text: (tok as Tokens.Text).text } as Token], ctx))
        break
      case 'list': {
        const l = tok as Tokens.List
        const task = l.items.some((i) => i.task)
        const items = l.items.map((i) => {
          const inner = blocks(i.tokens.filter((t) => t.type !== 'checkbox'), ctx)
          if (!inner.length || inner[0].nodeName !== 'paragraph') inner.unshift(para([]))
          return el(task ? 'taskItem' : 'listItem', task ? { checked: Boolean(i.checked) } : {}, inner)
        })
        out.push(el(task ? 'taskList' : l.ordered ? 'orderedList' : 'bulletList', l.ordered && !task && l.start !== 1 && l.start !== '' ? { start: Number(l.start) } : {}, items))
        break
      }
      case 'blockquote': {
        const inner = blocks((tok as Tokens.Blockquote).tokens, ctx)
        if (inner.length) out.push(el('blockquote', {}, inner))
        break
      }
      case 'code': {
        const c = tok as Tokens.Code
        out.push(el('codeBlock', c.lang ? { language: c.lang } : {}, c.text ? [text(c.text)] : []))
        break
      }
      case 'hr':
        out.push(el('horizontalRule', {}))
        break
      case 'table': {
        const t = tok as Tokens.Table
        const cell = (c: Tokens.TableCell, header: boolean) => {
          const inner = paragraphs(c.tokens, ctx)
          return el(header ? 'tableHeader' : 'tableCell', {}, inner.length ? inner : [para([])])
        }
        const rows = [el('tableRow', {}, t.header.map((c) => cell(c, true))), ...t.rows.map((r) => el('tableRow', {}, r.map((c) => cell(c, false))))]
        out.push(el('table', {}, rows))
        break
      }
      case 'html': {
        const t = (tok as Tokens.HTML).text.replace(/<[^>]+>/g, '').trim()
        if (t) out.push(para([text(decode(t))]))
        break
      }
      default:
        break
    }
  }
  return out
}

export function markdownToNodes(md: string, ctx: Ctx): Y.XmlElement[] {
  return blocks(marked.lexer(md, { gfm: true }), ctx)
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}
