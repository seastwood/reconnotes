import crypto from 'node:crypto'
import * as Y from 'yjs'
import {
  WORKSPACE_DOC,
  drawingToSvg,
  extractNote,
  getContent,
  getDrawingHeight,
  getNotes,
  getStrokes,
  getTranscripts,
  noteDocName,
  readNote,
  DRAWING_WIDTH,
} from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'

/**
 * Read-only share links
 * =====================
 *
 * A link like https://notes.example.com/s/Xk3…  shows a note – or a whole
 * folder, with its subfolders – to anyone who has it, with no account, always
 * as it is now. Only the shared notes' own pictures, recordings, files and
 * drawings can be fetched through the link. Stopping the share makes the link
 * stop working at once.
 *
 * A folder is shared with someone ("Recipes" with Sydney): each person gets
 * a link of their own, stopped on its own, optionally with a passcode (asked
 * once on each of their devices). They're served on a port of their own as
 * well (shareServer.ts), which can show shared things and nothing else.
 *
 * The pages are built from the notes' structure with every piece of text
 * escaped, and served with a Content-Security-Policy that allows no scripts,
 * so nothing in a note can run on the server's address.
 */

export interface ShareRow {
  id: string
  kind: 'note' | 'folder'
  /** a note's link: the note ('' for a folder's) */
  noteId: string
  /** a folder's link: the folder */
  folderId: string | null
  /** who it's for ("Sydney") */
  name: string
  hasPasscode: boolean
  createdAt: number
  /** when the link was last opened */
  lastSeenAt: number | null
}

interface Raw {
  id: string
  note_id: string
  folder_id: string | null
  name: string | null
  pass_hash: string | null
  created_at: number
  last_seen_at: number | null
}
const COLUMNS = 'id, note_id, folder_id, name, pass_hash, created_at, last_seen_at'
const row = (r: Raw): ShareRow => ({
  id: r.id,
  kind: r.folder_id ? 'folder' : 'note',
  noteId: r.note_id,
  folderId: r.folder_id,
  name: r.name ?? '',
  hasPasscode: Boolean(r.pass_hash),
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
})

const newId = () => crypto.randomBytes(16).toString('base64url')
const hashPasscode = (passcode: string, salt: string) => crypto.scryptSync(passcode.normalize('NFKC'), salt, 32).toString('hex')

