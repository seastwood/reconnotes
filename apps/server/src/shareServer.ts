import fs from 'node:fs'
import http from 'node:http'
import * as Y from 'yjs'
import { WORKSPACE_DOC, extractNote, folderRules, getFolders, getNotes, noteDocName, readFolder, readNote, type FolderData, type NoteData } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { COOK_SCRIPT, cookPage, recipeIn } from './shareCook'
import { SHARE_HEADERS, type ShareRow, type Shares, drawingSvg, esc, noteHas, pageShell, sharePage, sharedNote } from './shares'

/**
 * The share port
 * ==============
 *
 * A port of its own (RECON_SHARE_PORT, 8790 unless set) that serves shared
 * notes and folders – and nothing else: no app, no API, no sync, no AI, and
 * no device key is ever accepted on it. It's the one to make reachable for
 * the people you share with (on your network, over WireGuard, or through a
 * reverse proxy on a domain of its own), while the server's own port stays
 * yours alone.
 *
 * A shared folder: /s/<link> lists it (subfolders, then notes), /s/<link>/f/<folder> a subfolder,
 * /s/<link>/n/<note> a note, and /s/<link>/n/<note>/a|d/… its pictures, files and drawings. Only
 * what's in the folder now is reachable: not a note moved out, deleted, a template, or anything in a
 * locked (password) folder. With a passcode, every page asks for it first (once on each device: a
 * cookie for that link, which a new passcode undoes).
 */

const LINK = '([A-Za-z0-9_-]{16,40})'
const ID = '([A-Za-z0-9_-]{6,64})'

export interface ShareContext {
  store: Store
  sync: SyncEngine
  shares: Shares
}

/** Wrong passcodes: a few, then a pause (per link and address, and per link overall). */
const tries = new Map<string, { n: number; until: number }>()
function tooMany(keys: string[]): boolean {
  const now = Date.now()
  return keys.some((k) => (tries.get(k)?.until ?? 0) > now)
}
function failed(keys: string[]) {
  const now = Date.now()
  for (const [i, k] of keys.entries()) {
    const t = tries.get(k)
    const n = t && t.until < now && t.n >= (i ? 30 : 6) ? 1 : (t?.n ?? 0) + 1
    // 6 wrong from one address: 15 minutes; 30 on the link from anywhere: an hour
    tries.set(k, { n, until: n >= (i ? 30 : 6) ? now + (i ? 3_600_000 : 900_000) : 0 })
  }
  if (tries.size > 10_000) tries.clear()
}

const send = (res: http.ServerResponse, status: number, html: string, head = false, form = false, script = false) => {
  res.writeHead(status, {
    ...SHARE_HEADERS,
    // the passcode page's form may send to this address (any other page: no forms at all)
    ...(form ? { 'Content-Security-Policy': SHARE_HEADERS['Content-Security-Policy'].replace("form-action 'none'", "form-action 'self'") } : {}),
    // cook mode runs its one fixed script, from this address (no other page runs any)
    ...(script ? { 'Content-Security-Policy': `${SHARE_HEADERS['Content-Security-Policy']}; script-src 'self'` } : {}),
    'Content-Type': 'text/html; charset=utf-8',
  })
  res.end(head ? undefined : html)
}
const gone = (res: http.ServerResponse, head = false) =>
  send(res, 404, pageShell('Not shared', '<p>This isn’t shared any more – or the link isn’t quite right.</p>'), head)

/** What a folder link can reach now: its folders (it and the unlocked ones inside it), by id. */
function reach(ws: Y.Doc, share: ShareRow): Map<string, FolderData> | null {
  const folders = [...getFolders(ws).values()].map(readFolder)
  const rules = folderRules(folders)
  const live = new Map(folders.filter((f) => !f.trashedAt).map((f) => [f.id, f]))
  const root = share.folderId ? live.get(share.folderId) : undefined
  if (!root || rules.get(root.id)?.lockedBy) return null
  const out = new Map<string, FolderData>([[root.id, root]])
  for (let added = true; added; ) {
    added = false
    for (const f of live.values())
      if (!out.has(f.id) && f.parentId && out.has(f.parentId) && !rules.get(f.id)?.lockedBy) {
        out.set(f.id, f)
        added = true
      }
  }
  return out
}

