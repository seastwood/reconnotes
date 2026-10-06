import crypto from 'node:crypto'
import { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import {
  WORKSPACE_DOC,
  extractNote,
  getStrokes,
  getTranscripts,
  inkHash,
  transcriptSourceKey,
  noteDocName,
  noteIdFromDocName,
  readNote,
  getNotes,
} from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import { Ai, renderDrawingPng } from './ai'
import { log } from './log'
import { maybeSnapshot } from './versions'
import type { Devices } from './devices'
import type { Jobs } from './jobs'
import type { MeaningIndex } from './semantic'

const DOC_NAME = /^(workspace|note:[a-z0-9]{8,64})$/

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb) && a.length > 0
}

/**
 * The sync engine. Every device keeps a full local copy of every document and
 * exchanges Yjs updates with the server over a WebSocket whenever it is
 * online. The server merges updates (a CRDT merge never conflicts and never
 * drops edits), persists them to SQLite and relays them to other devices.
 */
export class SyncEngine {
  readonly hocuspocus: Hocuspocus
  private hwTimers = new Map<string, NodeJS.Timeout>()
  /** set by createApp: background work goes through the job queue */
  jobs!: Jobs
  /** set by createApp: search by meaning */
  meaning: MeaningIndex | null = null
  private embedTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private config: Config,
    private store: Store,
    private ai: Ai,
    private devices?: Devices,
  ) {
    this.hocuspocus = new Hocuspocus({
      quiet: true,
      debounce: 1500,
      maxDebounce: 10_000,
      onAuthenticate: async ({ token, documentName }) => {
        const caller = this.devices ? this.devices.check(token ?? '') : safeEqual(token ?? '', config.token) ? { kind: 'main' as const } : null
        if (!caller) throw new Error('unauthorized')
        if (!DOC_NAME.test(documentName)) throw new Error('invalid document name')
        // remembered with the connection, so revoking a device can disconnect it
        return { deviceId: caller.kind === 'device' ? caller.id : null }
      },
      onLoadDocument: async ({ documentName, document }) => {
        const state = store.loadDocument(documentName)
        if (state) Y.applyUpdate(document, state)
        return document
      },
      onStoreDocument: async ({ documentName, document }) => {
        store.saveDocument(documentName, Y.encodeStateAsUpdate(document))
        this.afterStore(documentName, document)
      },
    })
  }

  /**
   * Cut off a device whose key was revoked: its sockets are dropped (one
   * socket carries all of a device's documents), so it reconnects, its key
   * is refused, and it shows that it's no longer allowed to sync.
   */
  disconnectDevice(deviceId: string) {
    for (const doc of this.hocuspocus.documents.values()) {
      for (const conn of [...doc.connections.keys()]) {
        if ((conn.context as { deviceId?: string } | undefined)?.deviceId !== deviceId) continue
        conn.close({ code: 4401, reason: 'unauthorized' } as CloseEvent)
        const ws = conn.webSocket as { terminate?: () => void; close?: (code?: number) => void }
        if (ws.terminate) ws.terminate()
        else ws.close?.(4401)
      }
    }
  }

  /** Read a document without opening a connection (memory first, then disk). */
  getDoc(name: string): Y.Doc | null {
    const live = this.hocuspocus.documents.get(name)
    if (live) return live
    const state = this.store.loadDocument(name)
    if (!state) return null
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return doc
  }

  /** Apply a server-side change to a document; it syncs to every device. */
  async change(name: string, fn: (doc: Y.Doc) => void) {
    const conn = await this.hocuspocus.openDirectConnection(name, { server: true })
    try {
      await conn.transact(fn)
    } finally {
      await conn.disconnect()
    }
  }

  private afterStore(name: string, doc: Y.Doc) {
    const noteId = noteIdFromDocName(name)
    if (!noteId) return
    try {
      maybeSnapshot(this.store, name, doc)
    } catch (err) {
      log.error('version snapshot failed', name, err)
    }
    try {
      this.indexNote(noteId, doc)
    } catch (err) {
      log.error('indexing failed', name, err)
    }
  }

  indexNote(noteId: string, doc: Y.Doc) {
    const ex = extractNote(doc)
    const attTexts = this.store.attachmentTexts(ex.attachments)
    const full = extractNote(doc, attTexts)
    this.store.indexNote(noteId, full.title, full.text, full.attachments)

    // Copy extracted attachment text into the note itself so it syncs to every
    // device and offline search can find it too.
    const transcripts = getTranscripts(doc)
    const missing = Object.entries(attTexts).filter(([id, t]) => transcripts.get(`att:${id}`) !== t)
    if (missing.length) {
      void this.change(noteDocName(noteId), (d) => {
        const tr = getTranscripts(d)
        for (const [id, t] of missing) tr.set(`att:${id}`, t)
      }).catch((err) => log.error('could not write attachment text', err))
    }

    if (this.ai.autoHandwriting) {
      for (const drawingId of ex.drawings) this.maybeScheduleHandwriting(noteId, drawingId, doc)
    }
    this.scheduleEmbedding(noteId)
  }

  /** Update the note's search-by-meaning vectors once it has been quiet for a moment. */
  scheduleEmbedding(noteId: string, delayMs = 20_000) {
    if (!this.meaning?.available || !this.jobs) return
    clearTimeout(this.embedTimers.get(noteId))
    const t = setTimeout(() => {
      this.embedTimers.delete(noteId)
      const title = this.noteMeta().get(noteId)?.title || 'Untitled'
      this.jobs.submit({ kind: 'embed', title, noteId, input: { noteId }, origin: 'auto', dedupeKey: `embed:${noteId}` })
    }, delayMs)
    t.unref?.()
    this.embedTimers.set(noteId, t)
  }

  /** Queue vectors for every note that doesn't have them yet (first setup, or a new embedding model). */
  embedMissing(): number {
    if (!this.meaning?.available) return 0
    const ids = this.store.listDocuments('note:').map((n) => noteIdFromDocName(n)!).filter(Boolean)
    const missing = this.meaning.notesNeedingVectors(ids)
    for (const id of missing) this.scheduleEmbedding(id, 0)
    return missing.length
  }

  reindexNotesFor(attachmentId: string) {
    for (const noteId of this.store.notesReferencing(attachmentId)) {
      const doc = this.getDoc(noteDocName(noteId))
      if (doc) this.indexNote(noteId, doc)
    }
  }

  /** Re-index every note (e.g. after an upgrade or restoring a backup). */
  reindexAll() {
    for (const name of this.store.listDocuments('note:')) {
      const doc = this.getDoc(name)
      if (doc) this.indexNote(noteIdFromDocName(name)!, doc)
    }
  }

  // --- Automatic handwriting recognition ----------------------------------

  private maybeScheduleHandwriting(noteId: string, drawingId: string, doc: Y.Doc) {
    const strokes = getStrokes(doc, drawingId).toArray()
    const hash = strokesHash(strokes)
    if (this.store.drawingHash(noteId, drawingId) === hash) return
    // An iPad already recognised exactly these strokes with Apple's
    // on-device recognizer (usually better than server models): keep it.
    if (getTranscripts(doc).get(transcriptSourceKey(drawingId)) === `device:${inkHash(strokes)}`) return
    const key = `${noteId}/${drawingId}`
    clearTimeout(this.hwTimers.get(key))
    // Wait until the writer has paused so we don't recognise half a sentence.
    this.hwTimers.set(
      key,
      setTimeout(() => {
        this.hwTimers.delete(key)
        const title = this.noteMeta().get(noteId)?.title || 'Untitled'
        this.jobs.submit({ kind: 'recognise', title, noteId, input: { noteId, drawingId }, origin: 'auto', dedupeKey: `recognise:${key}` })
      }, this.config.handwritingDebounceMs),
    )
  }

  /** Recognise handwriting in a drawing and store it as the drawing's transcript. */
  async recogniseDrawing(noteId: string, drawingId: string, opts: { requireText?: boolean } = {}): Promise<{ text: string; agent: string | null }> {
    const doc = this.getDoc(noteDocName(noteId))
    if (!doc) throw new Error('note not found')
    const strokes = getStrokes(doc, drawingId).toArray()
    const hash = strokesHash(strokes)
    if (!renderDrawingPng(strokes) && opts.requireText) throw new EmptyDrawingError()
    // An explicit "Convert to text" also gets the clean-up pass; background
    // recognition (for search) doesn't need it.
    const { text, agent } = await this.ai.transcribeDrawing(strokes, { requireText: opts.requireText, format: opts.requireText })
    this.store.setDrawingHash(noteId, drawingId, hash)
    await this.change(noteDocName(noteId), (d) => {
      const tr = getTranscripts(d)
      if (text) tr.set(drawingId, text)
      else tr.delete(drawingId)
    })
    log.info(`recognised handwriting in ${noteId}/${drawingId} (${text.length} chars)`)
    return { text, agent }
  }

  /** Live (non-trashed) note metadata, used to filter search results. */
  noteMeta() {
    const ws = this.getDoc(WORKSPACE_DOC)
    const out = new Map<string, ReturnType<typeof readNote>>()
    if (ws) getNotes(ws).forEach((m, id) => out.set(id, readNote(m)))
    return out
  }

  async destroy() {
    for (const t of this.hwTimers.values()) clearTimeout(t)
    for (const t of this.embedTimers.values()) clearTimeout(t)
    this.hocuspocus.flushPendingStores()
    this.hocuspocus.closeConnections()
  }
}

export class EmptyDrawingError extends Error {
  constructor() {
    super('This drawing has no ink on the server yet. Wait a moment for it to sync and try again.')
  }
}

export function strokesHash(strokes: { id: string }[]): string {
  return crypto
    .createHash('sha1')
    .update(strokes.map((s) => s.id).join(','))
    .digest('hex')
}