export class Shares {
  /** for the "already entered the passcode" cookie */
  private secret: Buffer
  private seen = new Map<string, number>()

  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS shares_note ON shares(note_id);
    `)
    // folder links, who they're for, passcodes, when last opened (added later: to tables made before)
    const have = new Set((store.db.prepare('PRAGMA table_info(shares)').all() as { name: string }[]).map((c) => c.name))
    for (const [col, type] of [
      ['folder_id', 'TEXT'],
      ['name', 'TEXT'],
      ['pass_hash', 'TEXT'],
      ['pass_salt', 'TEXT'],
      ['last_seen_at', 'INTEGER'],
    ])
      if (!have.has(col)) store.db.exec(`ALTER TABLE shares ADD COLUMN ${col} ${type}`)
    store.db.exec('CREATE INDEX IF NOT EXISTS shares_folder ON shares(folder_id)')
    let secret = store.getSetting<string>('shareSecret')
    if (!secret) store.setSetting('shareSecret', (secret = crypto.randomBytes(32).toString('hex')))
    this.secret = Buffer.from(secret, 'hex')
  }

  forNote(noteId: string): ShareRow | null {
    const r = this.store.db.prepare(`SELECT ${COLUMNS} FROM shares WHERE note_id = ? AND folder_id IS NULL AND revoked_at IS NULL`).get(noteId) as Raw | undefined
    return r ? row(r) : null
  }

  forFolder(folderId: string): ShareRow[] {
    return (this.store.db.prepare(`SELECT ${COLUMNS} FROM shares WHERE folder_id = ? AND revoked_at IS NULL ORDER BY created_at`).all(folderId) as Raw[]).map(row)
  }

  get(id: string): ShareRow | null {
    const r = this.store.db.prepare(`SELECT ${COLUMNS} FROM shares WHERE id = ? AND revoked_at IS NULL`).get(id) as Raw | undefined
    return r ? row(r) : null
  }

  /** The note's link (made now if it has none). */
  share(noteId: string): ShareRow {
    const existing = this.forNote(noteId)
    if (existing) return existing
    const id = newId()
    this.store.db.prepare('INSERT INTO shares (id, note_id, created_at) VALUES (?, ?, ?)').run(id, noteId, Date.now())
    return this.get(id)!
  }

  /** A new link to the folder, for `name` (each person their own). */
  shareFolder(folderId: string, name: string, passcode?: string | null): ShareRow {
    const id = newId()
    this.store.db.prepare('INSERT INTO shares (id, note_id, folder_id, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, '', folderId, name.trim().slice(0, 80), Date.now())
    if (passcode) this.setPasscode(id, passcode)
    return this.get(id)!
  }

  stop(noteId: string): boolean {
    return this.store.db.prepare('UPDATE shares SET revoked_at = ? WHERE note_id = ? AND folder_id IS NULL AND revoked_at IS NULL').run(Date.now(), noteId).changes > 0
  }

  /** Stop one link. */
  revoke(id: string): boolean {
    return this.store.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id).changes > 0
  }

  rename(id: string, name: string) {
    this.store.db.prepare('UPDATE shares SET name = ? WHERE id = ?').run(name.trim().slice(0, 80), id)
  }

  /** A passcode to open the link (null: none). A new one asks again on every device. */
  setPasscode(id: string, passcode: string | null) {
    const salt = passcode ? crypto.randomBytes(16).toString('hex') : null
    this.store.db.prepare('UPDATE shares SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(passcode ? hashPasscode(passcode, salt!) : null, salt, id)
  }

  checkPasscode(id: string, passcode: string): boolean {
    const r = this.store.db.prepare('SELECT pass_hash, pass_salt FROM shares WHERE id = ? AND revoked_at IS NULL').get(id) as { pass_hash: string | null; pass_salt: string | null } | undefined
    if (!r?.pass_hash || !r.pass_salt) return false
    const got = Buffer.from(hashPasscode(passcode, r.pass_salt), 'hex')
    return crypto.timingSafeEqual(got, Buffer.from(r.pass_hash, 'hex'))
  }

  /** What the "passcode entered" cookie holds for this link (changes when the passcode does). */
  pass(id: string): string | null {
    const r = this.store.db.prepare('SELECT pass_hash FROM shares WHERE id = ? AND revoked_at IS NULL').get(id) as { pass_hash: string | null } | undefined
    return r?.pass_hash ? crypto.createHmac('sha256', this.secret).update(`${id}|${r.pass_hash}`).digest('base64url') : null
  }

  /** Opened just now (written at most once a minute). */
  opened(id: string) {
    const now = Date.now()
    if (now - (this.seen.get(id) ?? 0) < 60_000) return
    this.seen.set(id, now)
    this.store.db.prepare('UPDATE shares SET last_seen_at = ? WHERE id = ?').run(now, id)
  }

  all(): ShareRow[] {
    return (this.store.db.prepare(`SELECT ${COLUMNS} FROM shares WHERE revoked_at IS NULL ORDER BY created_at DESC`).all() as Raw[]).map(row)
  }
}

/** The shared note, if the link is live and the note isn't deleted. */
export function sharedNote(shares: Shares, sync: SyncEngine, id: string): { noteId: string; doc: Y.Doc; title: string; updatedAt: number } | null {
  const share = /^[A-Za-z0-9_-]{16,40}$/.test(id) ? shares.get(id) : null
  if (!share || share.kind !== 'note') return null
  const meta = getNotes(sync.getDoc(WORKSPACE_DOC) ?? new Y.Doc()).get(share.noteId)
  if (!meta) return null
  const note = readNote(meta)
  if (note.trashedAt) return null
  const doc = sync.getDoc(noteDocName(share.noteId))
  if (!doc) return null
  return { noteId: share.noteId, doc, title: note.title || extractNote(doc).title || 'Note', updatedAt: note.updatedAt }
}

/** Is this attachment / drawing part of the note (so the link may serve it)? */
export function noteHas(doc: Y.Doc, kind: 'attachment' | 'drawing', id: string): boolean {
  const ex = extractNote(doc)
  if (kind === 'drawing') {
    if (ex.drawings.includes(id)) return true
    // ink drawn on a picture
    let found = false
    const walk = (el: Y.XmlElement | Y.XmlFragment) => {
      for (const c of el.toArray()) if (c instanceof Y.XmlElement) {
        if (c.nodeName === 'image' && c.getAttribute('drawingId') === id) found = true
        walk(c)
      }
    }
    walk(getContent(doc))
    return found
  }
  return ex.attachments.includes(id)
}

/** A drawing as an SVG picture (its real colours), cropped to the drawing's height. */
export function drawingSvg(doc: Y.Doc, drawingId: string, overlay = false): string {
  const strokes = getStrokes(doc, drawingId).toArray()
  const height = overlay ? Math.max(1, ...strokes.flatMap((s) => s.pts.filter((_, i) => i % 3 === 1))) + 20 : getDrawingHeight(doc, drawingId)
  const svg = drawingToSvg(strokes, DRAWING_WIDTH, height)
  return overlay ? svg.replace(/<rect [^>]*\/>/, '') : svg
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const safeHref = (h: string) => (/^(https?:|mailto:)/i.test(h.trim()) ? h.trim() : null)

/**
 * The shared page: the note's content as plain, script-free HTML. `base`: where its pictures and files
 * are fetched (/s/<link>, or /s/<link>/n/<note> in a shared folder). `opts.noteHref`: a link to
 * another note that's shared too (else it's shown as plain words); `opts.top`: a bar above it (the
 * way back to the folder).
 */
export function sharePage(base: string, title: string, doc: Y.Doc, updatedAt: number, opts: { noteHref?: (noteId: string) => string | null; top?: string; cookHref?: string } = {}): string {
  const transcripts = getTranscripts(doc)

  const inline = (el: Y.XmlElement): string => {
    let s = ''
    for (const child of el.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as { insert: unknown; attributes?: Record<string, { href?: string } | undefined> }[]) {
          if (typeof op.insert !== 'string') continue
          let t = esc(op.insert)
          const a = op.attributes ?? {}
          if (a.code) t = `<code>${t}</code>`
          if (a.bold) t = `<strong>${t}</strong>`
          if (a.italic) t = `<em>${t}</em>`
          if (a.underline) t = `<u>${t}</u>`
          if (a.strike) t = `<s>${t}</s>`
          const href = a.link?.href ? safeHref(a.link.href) : null
          if (href) t = `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${t}</a>`
          s += t
        }
      } else if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'hardBreak') s += '<br>'
        else if (child.nodeName === 'noteLink') {
          const words = esc(String(child.getAttribute('label') || child.getAttribute('title') || 'note'))
          // a link to a note that's shared as well: followed; to any other: just its words
          const to = opts.noteHref?.(String(child.getAttribute('noteId') ?? ''))
          s += to ? `<a href="${esc(to)}">${words}</a>` : `<span class="link">${words}</span>`
        }
        else if (child.nodeName === 'dueDate') s += `<span class="due">📅 ${esc(String(child.getAttribute('date') ?? ''))}</span>`
        else s += inline(child)
      }
    }
    return s
  }

  const children = (el: Y.XmlElement | Y.XmlFragment) =>
    el
      .toArray()
      .map((c) => (c instanceof Y.XmlElement ? block(c) : ''))
      .join('')

  const block = (el: Y.XmlElement): string => {
    const att = el.getAttribute('attachmentId') as string | undefined
    switch (el.nodeName) {
      case 'paragraph':
        return `<p>${inline(el) || '<br>'}</p>`
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(el.getAttribute('level') ?? 1)))
        return `<h${level}>${inline(el)}</h${level}>`
      }
      case 'bulletList':
        return `<ul>${children(el)}</ul>`
      case 'orderedList':
        return `<ol>${children(el)}</ol>`
      case 'listItem':
        return `<li>${children(el)}</li>`
      case 'taskList':
        return `<ul class="tasks">${children(el)}</ul>`
      case 'taskItem': {
        const c = el.getAttribute('checked') as unknown
        const done = c === true || c === 'true'
        return `<li class="${done ? 'done' : ''}"><span class="box">${done ? '☑' : '☐'}</span><div>${children(el)}</div></li>`
      }
      case 'blockquote':
        return `<blockquote>${children(el)}</blockquote>`
      case 'codeBlock':
        return `<pre><code>${esc(el.toArray().map((c) => (c instanceof Y.XmlText ? c.toString().replace(/<[^>]+>/g, '') : '')).join(''))}</code></pre>`
      case 'horizontalRule':
        return '<hr>'
      case 'video': {
        // a shared page plays nothing of its own: a link to the video
        const src = String(el.getAttribute('src') ?? '')
        if (!/^https?:\/\//.test(src)) return ''
        return `<p>▶ <a href="${esc(src)}" rel="noopener noreferrer">${esc(String(el.getAttribute('title') || src))}</a></p>`
      }
      case 'table':
        return `<div class="table"><table>${children(el)}</table></div>`
      case 'tableRow':
        return `<tr>${children(el)}</tr>`
      case 'tableHeader':
        return `<th>${children(el)}</th>`
      case 'tableCell':
        return `<td>${children(el)}</td>`
      case 'drawing': {
        const d = el.getAttribute('drawingId') as string | undefined
        return d ? `<figure class="drawing"><img src="${base}/d/${esc(d)}.svg" alt="Drawing"></figure>` : ''
      }
      case 'image': {
        if (!att) return ''
        const ink = el.getAttribute('drawingId') as string | undefined
        const width = Number(el.getAttribute('width') ?? 0)
        return `<figure class="image"${width ? ` style="width:${Math.min(100, Math.max(5, width))}%"` : ''}><img src="${base}/a/${esc(att)}" alt="${esc(String(el.getAttribute('alt') ?? ''))}">${
          ink ? `<img class="ink" src="${base}/d/${esc(ink)}.svg?overlay=1" alt="">` : ''
        }</figure>`
      }
      case 'audio': {
        if (!att) return ''
        const t = transcripts.get(`att:${att}`)
        return `<div class="attachment"><div>🎙️ ${esc(String(el.getAttribute('name') || 'Recording'))}</div><audio controls preload="none" src="${base}/a/${esc(att)}"></audio>${
          t ? `<details><summary>Transcript</summary><p>${esc(t)}</p></details>` : ''
        }</div>`
      }
      case 'file':
        return att ? `<div class="attachment">📎 <a href="${base}/a/${esc(att)}" download="${esc(String(el.getAttribute('name') || 'file'))}">${esc(String(el.getAttribute('name') || 'File'))}</a></div>` : ''
      default:
        return children(el)
    }
  }

  const body = children(getContent(doc))
  const when = new Date(updatedAt || Date.now()).toUTCString()
  return pageShell(
    title,
    `${opts.top ?? ''}<div class="meta">Shared from ReconNotes · updated ${esc(when)}</div>${
      opts.cookHref ? `<a class="cook-link" href="${esc(opts.cookHref)}">🍳 Cook mode</a>` : ''
    }<div class="note">${body}</div><footer>Read-only copy. It shows the note as it is now.</footer>`,
  )
}

/** A shared page's frame: its styles (light and dark), no scripts. */
export function pageShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #faf8f3; --text: #1d1d1f; --muted: #777; --line: #ddd8cc; --accent: #e0a800; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --text: #ececec; --muted: #9a9a9a; --line: #333; --card: #1f1f21; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
.meta { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
img { max-width: 100%; height: auto; border-radius: 8px; }
figure { margin: 14px 0; position: relative; }
figure.drawing img { width: 100%; background: #fff; border: 1px solid var(--line); }
figure.image img.ink { position: absolute; left: 0; top: 0; width: 100%; height: auto; border-radius: 0; }
blockquote { margin: 10px 0; padding-left: 14px; border-left: 3px solid var(--line); color: var(--muted); }
pre { background: rgba(127,127,127,.12); padding: 12px; border-radius: 8px; overflow-x: auto; }
ul.tasks { list-style: none; padding-left: 4px; }
ul.tasks li { display: flex; gap: 8px; }
ul.tasks li > div { flex: 1; min-width: 0; }
.note > :first-child { font-size: 28px; font-weight: 700; line-height: 1.25; margin-top: 0; }
ul.tasks li.done div { text-decoration: line-through; color: var(--muted); }
ul.tasks p, li p { margin: 2px 0; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: rgba(127,127,127,.12); }
th p, td p { margin: 0; }
.attachment { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
.attachment audio { width: 100%; margin-top: 6px; }
.link { border-bottom: 1px dashed var(--muted); }
.due { font-size: 14px; padding: 1px 6px; border-radius: 6px; background: rgba(127,127,127,.15); }
a { color: inherit; }
footer { margin-top: 48px; color: var(--muted); font-size: 12px; }
.crumbs { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 14px; color: var(--muted); margin-bottom: 14px; }
.crumbs a { text-decoration: none; color: var(--text); }
.crumbs a:hover { text-decoration: underline; }
h1.folder { font-size: 28px; margin: 0 0 4px; }
.list { list-style: none; padding: 0; margin: 18px 0; display: grid; gap: 8px; }
.list li { min-width: 0; }
.list a { display: block; overflow: hidden; text-decoration: none; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.list a:hover { border-color: var(--accent); }
.list .t { font-weight: 600; }
.list .s { color: var(--muted); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list .d { color: var(--muted); font-size: 12px; margin-top: 2px; }
.empty { color: var(--muted); }
form.pass { margin-top: 24px; display: grid; gap: 10px; max-width: 320px; }
form.pass input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--text); }
form.pass button { font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 10px; background: var(--accent); color: #1d1d1f; }
.error { color: #d92d20; }
.cook-link { display: inline-block; margin: 0 0 18px; padding: 10px 16px; border-radius: 12px; background: var(--accent); color: #1d1d1f; font-weight: 700; text-decoration: none; }
</style></head>
<body><main>${inner}</main></body></html>`
}

/** Headers for the shared page: no scripts, no framing, not indexed. */
export const SHARE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}