/** The notes in these folders that a link shows (not deleted, not templates). */
function notesIn(ws: Y.Doc, folders: Map<string, FolderData>): Map<string, NoteData> {
  const out = new Map<string, NoteData>()
  getNotes(ws).forEach((m) => {
    const n = readNote(m)
    if (n.folderId && folders.has(n.folderId) && !n.trashedAt && !n.template) out.set(n.id, n)
  })
  return out
}

const byOrder = (sort: FolderData['sort']) => (a: NoteData, b: NoteData) =>
  Number(b.pinned) - Number(a.pinned) ||
  (sort === 'title'
    ? (a.title || 'Untitled').localeCompare(b.title || 'Untitled')
    : sort === 'created'
      ? b.createdAt - a.createdAt
      : sort === 'manual'
        ? a.order < b.order
          ? -1
          : a.order > b.order
            ? 1
            : 0
        : b.updatedAt - a.updatedAt)

const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** "Recipes › Soups › …": the way back up to the shared folder. */
function crumbs(link: string, folders: Map<string, FolderData>, rootId: string, folderId: string, last?: string): string {
  const path: FolderData[] = []
  for (let f = folders.get(folderId); f; f = f.id === rootId ? undefined : folders.get(f.parentId ?? '')) path.unshift(f)
  const parts = path.map((f) => `<a href="${f.id === rootId ? `/s/${link}` : `/s/${link}/f/${esc(f.id)}`}">📁 ${esc(f.name || 'Untitled folder')}</a>`)
  if (last) parts.push(`<span>${esc(last)}</span>`)
  return `<nav class="crumbs">${parts.join('<span>›</span>')}</nav>`
}

function folderPage(link: string, share: ShareRow, folders: Map<string, FolderData>, notes: Map<string, NoteData>, folderId: string): string {
  const folder = folders.get(folderId)!
  const subs = [...folders.values()]
    .filter((f) => f.parentId === folderId)
    .sort((a, b) => (folder.sort === 'manual' ? (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) : a.name.localeCompare(b.name)))
  // how many notes in each subfolder, with its own subfolders
  const count = (id: string): number => [...notes.values()].filter((n) => n.folderId === id).length + [...folders.values()].filter((f) => f.parentId === id).reduce((s, f) => s + count(f.id), 0)
  const here = [...notes.values()].filter((n) => n.folderId === folderId).sort(byOrder(folder.sort))
  const items = [
    ...subs.map((f) => `<li><a href="/s/${link}/f/${esc(f.id)}"><div class="t">📁 ${esc(f.name || 'Untitled folder')}</div><div class="d">${count(f.id)} note${count(f.id) === 1 ? '' : 's'}</div></a></li>`),
    ...here.map(
      (n) =>
        `<li><a href="/s/${link}/n/${esc(n.id)}"><div class="t">${n.pinned ? '📌 ' : ''}${esc(n.title || 'Untitled')}</div>${n.snippet ? `<div class="s">${esc(n.snippet)}</div>` : ''}<div class="d">${day(n.updatedAt || n.createdAt)}</div></a></li>`,
    ),
  ]
  return pageShell(
    folder.name || 'Shared folder',
    `${folderId === share.folderId ? '' : crumbs(link, folders, share.folderId!, folder.parentId ?? share.folderId!)}<h1 class="folder">${esc(folder.name || 'Untitled folder')}</h1><div class="meta">Shared from ReconNotes${share.name ? ` with ${esc(share.name)}` : ''} · read-only, always up to date</div>${
      items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="empty">Nothing in this folder yet.</p>'
    }`,
  )
}

