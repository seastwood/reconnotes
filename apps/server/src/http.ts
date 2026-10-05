import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { noteDocName, noteToMarkdown, getStrokes, extractNote, restoreNoteContent } from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import { loadVersion, snapshotNow } from './versions'
import { askNotes } from './ask'
import { EmptyDrawingError, SyncEngine, safeEqual } from './sync'
import { Ai, isAiImage, renderDrawingPng, sampleHandwritingPng, type CompilePart } from './ai'
import {
  AI_TASKS,
  AgentValidationError,
  AllAgentsFailedError,
  NoAgentError,
  TASK_LABELS,
  makeBackend,
  probeAgent,
  listModels,
  validateAgent,
  type AgentConfig,
  type AiSettings,
} from './agents'
import { initialTextStatus, queueAttachment, retryAttachments } from './attachments'
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
      ai: { handwriting: ai.canHandwriting, images: ai.canImages, pdf: ai.canPdf, compile: ai.canCompile, audio: ai.canAudio },
      autoHandwriting: ai.autoHandwriting,
      transcription: ai.canAudio,
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
    const { text, agent } = await sync.enqueue(() => sync.recogniseDrawing(noteId, drawingId, { requireText: true }))
    json(res, 200, { text, agent })
  })

  /**
   * Convert a picture (photo of notes, screenshot, whiteboard…) to text. The
   * app sends the image itself, already downscaled, so this works even before
   * the attachment has finished uploading.
   */
  route('POST', '/api/ai/image-to-text', async (req, res) => {
    const mime = (req.headers['content-type'] ?? '').split(';')[0].trim()
    if (!isAiImage(mime)) throw new HttpError(415, 'Send a PNG, JPEG, GIF or WebP image')
    const data = await readBody(req, 25 * 1024 * 1024)
    const { text, agent } = await sync.enqueue(() => ai.transcribePhoto(data, mime))
    json(res, 200, { text, agent })
  })

  /** "Ask your notes": an answer from your notes, with the notes it used. */
  route('POST', '/api/ai/ask', async (req, res) => {
    const { question } = await readJson<{ question: string }>(req)
    if (!String(question ?? '').trim()) throw new HttpError(400, 'Ask a question')
    const result = await sync.enqueue(() => askNotes(store, sync, ai, String(question).trim().slice(0, 1000)))
    json(res, 200, result)
  })

  /**
   * One-tap note actions: summary / to-dos of a note (by id), or cleaned-up
   * wording of some text the app sends.
   */
  route('POST', '/api/ai/note-action', async (req, res) => {
    const { action, noteId, text } = await readJson<{ action: string; noteId?: string; text?: string }>(req)
    if (action !== 'summary' && action !== 'todos' && action !== 'clean') throw new HttpError(400, 'unknown action')
    let markdown = String(text ?? '')
    if (action !== 'clean') {
      const doc = /^[a-z0-9]{8,64}$/.test(noteId ?? '') ? sync.getDoc(noteDocName(noteId!)) : null
      if (!doc) throw new HttpError(404, 'note not found')
      markdown = noteToMarkdown(doc, { attachmentText: true })
    }
    if (!markdown.trim()) throw new HttpError(400, 'There is no text to work with.')
    const result = await sync.enqueue(() => ai.noteAction(action, markdown))
    json(res, 200, result)
  })

  /**
   * Transcribe a recording or audio file that has been uploaded. Reuses the
   * transcript when the server already made one (for search).
   */
  route('POST', '/api/ai/audio-to-text', async (req, res) => {
    const { attachmentId } = await readJson<{ attachmentId: string }>(req)
    const att = /^[a-zA-Z0-9_-]{8,64}$/.test(attachmentId ?? '') ? store.getAttachment(attachmentId) : undefined
    if (!att || !store.hasBlob(att.id)) throw new HttpError(409, "This recording hasn't reached the server yet – try again once it has synced.")
    if (att.text_status === 'done' && att.text?.trim()) return json(res, 200, { text: att.text, agent: null })
    const data = fs.readFileSync(store.blobPath(att.id))
    const { text, agent } = await sync.enqueue(() => ai.transcribeAudio(data, att.mime, att.name))
    store.setAttachmentText(att.id, text, 'done')
    sync.reindexNotesFor(att.id)
    json(res, 200, { text, agent })
  })

  /**
   * Run only the clean-up pass on text recognised elsewhere (e.g. by
   * Apple's on-device recognizer on an iPad). Returns the text unchanged
   * when no clean-up agent is set up.
   */
  route('POST', '/api/ai/tidy', async (req, res) => {
    const body = await readBody(req, 25 * 1024 * 1024)
    let input: { text?: string; image?: string; mime?: string }
    try {
      input = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid JSON')
    }
    const text = String(input.text ?? '')
    const image = input.image ? Buffer.from(input.image, 'base64') : null
    const mime = input.mime && isAiImage(input.mime) ? input.mime : 'image/png'
    const tidied = await sync.enqueue(() => ai.tidy(text, image, mime))
    json(res, 200, { text: tidied, cleaned: tidied !== text })
  })

  /** The exact image sent to the AI for a drawing – handy when recognition goes wrong. */
  route('GET', '/api/ai/drawing-image', (_req, res, _p, url) => {
    const noteId = url.searchParams.get('noteId') ?? ''
    const drawingId = url.searchParams.get('drawingId') ?? ''
    const doc = /^[a-z0-9]{8,64}$/.test(noteId) ? sync.getDoc(noteDocName(noteId)) : null
    if (!doc || !/^[a-z0-9]{8,64}$/.test(drawingId)) throw new HttpError(404, 'drawing not found')
    const png = renderDrawingPng(getStrokes(doc, drawingId).toArray())
    if (!png) throw new HttpError(404, 'this drawing has no ink on the server')
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(png)
  })

  route('POST', '/api/ai/compile', async (req, res) => {
    const { noteId } = await readJson<{ noteId: string }>(req)
    const doc = sync.getDoc(noteDocName(noteId))
    if (!doc) throw new HttpError(404, 'note not found')
    // Splice the real drawings and pictures into the note's text, in order.
    const md = noteToMarkdown(doc, {
      drawingPlaceholder: (id) => `\u0000DRAWING:${id}\u0000`,
      imagePlaceholder: (id) => `\u0000IMAGE:${id}\u0000`,
    })
    const parts: CompilePart[] = []
    for (const piece of md.split(/\u0000/)) {
      const m = /^(DRAWING|IMAGE):([a-z0-9]+)$/.exec(piece)
      if (!m) {
        parts.push({ text: piece })
      } else if (m[1] === 'DRAWING') {
        const strokes = getStrokes(doc, m[2]).toArray()
        const png = renderDrawingPng(strokes)
        if (png) parts.push({ image: png, mime: 'image/png', kind: 'drawing', strokes })
      } else {
        const att = store.getAttachment(m[2])
        if (att && isAiImage(att.mime) && store.hasBlob(att.id)) {
          parts.push({ image: fs.readFileSync(store.blobPath(att.id)), mime: att.mime, kind: 'photo' })
        } else parts.push({ text: '\n[picture not available on the server yet]\n' })
      }
    }
    const markdown = await sync.enqueue(() => ai.compile(parts))
    json(res, 200, { markdown, title: extractNote(doc).title })
  })

  // --- AI agent management ------------------------------------------------
  const agentsPayload = () => ({
    agents: ai.agents.view(),
    settings: ai.agents.settings(),
    tasks: AI_TASKS.map((id) => ({ id, label: TASK_LABELS[id] })),
  })

  route('GET', '/api/ai/agents', (_req, res) => json(res, 200, agentsPayload()))

  route('POST', '/api/ai/agents', async (req, res) => {
    const body = await readJson<Partial<AgentConfig>>(req)
    const { id: _ignored, ...input } = body
    const agent = ai.agents.save(input)
    retryAttachments(config, store, ai, sync)
    json(res, 201, { agent: ai.agents.viewOf(agent.id), ...agentsPayload() })
  })

  route('PUT', `/api/ai/agents/${ID}`, async (req, res, [id]) => {
    if (!ai.agents.get(id)) throw new HttpError(404, 'agent not found')
    const body = await readJson<Partial<AgentConfig>>(req)
    ai.agents.save({ ...body, id })
    retryAttachments(config, store, ai, sync)
    json(res, 200, { agent: ai.agents.viewOf(id), ...agentsPayload() })
  })

  route('DELETE', `/api/ai/agents/${ID}`, (_req, res, [id]) => {
    ai.agents.remove(id)
    json(res, 200, agentsPayload())
  })

  route('PUT', '/api/ai/settings', async (req, res) => {
    ai.agents.updateSettings(await readJson<Partial<AiSettings>>(req))
    retryAttachments(config, store, ai, sync)
    json(res, 200, agentsPayload())
  })

  /**
   * Test an agent's connection, saved or not. For a saved agent, fields that
   * are left out (like the API key) come from the stored configuration.
   */
  route('POST', '/api/ai/probe', async (req, res) => {
    const body = await readJson<Partial<AgentConfig>>(req)
    const saved = body.id ? ai.agents.get(body.id) : undefined
    const merged = { ...(saved ?? {}), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) }
    const agent = validateAgent(merged)
    const result = await probeAgent(agent)
    if (saved) ai.agents.recordProbe(saved.id, result)
    json(res, 200, result)
  })

  /** The models available on an agent's server (saved or being edited), for the picker. */
  route('POST', '/api/ai/models', async (req, res) => {
    const body = await readJson<Partial<AgentConfig>>(req)
    const saved = body.id ? ai.agents.get(body.id) : undefined
    const agent = validateAgent({ ...(saved ?? {}), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) })
    json(res, 200, await listModels(agent))
  })

  /** Ask an agent (saved or being edited) to read a sample handwritten word. */
  route('POST', '/api/ai/try-handwriting', async (req, res) => {
    const body = await readJson<Partial<AgentConfig>>(req)
    const saved = body.id ? ai.agents.get(body.id) : undefined
    const agent = validateAgent({ ...(saved ?? {}), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) })
    const started = Date.now()
    try {
      const text = await ai.transcribeWith(makeBackend(agent), agent, sampleHandwritingPng(), { requireText: true })
      const ok = /hello/i.test(text)
      json(res, 200, {
        ok,
        text,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        message: ok ? 'It read the sample word correctly.' : 'It answered, but didn’t read the sample word (HELLO) correctly.',
      })
    } catch (err) {
      json(res, 200, { ok: false, text: '', seconds: Math.round((Date.now() - started) / 100) / 10, message: (err as Error).message })
    }
  })

  route('GET', '/api/ai/sample-handwriting.png', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(sampleHandwritingPng())
  })

  // --- Backups & export ---------------------------------------------------
  route('GET', '/api/backups', (_req, res) => json(res, 200, { backups: listBackups(config) }))
  route('POST', '/api/backups', async (_req, res) => {
    const dir = await runBackup(config, store, sync)
    json(res, 201, { backup: path.basename(dir) })
  })

  // --- Version history ------------------------------------------------------
  route('GET', `/api/notes/${ID}/versions`, (_req, res, [id]) => {
    json(res, 200, { versions: store.listVersions(noteDocName(id)) })
  })

  /** One version as Markdown (with recognised handwriting and picture text) for the preview. */
  route('GET', `/api/notes/${ID}/versions/([0-9]+)`, (_req, res, [id, vid]) => {
    const doc = loadVersion(store, noteDocName(id), Number(vid))
    if (!doc) throw new HttpError(404, 'version not found')
    json(res, 200, { markdown: noteToMarkdown(doc, { attachmentText: true, attachmentUrl: (a) => `/api/attachments/${a}` }) })
  })

  /** Make the note look like this version again (the current state is kept as a version first). */
  route('POST', `/api/notes/${ID}/versions/([0-9]+)/restore`, async (_req, res, [id, vid]) => {
    const name = noteDocName(id)
    const old = loadVersion(store, name, Number(vid))
    const current = sync.getDoc(name)
    if (!old || !current) throw new HttpError(404, 'version not found')
    snapshotNow(store, name, current, 'Before restoring')
    await sync.change(name, (doc) => restoreNoteContent(doc, old))
    json(res, 200, { ok: true })
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS')
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
      const status =
        err instanceof HttpError
          ? err.status
          : err instanceof AgentValidationError
            ? 400
            : err instanceof EmptyDrawingError
              ? 409
            : err instanceof NoAgentError
              ? 503
              : err instanceof AllAgentsFailedError
                ? 502
                : 500
      if (status === 502 || status === 503) log.warn(`${req.method} ${url.pathname}: ${(err as Error).message}`)
      else if (status >= 500) log.error(req.method, url.pathname, err)
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

  /** Drop every connection so shutdown is immediate; devices reconnect later. */
  const closeSockets = () => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    server.closeAllConnections()
  }

  return { server, closeSockets }
}
