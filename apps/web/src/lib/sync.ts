import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import {
  WORKSPACE_DOC,
  extractNote,
  getNotes,
  noteDocName,
  noteIdFromDocName,
  updateNote,
} from '@reconnotes/core'
import { Store } from './store'
import { isSyncConfigured, settings, syncUrl } from './settings'
import { saveNoteText } from './search'
import { flushUploads } from './attachments'

/**
 * Offline-first sync
 * ==================
 *
 * Every document is stored locally in IndexedDB first (y-indexeddb), so the
 * app works with no network at all. When a server is configured and
 * reachable, the same documents are attached to a single multiplexed
 * WebSocket and exchange Yjs updates with the server. Because Yjs is a CRDT,
 * edits made on several devices while offline are merged automatically when
 * they reconnect – nothing is overwritten and nothing is lost.
 */

export type SyncState = 'local' | 'connecting' | 'online' | 'offline' | 'unauthorized'

export interface SyncStatus {
  state: SyncState
  /** documents with local changes the server hasn't confirmed yet */
  pending: number
  lastSyncedAt: number | null
  backgroundSyncing: boolean
}

export const syncStatus = new Store<SyncStatus>({
  state: isSyncConfigured() ? 'connecting' : 'local',
  pending: 0,
  lastSyncedAt: null,
  backgroundSyncing: false,
})

class DocHandle {
  readonly doc = new Y.Doc()
  readonly idb: IndexeddbPersistence
  provider: HocuspocusProvider | null = null
  refs = 0
  readonly loaded: Promise<void>
  private releaseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly name: string,
    private manager: SyncManager,
  ) {
    this.idb = new IndexeddbPersistence(`reconnotes:${name}`, this.doc)
    this.loaded = this.idb.whenSynced.then(() => undefined)
  }

  attach(socket: HocuspocusProviderWebsocket) {
    if (this.provider) return
    this.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: this.name,
      document: this.doc,
      token: () => settings.get().token,
      onAuthenticationFailed: () => syncStatus.set({ state: 'unauthorized' }),
      onSynced: () => this.manager.recount(),
      onUnsyncedChanges: () => this.manager.recount(),
    })
    this.provider.attach()
  }

  detach() {
    this.provider?.destroy()
    this.provider = null
  }

  get synced(): boolean {
    return Boolean(this.provider?.isSynced && this.provider.unsyncedChanges === 0)
  }

  retain() {
    this.refs++
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
  }

  release() {
    this.refs--
    if (this.refs > 0 || this.name === WORKSPACE_DOC) return
    // Keep recently used notes warm for a bit so switching back is instant.
    this.releaseTimer = setTimeout(() => this.manager.destroy(this), 60_000)
  }

  beforeDestroy: () => void = () => {}

  destroy() {
    this.beforeDestroy()
    this.detach()
    void this.idb.destroy().catch(() => undefined) // closes the IndexedDB connection; data stays
    this.doc.destroy()
  }
}

export class SyncManager {
  private socket: HocuspocusProviderWebsocket | null = null
  private handles = new Map<string, DocHandle>()
  private bgTimer: ReturnType<typeof setInterval> | null = null
  readonly workspace: DocHandle

  constructor() {
    this.workspace = this.handle(WORKSPACE_DOC)
    this.workspace.retain()
    this.configure()
    settings.subscribe(() => {
      const s = settings.get()
      if (s.serverUrl !== this.configured.url || s.token !== this.configured.token) this.configure()
    })
    window.addEventListener('online', () => this.socket?.connect())
  }

  private configured = { url: '', token: '' }

  /** (Re)connect according to the current settings. */
  configure() {
    const s = settings.get()
    this.configured = { url: s.serverUrl, token: s.token }
    for (const h of this.handles.values()) h.detach()
    this.socket?.destroy()
    this.socket = null
    if (this.bgTimer) clearInterval(this.bgTimer)
    if (!isSyncConfigured()) {
      syncStatus.set({ state: 'local', pending: 0 })
      return
    }
    syncStatus.set({ state: 'connecting' })
    this.socket = new HocuspocusProviderWebsocket({
      url: syncUrl(),
      maxDelay: 30_000,
      onStatus: ({ status }) => {
        if (syncStatus.get().state === 'unauthorized') return
        if (status === 'connected') {
          syncStatus.set({ state: 'online' })
          void flushUploads()
          void this.backgroundSync()
        } else if (status === 'disconnected') syncStatus.set({ state: 'offline' })
        else syncStatus.set({ state: 'connecting' })
      },
    })
    for (const h of this.handles.values()) void h.loaded.then(() => this.socket && h.attach(this.socket))
    // Periodically make sure every note is on this device (and on the server).
    this.bgTimer = setInterval(() => void this.backgroundSync(), 10 * 60_000)
  }