function passcodePage(link: string, wrong: boolean, wait: boolean): string {
  return pageShell(
    'Passcode',
    `<h1 class="folder">🔒 Enter the passcode</h1><p class="meta">This shared folder has a passcode. You’ll only be asked once on this device.</p>
<form class="pass" method="post" action="/s/${link}/unlock"><input name="passcode" type="password" autocomplete="current-password" autofocus required aria-label="Passcode">${
      wait ? '<p class="error">Too many wrong tries – wait a while, then try again.</p>' : wrong ? '<p class="error">That isn’t it – try again.</p>' : ''
    }<button type="submit">Open</button></form>`,
  )
}

const cookieName = (link: string) => `rn_${link.slice(0, 12)}`
function cookie(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/** A file from a shared note: never allowed to run as a page on this address. */
function sendFile(ctx: ShareContext, res: http.ServerResponse, attachmentId: string, head: boolean): boolean {
  const att = ctx.store.getAttachment(attachmentId)
  if (!att || !ctx.store.hasBlob(att.id)) return false
  const inline = /^(image\/(png|jpeg|gif|webp|heic)|audio\/|video\/|application\/pdf)/.test(att.mime)
  res.writeHead(200, {
    ...SHARE_HEADERS,
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    'Content-Type': inline ? att.mime : 'application/octet-stream',
    'Content-Length': att.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.name || att.id)}`,
  })
  if (head) res.end()
  else fs.createReadStream(ctx.store.blobPath(att.id)).pipe(res)
  return true
}

const readForm = (req: http.IncomingMessage) =>
  new Promise<URLSearchParams>((resolve) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c.toString()
      if (body.length > 4096) req.destroy()
    })
    req.on('end', () => resolve(new URLSearchParams(body)))
    req.on('error', () => resolve(new URLSearchParams()))
  })

/**
 * A share link's page (or its picture, file or drawing). False: not a share address at all. Used by
 * the share port and by the server's own port (for links made before there was a share port).
 */
export async function serveShare(ctx: ShareContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const head = req.method === 'HEAD'
  const path = url.pathname.replace(/\/$/, '')
  // cook mode's script (the same for everyone; nothing of anyone's in it)
  if (path === '/s/_/cook.js') {
    res.writeHead(200, { ...SHARE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
    return res.end(head ? undefined : COOK_SCRIPT), true
  }
  // a note's own link (/s/<link>, its files /s/<link>/a|d/…)
  const m = new RegExp(`^/s/${LINK}(?:/(a|d)/${ID}(\\.svg)?|/(cook))?$`).exec(path)
  const share = m ? ctx.shares.get(m[1]) : null
  if (m && (!share || share.kind === 'note')) {
    if (req.method !== 'GET' && !head) return gone(res), true
    const shared = sharedNote(ctx.shares, ctx.sync, m[1])
    if (!shared) return gone(res, head), true
    ctx.shares.opened(m[1])
    const recipe = recipeIn(shared.doc)
    if (m[5]) return recipe ? send(res, 200, cookPage(shared.title, recipe, `/s/${m[1]}`), head, false, true) : gone(res, head), true
    if (!m[2]) return send(res, 200, sharePage(`/s/${m[1]}`, shared.title, shared.doc, shared.updatedAt, { cookHref: recipe ? `/s/${m[1]}/cook` : undefined }), head), true
    if (m[2] === 'd') {
      if (!noteHas(shared.doc, 'drawing', m[3])) return gone(res, head), true
      res.writeHead(200, { ...SHARE_HEADERS, 'Content-Type': 'image/svg+xml' })
      return res.end(head ? undefined : drawingSvg(shared.doc, m[3], url.searchParams.has('overlay'))), true
    }
    if (!noteHas(shared.doc, 'attachment', m[3]) || !sendFile(ctx, res, m[3], head)) gone(res, head)
    return true
  }

  // a folder's link
  const f = new RegExp(`^/s/${LINK}(?:/(unlock|f/${ID}|n/${ID}(?:/(a|d)/${ID}(\\.svg)?|/(cook))?))?$`).exec(path)
  if (!f) return false
  const link = f[1]
  const folderShare = ctx.shares.get(link)
  if (!folderShare || folderShare.kind !== 'folder') return gone(res, head), true

  // the passcode, once on each device
  const pass = ctx.shares.pass(link)
  if (f[2] === 'unlock') {
    if (req.method !== 'POST') return res.writeHead(303, { Location: `/s/${link}` }), res.end(), true
    const addr = req.socket.remoteAddress ?? ''
    const keys = [`${link}|${addr}`, link]
    if (tooMany(keys)) return send(res, 429, passcodePage(link, false, true), false, true), true
    const given = (await readForm(req)).get('passcode') ?? ''
    if (!pass || !ctx.shares.checkPasscode(link, given)) {
      if (pass) failed(keys)
      return send(res, pass ? 401 : 200, passcodePage(link, Boolean(pass), false), false, true), true
    }
    const secure = (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https'
    res.writeHead(303, {
      ...SHARE_HEADERS,
      Location: `/s/${link}`,
      'Set-Cookie': `${cookieName(link)}=${pass}; Path=/s/${link}; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    })
    return res.end(), true
  }
  if (req.method !== 'GET' && !head) return gone(res), true
  if (pass && cookie(req, cookieName(link)) !== pass) {
    // a picture or file without the passcode: nothing; a page: the passcode form
    if (f[5]) return gone(res, head), true
    return send(res, 200, passcodePage(link, false, false), head, true), true
  }

  const ws = ctx.sync.getDoc(WORKSPACE_DOC)
  const folders = ws ? reach(ws, folderShare) : null
  if (!ws || !folders) return gone(res, head), true
  const notes = notesIn(ws, folders)
  ctx.shares.opened(link)

  if (!f[3] && !f[4]) return send(res, 200, folderPage(link, folderShare, folders, notes, folderShare.folderId!), head), true
  if (f[3]) {
    if (!folders.has(f[3])) return gone(res, head), true
    return send(res, 200, folderPage(link, folderShare, folders, notes, f[3]), head), true
  }
  const note = notes.get(f[4])
  const doc = note ? ctx.sync.getDoc(noteDocName(note.id)) : null
  if (!note || !doc) return gone(res, head), true
  const base = `/s/${link}/n/${note.id}`
  const title = note.title || extractNote(doc).title || 'Note'
  const recipe = recipeIn(doc)
  if (f[8]) return recipe ? send(res, 200, cookPage(title, recipe, base), head, false, true) : gone(res, head), true
  if (!f[5]) {
    const html = sharePage(base, title, doc, note.updatedAt, {
      cookHref: recipe ? `${base}/cook` : undefined,
      noteHref: (id) => (notes.has(id) ? `/s/${link}/n/${id}` : null),
      top: crumbs(link, folders, folderShare.folderId!, note.folderId!, title),
    })
    return send(res, 200, html, head), true
  }
  if (f[5] === 'd') {
    if (!noteHas(doc, 'drawing', f[6])) return gone(res, head), true
    res.writeHead(200, { ...SHARE_HEADERS, 'Content-Type': 'image/svg+xml' })
    return res.end(head ? undefined : drawingSvg(doc, f[6], url.searchParams.has('overlay'))), true
  }
  if (!noteHas(doc, 'attachment', f[6]) || !sendFile(ctx, res, f[6], head)) gone(res, head)
  return true
}

/** The share port's server: share links, and nothing else. */
export function createShareServer(ctx: ShareContext): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('User-agent: *\nDisallow: /\n')
    }
    if (url.pathname.startsWith('/s/') && ['GET', 'HEAD', 'POST'].includes(req.method ?? ''))
      return void serveShare(ctx, req, res, url)
        .then((done) => done || gone(res))
        .catch(() => {
          if (!res.headersSent) send(res, 500, pageShell('Error', '<p>Something went wrong.</p>'))
          else res.end()
        })
    gone(res, req.method === 'HEAD')
  })
}
