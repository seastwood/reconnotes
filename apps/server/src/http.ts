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
import { Ai, compileMarker, isAiImage, keepCompileExtras, renderDrawingPng, sampleHandwritingPng, type CompilePart } from './ai'
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
  warmOllama,
} from './agents'
import { initialTextStatus, queueAttachment, retryAttachments } from './attachments'
import { listBackups, runBackup } from './backup'
import { exportZip } from './exportZip'
import type { Caller, Devices } from './devices'
import { SHARE_HEADERS, Shares, drawingSvg, noteHas, sharePage, sharedNote } from './shares'
import { importNotes, unpack } from './importNotes'
import type { Jobs } from './jobs'
import type { Notifier } from './notify'
import { JOB_KINDS, compileMarkdown, removeJobResult } from './jobHandlers'
import { backupNotes, describeBackups, restoreFromBackup } from './restoreBackup'
import { log } from './log'
import { aiHealth } from './health'
import { noteFilter, scopeFromQuery } from './access'
import { notePieces, whereMatched } from './notePieces'
import type { Samples } from './bench'

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
const HAS_LABELS = { handwriting: 1, picture: 1, recording: 1, file: 1, checklist: 1, link: 1, table: 1 }
const HAS_KINDS = new Set(Object.keys(HAS_LABELS))