  private handle(name: string): DocHandle {
    let h = this.handles.get(name)
    if (!h) {
      h = new DocHandle(name, this)
      this.handles.set(name, h)
      const handle = h
      void h.loaded.then(() => {
        if (this.socket && this.handles.get(name) === handle) handle.attach(this.socket)
      })
      if (noteIdFromDocName(name)) this.watchNote(h)
    }
    return h
  }

  /** Open a document; call the returned function when done with it. */
  open(name: string): { handle: DocHandle; close: () => void } {
    const h = this.handle(name)
    h.retain()
    let closed = false
    return {
      handle: h,
      close: () => {
        if (!closed) h.release()
        closed = true
      },
    }
  }

  destroy(h: DocHandle) {
    if (h.refs > 0 || this.handles.get(h.name) !== h) return
    this.handles.delete(h.name)
    h.destroy()
    this.recount()
  }

  recount() {
    let pending = 0
    for (const h of this.handles.values()) if (h.provider && h.provider.unsyncedChanges > 0) pending++
    const allSynced = [...this.handles.values()].every((h) => !h.provider || h.synced)
    syncStatus.set({ pending, ...(allSynced && this.socket ? { lastSyncedAt: Date.now() } : {}) })
  }

  /**
   * Keep the workspace's note list (title, preview, modified time) and the
   * local search index up to date as a note changes – locally or remotely.
   */
  private watchNote(h: DocHandle) {
    const noteId = noteIdFromDocName(h.name)!
    let timer: ReturnType<typeof setTimeout> | null = null
    let localChange = false
    const flush = () => {
      timer = null
      const ex = extractNote(h.doc)
      const ws = this.workspace.doc
      const meta = getNotes(ws).get(noteId)
      if (meta) {
        const patch: Record<string, unknown> = { title: ex.title, snippet: ex.snippet }
        if (localChange) patch.updatedAt = Date.now()
        updateNote(ws, noteId, patch)
      }
      localChange = false
      void saveNoteText(noteId, ex.title, ex.text)
    }
    h.doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin !== h.provider && origin !== h.idb) localChange = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 600)
    })
    // Flush pending metadata/search updates before the doc is closed.
    h.beforeDestroy = () => {
      if (timer) {
        clearTimeout(timer)
        flush()
      }
    }
    void h.loaded.then(() => {
      if (h.doc.share.size) flush()
    })
  }

  /**
   * Download every note to this device and upload anything changed while
   * offline, a few at a time. Runs on connect and every 10 minutes.
   */
  private bgRunning = false
  async backgroundSync() {
    if (this.bgRunning || !this.socket) return
    this.bgRunning = true
    syncStatus.set({ backgroundSyncing: true })
    try {
      await this.workspace.loaded
      const ids: string[] = []
      getNotes(this.workspace.doc).forEach((_m, id) => ids.push(id))
      const queue = ids.map(noteDocName).filter((n) => !this.handles.has(n))
      const worker = async () => {
        for (let name = queue.shift(); name; name = queue.shift()) {
          if (!this.socket || syncStatus.get().state !== 'online') return
          const { handle, close } = this.open(name)
          try {
            await handle.loaded
            await waitUntil(() => handle.synced, 20_000)
          } catch {
            /* slow or offline – picked up next round */
          } finally {
            close()
            this.destroy(handle)
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
    } finally {
      this.bgRunning = false
      syncStatus.set({ backgroundSyncing: false })
      this.recount()
    }
  }

  /** Force a reconnect attempt right now. */
  reconnect() {
    if (syncStatus.get().state === 'unauthorized') this.configure()
    else this.socket?.connect()
  }
}

function waitUntil(cond: () => boolean, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) resolve()
      else if (Date.now() - start > timeout) reject(new Error('timeout'))
      else setTimeout(tick, 100)
    }
    tick()
  })
}

export const sync = new SyncManager()
