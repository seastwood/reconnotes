import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { noteDocName, noteToMarkdown, getStrokes, extractNote } from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import { SyncEngine, safeEqual } from './sync'
import { Ai, AiUnavailableError, renderDrawingPng } from './ai'
import { initialTextStatus, queueAttachment } from './attachments'
import { listBackups, runBackup } from './backup'
import { log } from './log'

export const VERSION = '0.1.0'

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: string[], url: URL) => Promise<void> | void

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'upload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const body = await readBody(req, 1024 * 1024)
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

const ID = '([a-z0-9]{8,64})'

export function createHttpServer(config: Config, store: Store, sync: SyncEngine, ai: Ai) {
  const routes: [string, RegExp, Handler][] = []
  const route = (method: string, pattern: string, handler: Handler) =>
    routes.push([method, new RegExp(`^${pattern}$`), handler])

  route('GET', '/api/health', (_req, res) =>
    json(res, 200, {
      ok: true,
      version: VERSION,
      ai: ai.enabled,
      autoHandwriting: config.autoHandwriting && ai.enabled,
      transcription: Boolean(config.transcribeUrl),
    }),
  )

  route('GET', '/api/auth/check', (_req, res) => json(res, 200, { ok: true }))

  // --- Attachments (images, audio, files) ---------------------------------
  route('HEAD', `/api/attachments/${ID}`, (_req, res, [id]) => {
    res.writeHead(store.hasBlob(id) ? 200 : 404)
    res.end()
  })

  route('PUT', `/api/attachments/${ID}`, async (req, res, [id]) => {
    if (store.hasBlob(id)) {
      // Attachments are immutable; a retry after a dropped connection is fine.
      req.resume()
      return json(res, 200, { id, existed: true })
    }
    const data = await readBody(req, config.maxUploadBytes)
    const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim()
    const name = decodeURIComponent((req.headers['x-file-name'] as string | undefined) ?? '')
    store.putAttachment(
      { id, mime, name, size: data.length, created_at: Date.now() },
      data,
      initialTextStatus(config, ai, mime),
    )
    queueAttachment(config, store, ai, sync, id)
    json(res, 201, { id })
  })

  route('GET', `/api/attachments/${ID}`, (req, res, [id]) => {
    const att = store.getAttachment(id)
    if (!att || !store.hasBlob(id)) throw new HttpError(404, 'not found')
    res.writeHead(200, {
      'Content-Type': att.mime,
      'Content-Length': att.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    fs.createReadStream(store.blobPath(id)).pipe(res)
  })

  route('GET', `/api/attachments/${ID}/text`, (_req, res, [id]) => {
    const att = store.getAttachment(id)
    if (!att) throw new HttpError(404, 'not found')
    json(res, 200, { status: att.text_status, text: att.text })
  })

  // --- Search ---------------------------------------------------------------
  route('GET', '/api/search', (_req, res, _p, url) => {
    const q = url.searchParams.get('q') ?? ''
    const meta = sync.noteMeta()
    const hits = store
      .search(q)
      .filter((h) => meta.has(h.noteId))
      .map((h) => ({ ...h, trashed: Boolean(meta.get(h.noteId)!.trashedAt) }))
    json(res, 200, { hits })
  })

  // --- AI -----------------------------------------------------------------
  route('POST', '/api/ai/handwriting', async (req, res) => {
    const { noteId, drawingId } = await readJson<{ noteId: string; drawingId: string }>(req)
    if (!/^[a-z0-9]{8,64}$/.test(noteId ?? '') || !/^[a-z0-9]{8,64}$/.test(drawingId ?? ''))
      throw new HttpError(400, 'noteId and drawingId required')
    const text = await sync.enqueue(() => sync.recogniseDrawing(noteId, drawingId))
    json(res, 200, { text })
  })

  route('POST', '/api/ai/compile', async (req, res) => {
    const { noteId } = await readJson<{ noteId: string }>(req)
    const doc = sync.getDoc(noteDocName(noteId))
    if (!doc) throw new HttpError(404, 'note not found')
    const marker = (id: string) => `\u0000DRAWING:${id}\u0000`
    const md = noteToMarkdown(doc, { drawingPlaceholder: marker })
    const parts: ({ text: string } | { png: Buffer })[] = []
    for (const piece of md.split(/\u0000/)) {
      const m = /^DRAWING:([a-z0-9]+)$/.exec(piece)
      if (m) {
        const png = renderDrawingPng(getStrokes(doc, m[1]).toArray())
        if (png) parts.push({ png })
      } else parts.push({ text: piece })
    }
    const markdown = await sync.enqueue(() => ai.compile(parts))
    json(res, 200, { markdown, title: extractNote(doc).title })
  })

  // --- Backups & export ---------------------------------------------------
  route('GET', '/api/backups', (_req, res) => json(res, 200, { backups: listBackups(config) }))
  route('POST', '/api/backups', async (_req, res) => {
    const dir = await runBackup(config, store, sync)
    json(res, 201, { backup: path.basename(dir) })
  })

  route('GET', `/api/notes/${ID}/markdown`, (_req, res, [id]) => {
    const doc = sync.getDoc(noteDocName(id))
    if (!doc) throw new HttpError(404, 'note not found')
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    res.end(noteToMarkdown(doc, { attachmentUrl: (a) => `/api/attachments/${a}` }))
  })

  const isAuthorized = (req: http.IncomingMessage, url: URL) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '')
    return safeEqual(token, config.token)
  }

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    if (!config.webDir) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ReconNotes server is running. Point the app at this address.\n')
      return
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = path.join(config.webDir, rel)
    if (!file.startsWith(config.webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(config.webDir, 'index.html') // single-page app fallback
    }
    const ext = path.extname(file)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    fs.createReadStream(file).pipe(res)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // The web app may be served from a different origin (dev server, iOS app).
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url)
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname)
        if (!m || method !== req.method) continue
        if (url.pathname !== '/api/health' && !isAuthorized(req, url)) throw new HttpError(401, 'unauthorized')
        return await handler(req, res, m.slice(1), url)
      }
      throw new HttpError(404, 'not found')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof AiUnavailableError ? 503 : 500
      if (status >= 500) log.error(req.method, url.pathname, err)
      if (!res.headersSent) json(res, status, { error: (err as Error).message })
      else res.end()
    }
  })

  // --- WebSocket sync -------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/sync') return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const request = new Request(`http://localhost${req.url}`, { headers })
      const client = sync.hocuspocus.handleConnection(ws as unknown as WebSocket, request)
      ws.on('message', (data: Buffer) => client.handleMessage(new Uint8Array(data)))
      ws.on('close', (code, reason) => client.handleClose({ code, reason: reason.toString() } as CloseEvent))
      ws.on('error', (err) => log.warn('websocket error', err.message))
    })
  })

  return server
}