export function createHttpServer(config: Config, store: Store, sync: SyncEngine, ai: Ai, devices: Devices, jobs: Jobs, notifier: Notifier, samples?: Samples) {
  const callers = new WeakMap<http.IncomingMessage, Caller>()
  const shares = new Shares(store)
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

  route('GET', '/api/auth/check', (req, res) => json(res, 200, { ok: true, caller: callers.get(req) }))

  // --- Devices (a key per device, switched off on its own when lost) ------
  route('GET', '/api/devices', (req, res) => json(res, 200, { devices: devices.list(), caller: callers.get(req) }))
  route('POST', '/api/devices', async (req, res) => {
    const { name } = await readJson<{ name?: string }>(req)
    json(res, 201, devices.add(String(name ?? '')))
  })
  route('PUT', '/api/devices/([a-f0-9]{8,32})', async (req, res, [id]) => {
    const { name } = await readJson<{ name?: string }>(req)
    if (!devices.rename(id, String(name ?? ''))) throw new HttpError(404, 'device not found')
    json(res, 200, { devices: devices.list() })
  })
  route('POST', '/api/devices/([a-f0-9]{8,32})/revoke', (_req, res, [id]) => {
    if (!devices.revoke(id)) throw new HttpError(404, 'device not found')
    sync.disconnectDevice(id)
    json(res, 200, { devices: devices.list() })
  })
  route('DELETE', '/api/devices/([a-f0-9]{8,32})', (_req, res, [id]) => {
    if (!devices.remove(id)) throw new HttpError(409, 'Switch the device off first')
    json(res, 200, { devices: devices.list() })
  })

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
      initialTextStatus(config, ai, mime, name),
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
      // an uploaded HTML/SVG file must never run as a page on this address
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    })
    fs.createReadStream(store.blobPath(id)).pipe(res)
  })

  route('GET', `/api/attachments/${ID}/text`, (_req, res, [id]) => {
    const att = store.getAttachment(id)
    if (!att) throw new HttpError(404, 'not found')
    json(res, 200, { status: att.text_status, text: att.text })
  })

  // --- Search ---------------------------------------------------------------
  route('GET', '/api/search', async (_req, res, _p, url) => {
    const q = url.searchParams.get('q') ?? ''
    const meta = sync.noteMeta()
    // not locked folders (unless unlocked on the asking device), not folders left out of search
    const allowed = noteFilter(sync, scopeFromQuery(url.searchParams))
    // has:handwriting / picture / recording / file / checklist / link / table
    const has = (url.searchParams.get('has') ?? '').split(',').filter((k) => HAS_KINDS.has(k)) as (keyof typeof HAS_LABELS)[]
    const pieces = new Map<string, ReturnType<typeof notePieces> | null>()
    const piecesOf = (id: string) => {
      if (!pieces.has(id)) {
        const doc = sync.getDoc(noteDocName(id))
        pieces.set(id, doc ? notePieces(doc, store) : null)
      }
      return pieces.get(id)!
    }
    const hasAll = (id: string) => !has.length || has.every((k) => piecesOf(id)?.has.has(k))
    type Hit = { noteId: string; title: string; snippet: string; rank: number; meaning?: boolean; where?: { kind: string; line: string } }
    let hits: Hit[]
    if (!q.trim() && has.length) {
      // only has: – every note that has it, newest first
      hits = [...meta.values()]
        .filter((m) => !m.trashedAt && !m.template && allowed(m.id) && hasAll(m.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100)
        .map((m) => ({ noteId: m.id, title: m.title, snippet: m.snippet, rank: 0 }))
    } else {
      const words: Hit[] = store
        .search(q, 500)
        .filter((h) => meta.has(h.noteId) && allowed(h.noteId) && hasAll(h.noteId))
        .slice(0, 50)
      // notes about the same thing in other words (when an embedding model is set up)
      const seen = new Set(words.map((h) => h.noteId))
      const related = sync.meaning?.available && q.trim().length >= 3 ? await sync.meaning.search(q, 200) : []
      hits = [
        ...words,
        ...related
          .filter((h) => meta.has(h.noteId) && !seen.has(h.noteId) && allowed(h.noteId) && hasAll(h.noteId))
          .slice(0, 12)
          .map((h) => ({ noteId: h.noteId, title: meta.get(h.noteId)!.title, snippet: h.passage.replace(/\s+/g, ' ').slice(0, 180), rank: -h.score, meaning: true })),
      ]
      // where each matched: typed text, handwriting, a picture, a recording, a file
      const terms = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
      for (const h of hits.slice(0, 50)) {
        if (h.meaning) continue
        const p = piecesOf(h.noteId)
        const w = p && whereMatched(p.pieces, terms)
        if (w) h.where = w
      }
    }
    json(res, 200, { hits: hits.map((h) => ({ ...h, trashed: Boolean(meta.get(h.noteId)!.trashedAt) })) })
  })

  // --- AI -----------------------------------------------------------------
  route('POST', '/api/ai/handwriting', async (req, res) => {
    const { noteId, drawingId } = await readJson<{ noteId: string; drawingId: string }>(req)
    if (!/^[a-z0-9]{8,64}$/.test(noteId ?? '') || !/^[a-z0-9]{8,64}$/.test(drawingId ?? ''))
      throw new HttpError(400, 'noteId and drawingId required')
    const title = sync.noteMeta().get(noteId)?.title || 'Untitled'
    const { text, agent } = await jobs.run(
      { kind: 'convert-drawing', title, noteId, input: { noteId, drawingId }, device: deviceName(req) },
      () => sync.recogniseDrawing(noteId, drawingId, { requireText: true }),
      (r) => ({ result: { text: r.text.slice(0, 1500) }, agent: r.agent }),
    )
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
    const { text, agent } = await jobs.run(
      { kind: 'convert-picture', title: 'Picture', device: deviceName(req) },
      () => ai.transcribePhoto(data, mime),
      (r) => ({ result: { text: r.text.slice(0, 1500) }, agent: r.agent }),
    )
    json(res, 200, { text, agent })
  })

  /** "Ask your notes": an answer from your notes, with the notes it used. */
  route('POST', '/api/ai/ask', async (req, res) => {
    const { question } = await readJson<{ question: string }>(req)
    if (!String(question ?? '').trim()) throw new HttpError(400, 'Ask a question')
    const q = String(question).trim().slice(0, 1000)
    const result = await jobs.run(
      { kind: 'ask', title: q, input: { question: q }, device: deviceName(req) },
      () => askNotes(store, sync, ai, q, sync.meaning),
      (r) => ({ result: r as unknown as Record<string, unknown>, agent: r.agent }),
    )
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
    const title = noteId ? sync.noteMeta().get(noteId)?.title || 'Untitled' : markdown.slice(0, 60)
    const result = await jobs.run(
      { kind: action, title, noteId: noteId ?? null, input: action === 'clean' ? { text: markdown } : { noteId }, device: deviceName(req) },
      () => ai.noteAction(action, markdown),
      (r) => ({ result: { text: r.text.slice(0, 1500) }, agent: r.agent }),
    )
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
    const { text, agent } = await jobs.run(
      { kind: 'transcribe', title: att.name || 'Recording', device: deviceName(req) },
      () => ai.transcribeAudio(data, att.mime, att.name),
      (r) => ({ result: { text: r.text.slice(0, 1500) }, agent: r.agent }),
    )
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
    const tidied = await jobs.run({ kind: 'tidy', title: text.slice(0, 60) || 'Text', device: deviceName(req) }, () => ai.tidy(text, image, mime), (t) => ({ result: { text: t.slice(0, 1500) } }))
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
    const out = await jobs.run(
      { kind: 'compile', title: extractNote(doc).title || 'Untitled', noteId, device: deviceName(req) },
      () => compileMarkdown(store, ai, doc),
      (r) => ({ result: { text: r.markdown.slice(0, 1500) } }),
    )
    json(res, 200, { markdown: out.markdown, title: out.title })
  })

  // --- Jobs: every AI request and background step ---------------------------
  const deviceName = (req: http.IncomingMessage): string | null => {
    const c = callers.get(req)
    return c?.kind === 'device' ? (devices.list().find((d) => d.id === c.id)?.name ?? 'Device') : null
  }
  const jobsPayload = () => ({ jobs: jobs.list(), paused: jobs.queuePaused, version: jobs.version, counts: jobs.counts(), kinds: JOB_KINDS })
  const jobOr404 = (id: string) => {
    const j = jobs.get(id)
    if (!j) throw new HttpError(404, 'job not found')
    return j
  }

  route('GET', '/api/jobs', (req, res) => {
    notifier.seen(deviceName(req))
    json(res, 200, jobsPayload())
  })

  /** Wait (up to 25 s) for any change to the jobs, then send the list. */
  route('GET', '/api/jobs/changes', async (req, res, _p, url) => {
    // this device is open and following its jobs: it notifies itself
    const away = url.searchParams.get('away') === '1'
    if (!away) notifier.seen(deviceName(req))
    await jobs.nextChange(Number(url.searchParams.get('since') ?? 0), 25_000)
    if (!away) notifier.seen(deviceName(req))
    json(res, 200, jobsPayload())
  })

  /** Ask for a job. A picture or image to work on can come along (base64). */
  route('POST', '/api/jobs', async (req, res) => {
    const body = await readBody(req, 30 * 1024 * 1024)
    let spec: { kind?: string; title?: string; noteId?: string; input?: Record<string, unknown>; prompt?: string; file?: string }
    try {
      spec = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid JSON')
    }
    const kind = String(spec.kind ?? '')
    if (!JOB_KINDS[kind] || kind === 'recognise' || kind === 'extract-text') throw new HttpError(400, 'unknown job kind')
    const noteId = spec.noteId && /^[a-z0-9]{8,64}$/.test(spec.noteId) ? spec.noteId : null
    const title = String(spec.title ?? '').trim() || (noteId ? sync.noteMeta().get(noteId)?.title : '') || JOB_KINDS[kind]
    const job = jobs.submit({ kind, title, noteId, input: { ...(spec.input ?? {}), ...(noteId ? { noteId } : {}) }, prompt: spec.prompt ?? null, device: deviceName(req) })
    // the job starts on the next tick, so the file is in place first
    if (spec.file) fs.writeFileSync(jobs.filePath(job.id), Buffer.from(spec.file, 'base64'))
    json(res, 201, { job })
  })

  /** Work done on a device (e.g. Apple's recognizer), shown in the list too. */
  route('POST', '/api/jobs/record', async (req, res) => {
    const b = await readJson<{ id?: string; kind: string; title: string; noteId?: string; input?: Record<string, unknown>; result?: Record<string, unknown>; agent?: string; error?: string; startedAt?: number; finishedAt?: number }>(req)
    if (!JOB_KINDS[b.kind]) throw new HttpError(400, 'unknown job kind')
    const job = jobs.record({ ...b, title: String(b.title ?? JOB_KINDS[b.kind]), noteId: b.noteId ?? null, device: deviceName(req) })
    json(res, 201, { job })
  })

  route('GET', `/api/jobs/${ID}`, (_req, res, [id]) => json(res, 200, { job: jobOr404(id) }))

  /** Wait (up to 50 s) for a job to finish. */
  route('GET', `/api/jobs/${ID}/wait`, async (_req, res, [id]) => {
    jobOr404(id)
    const job = await Promise.race([jobs.wait(id), new Promise<null>((r) => setTimeout(() => r(null), 50_000))])
    json(res, 200, { job: job ?? jobs.get(id) })
  })

  route('POST', `/api/jobs/${ID}/cancel`, (_req, res, [id]) => json(res, 200, { job: jobs.cancel(jobOr404(id).id) }))
  route('POST', `/api/jobs/${ID}/pause`, (_req, res, [id]) => json(res, 200, { job: jobs.pause(jobOr404(id).id) }))
  route('POST', `/api/jobs/${ID}/resume`, (_req, res, [id]) => json(res, 200, { job: jobs.resume(jobOr404(id).id) }))
  route('POST', `/api/jobs/${ID}/run-next`, (_req, res, [id]) => json(res, 200, { job: jobs.runNext(jobOr404(id).id) }))
  route('POST', `/api/jobs/${ID}/redo`, async (req, res, [id]) => {
    const { prompt } = await readJson<{ prompt?: string }>(req)
    jobOr404(id)
    try {
      json(res, 201, { job: jobs.redo(id, prompt?.trim() ? prompt.trim().slice(0, 2000) : null, deviceName(req)) })
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
  })
  route('POST', `/api/jobs/${ID}/remove-result`, async (_req, res, [id]) => {
    const job = jobOr404(id)
    if (job.status !== 'done') throw new HttpError(400, 'This job has no result to remove.')
    await removeJobResult(sync, jobs, job)
    json(res, 200, { job: jobs.get(id) })
  })
  route('DELETE', `/api/jobs/${ID}`, (_req, res, [id]) => {
    jobs.remove(id)
    json(res, 200, { ok: true })
  })
  route('POST', '/api/jobs/clear-finished', (_req, res) => {
    jobs.clearFinished()
    json(res, 200, jobsPayload())
  })
  route('POST', '/api/jobs/away', (req, res) => {
    notifier.away(deviceName(req))
    json(res, 200, { ok: true })
  })

  /**
   * Load the handwriting model now (you opened a note with handwriting or
   * pictures), so "Convert to text" doesn't wait for it to load. Skipped while
   * a job is running (it would push that job's model out of the GPU).
   */
  const warmed = new Map<string, number>()
  /**
   * Read all handwriting and pictures again for search, with the current
   * agents (e.g. after switching models or improving how they read).
   */
  route('POST', '/api/ai/reread', (_req, res) => {
    let drawings = 0
    let pictures = 0
    if (ai.canHandwriting) {
      store.clearDrawingHashes()
      const meta = sync.noteMeta()
      for (const name of store.listDocuments('note:')) {
        const doc = sync.getDoc(name)
        const noteId = name.slice('note:'.length)
        if (!doc || meta.get(noteId)?.trashedAt) continue
        for (const drawingId of extractNote(doc).drawings) {
          jobs.submit({ kind: 'recognise', title: meta.get(noteId)?.title || 'Untitled', noteId, input: { noteId, drawingId }, origin: 'auto', dedupeKey: `recognise:${noteId}/${drawingId}` })
          drawings++
        }
      }
    }
    if (ai.canImages) {
      for (const att of store.attachmentsWithStatus(['done', 'error', 'skipped'])) {
        if (!isAiImage(att.mime)) continue
        // keep the old text searchable until the new reading arrives
        store.setAttachmentText(att.id, att.text, 'pending')
        queueAttachment(config, store, ai, sync, att.id)
        pictures++
      }
    }
    sync.embedMissing()
    json(res, 202, { drawings, pictures })
  })

  // --- your words: names and terms the AI should spell right -----------------
  route('GET', '/api/ai/vocabulary', (_req, res) => json(res, 200, ai.vocabulary?.get() ?? { words: [], learned: [] }))
  route('PUT', '/api/ai/vocabulary', async (req, res) => {
    const { words } = await readJson<{ words: string[] }>(req)
    ai.vocabulary?.setWords(Array.isArray(words) ? words.map(String) : [])
    json(res, 200, ai.vocabulary?.get())
  })
  route('POST', '/api/ai/vocabulary/forget', async (req, res) => {
    const { from, to } = await readJson<{ from: string; to: string }>(req)
    ai.vocabulary?.forget(String(from), String(to))
    json(res, 200, ai.vocabulary?.get())
  })

  // --- is the AI working? ----------------------------------------------------
  route('GET', '/api/ai/health', async (_req, res, _p, url) => json(res, 200, await aiHealth(ai.agents, jobs, url.searchParams.get('fresh') === '1')))

  // --- test samples: your handwriting with the right text, to compare models --
  const benchSamples = () => {
    if (!samples) throw new HttpError(404, 'not available')
    return samples
  }
  route('GET', '/api/ai/samples', (_req, res) => json(res, 200, { samples: benchSamples().list() }))
  route('POST', '/api/ai/samples', async (req, res) => {
    const { jobId } = await readJson<{ jobId: string }>(req)
    try {
      json(res, 201, { sample: benchSamples().fromJob(jobOr404(String(jobId)), sync, jobs) })
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(400, (e as Error).message)
    }
  })
  route('GET', `/api/ai/samples/${ID}/image`, (_req, res, [id]) => {
    const img = benchSamples().image(id)
    if (!img) throw new HttpError(404, 'sample not found')
    res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400' })
    res.end(img.image)
  })
  route('PUT', `/api/ai/samples/${ID}`, async (req, res, [id]) => {
    const { truth } = await readJson<{ truth: string }>(req)
    if (!String(truth ?? '').trim()) throw new HttpError(400, 'The right text can’t be empty.')
    benchSamples().setTruth(id, String(truth))
    json(res, 200, { samples: benchSamples().list() })
  })
  route('DELETE', `/api/ai/samples/${ID}`, (_req, res, [id]) => {
    benchSamples().remove(id)
    json(res, 200, { samples: benchSamples().list() })
  })

  route('POST', '/api/ai/warm', async (_req, res) => {
    const agent = ai.agents.chain('handwriting')[0]
    const key = agent ? `${agent.baseUrl}|${agent.model}` : ''
    if (!agent || agent.kind !== 'ollama' || jobs.counts().running || Date.now() - (warmed.get(key) ?? 0) < 120_000) return json(res, 200, { warmed: false })
    warmed.set(key, Date.now())
    void warmOllama(agent)
    json(res, 202, { warmed: true })
  })

  // --- Notifications when jobs finish (ntfy / Home Assistant / webhook) -------
  route('GET', '/api/notify', (_req, res) => json(res, 200, notifier.view()))
  route('PUT', '/api/notify', async (req, res) => {
    notifier.save(await readJson(req))
    json(res, 200, notifier.view())
  })
  // --- push notifications to the iPhone / iPad app (through Apple, no other service) --
  const pushDevice = (req: http.IncomingMessage) => {
    const c = callers.get(req)
    return c?.kind === 'device' ? c.id : 'main'
  }
  const apns = () => {
    if (!notifier.apns) throw new HttpError(404, 'not available')
    return notifier.apns
  }
  route('GET', '/api/push', (req, res) => json(res, 200, apns().view(pushDevice(req))))
  route('PUT', '/api/push', async (req, res) => {
    try {
      apns().save(await readJson(req))
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    json(res, 200, apns().view(pushDevice(req)))
  })
  /** The app on this device can receive pushes at this token. */
  route('POST', '/api/push/register', async (req, res) => {
    const { token, name } = await readJson<{ token: string; name?: string }>(req)
    try {
      apns().register(String(token ?? ''), pushDevice(req), deviceName(req) ?? (String(name ?? '').trim() || 'iPhone / iPad'))
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    json(res, 200, apns().view(pushDevice(req)))
  })
  route('POST', '/api/push/unregister', async (req, res) => {
    const { token } = await readJson<{ token: string }>(req)
    apns().unregister(String(token ?? ''))
    json(res, 200, apns().view(pushDevice(req)))
  })
  /** A test notification to this device's app. */
  route('POST', '/api/push/test', async (req, res) => {
    const mine = apns().devices().filter((d) => d.deviceId === pushDevice(req))
    if (!mine.length) throw new HttpError(400, 'This device hasn’t registered for notifications yet – turn them on in the app first.')
    let sent = 0
    try {
      for (const d of mine) if (await apns().sendTo(d, { title: 'ReconNotes', body: 'Notifications work. You’ll get one when a job you started finishes.' })) sent++
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    if (!sent) throw new HttpError(400, 'Apple didn’t accept the notification – see the server log.')
    json(res, 200, { sent })
  })

  route('POST', '/api/notify/test', async (_req, res) => {
    try {
      await notifier.send({ title: 'ReconNotes', message: 'Notifications work. You’ll get one when a job you started finishes.', link: 'reconnotes://open', failed: false })
    } catch (e) {
      throw new HttpError(400, `Couldn’t send the test notification: ${(e as Error).message}`)
    }
    json(res, 200, { ok: true })
  })

  route('POST', '/api/jobs/pause-all', async (req, res) => {
    const { paused } = await readJson<{ paused: boolean }>(req)
    jobs.setPaused(Boolean(paused))
    json(res, 200, jobsPayload())
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
    sync.embedMissing()
    json(res, 201, { agent: ai.agents.viewOf(agent.id), ...agentsPayload() })
  })

  route('PUT', `/api/ai/agents/${ID}`, async (req, res, [id]) => {
    if (!ai.agents.get(id)) throw new HttpError(404, 'agent not found')
    const body = await readJson<Partial<AgentConfig>>(req)
    ai.agents.save({ ...body, id })
    retryAttachments(config, store, ai, sync)
    sync.embedMissing()
    json(res, 200, { agent: ai.agents.viewOf(id), ...agentsPayload() })
  })

  route('DELETE', `/api/ai/agents/${ID}`, (_req, res, [id]) => {
    ai.agents.remove(id)
    json(res, 200, agentsPayload())
  })

  route('PUT', '/api/ai/settings', async (req, res) => {
    ai.agents.updateSettings(await readJson<Partial<AiSettings>>(req))
    retryAttachments(config, store, ai, sync)
    sync.embedMissing()
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
  route('GET', '/api/backups', (_req, res) =>
    json(res, 200, { backups: listBackups(config), details: describeBackups(config, listBackups(config)), intervalHours: config.backupIntervalHours }),
  )
  route('POST', '/api/backups', async (_req, res) => {
    const dir = await runBackup(config, store, sync)
    json(res, 201, { backup: path.basename(dir) })
  })
  const BACKUP = '(\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z)'
  /** The notes in a backup, and whether each has changed since. */
  route('GET', `/api/backups/${BACKUP}/notes`, (_req, res, [name]) => {
    if (!listBackups(config).includes(name)) throw new HttpError(404, 'backup not found')
    json(res, 200, { notes: backupNotes(config, sync, name) })
  })
  /** Restore some notes ({ noteIds }) or everything ({ all: true }) from a backup. */
  route('POST', `/api/backups/${BACKUP}/restore`, async (req, res, [name]) => {
    if (!listBackups(config).includes(name)) throw new HttpError(404, 'backup not found')
    const body = await readJson<{ noteIds?: string[]; all?: boolean }>(req)
    const ids = body.all ? null : (body.noteIds ?? []).filter((id) => /^[a-z0-9]{8,64}$/.test(id))
    if (ids && !ids.length) throw new HttpError(400, 'Choose notes to restore')
    json(res, 200, await restoreFromBackup(config, store, sync, name, ids))
  })

  /** Everything as a zip of Markdown files with their pictures, files and drawings. */
  route('GET', '/api/export', (_req, res) => {
    const { zip } = exportZip(store, sync)
    const day = new Date().toISOString().slice(0, 10)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      'Content-Disposition': `attachment; filename="ReconNotes ${day}.zip"`,
      'Cache-Control': 'no-store',
    })
    res.end(zip)
  })

  /** Import a Markdown file, or a zip of them (with folders, pictures and files). */
  route('POST', '/api/import', async (req, res, _p, url) => {
    const data = await readBody(req, config.maxUploadBytes)
    const name = decodeURIComponent((req.headers['x-file-name'] as string | undefined) ?? 'Imported.md')
    const folderId = url.searchParams.get('folderId')
    if (folderId && !/^[a-z0-9]{8,64}$/.test(folderId)) throw new HttpError(400, 'bad folder')
    let files
    try {
      files = unpack(name, data)
    } catch {
      throw new HttpError(400, 'That file couldn’t be read. Import Markdown (.md) files or a .zip of them.')
    }
    if (!files.some((f) => /\.(md|markdown|mdown|txt)$/i.test(f.path)) && files.length === 1)
      throw new HttpError(400, 'That isn’t a Markdown file. To add other files to a folder, use “Add files” in the notes list.')
    json(res, 200, await importNotes(config, store, ai, sync, files, folderId))
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

  // --- Share links (read-only, public) ---------------------------------------
  const shareView = (noteId: string) => {
    const row = shares.forNote(noteId)
    return { shared: Boolean(row), path: row ? `/s/${row.id}` : null, createdAt: row?.createdAt ?? null }
  }
  route('GET', `/api/notes/${ID}/share`, (_req, res, [id]) => json(res, 200, shareView(id)))
  route('POST', `/api/notes/${ID}/share`, (_req, res, [id]) => {
    if (!sync.getDoc(noteDocName(id))) throw new HttpError(409, 'This note hasn’t reached the server yet – try again once it has synced.')
    shares.share(id)
    json(res, 200, shareView(id))
  })
  route('DELETE', `/api/notes/${ID}/share`, (_req, res, [id]) => {
    shares.stop(id)
    json(res, 200, shareView(id))
  })

  /** Public pages for share links (no key needed). */
  const servePublic = (res: http.ServerResponse, url: URL): boolean => {
    const m = /^\/s\/([A-Za-z0-9_-]{16,40})(?:\/(a|d)\/([A-Za-z0-9]{8,64})(\.svg)?)?\/?$/.exec(url.pathname)
    if (!m) return false
    const shared = sharedNote(shares, sync, m[1])
    const notFound = () => {
      res.writeHead(404, { ...SHARE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>Not shared</title><p style="font:17px system-ui;margin:40px">This note isn’t shared any more.</p>')
      return true
    }
    if (!shared) return notFound()
    if (!m[2]) {
      res.writeHead(200, { ...SHARE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      res.end(sharePage(m[1], shared.title, shared.doc, shared.updatedAt))
      return true
    }
    if (m[2] === 'd') {
      if (!noteHas(shared.doc, 'drawing', m[3])) return notFound()
      res.writeHead(200, { ...SHARE_HEADERS, 'Content-Type': 'image/svg+xml' })
      res.end(drawingSvg(shared.doc, m[3], url.searchParams.has('overlay')))
      return true
    }
    const att = noteHas(shared.doc, 'attachment', m[3]) ? store.getAttachment(m[3]) : null
    if (!att || !store.hasBlob(att.id)) return notFound()
    const inline = /^(image\/(png|jpeg|gif|webp|heic)|audio\/|video\/|application\/pdf)/.test(att.mime)
    res.writeHead(200, {
      ...SHARE_HEADERS,
      // never let a shared file run as a page on this address
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
      'Content-Type': inline ? att.mime : 'application/octet-stream',
      'Content-Length': att.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.name || att.id)}`,
    })
    fs.createReadStream(store.blobPath(att.id)).pipe(res)
    return true
  }

  route('GET', `/api/notes/${ID}/markdown`, (_req, res, [id]) => {
    const doc = sync.getDoc(noteDocName(id))
    if (!doc) throw new HttpError(404, 'note not found')
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    res.end(noteToMarkdown(doc, { attachmentUrl: (a) => `/api/attachments/${a}` }))
  })

  const isAuthorized = (req: http.IncomingMessage, url: URL) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '')
    const caller = devices.check(token)
    if (caller) callers.set(req, caller)
    return Boolean(caller)
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
      if (url.pathname.startsWith('/s/') && (req.method === 'GET' || req.method === 'HEAD') && servePublic(res, url)) return
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
