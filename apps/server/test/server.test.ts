import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import {
  WORKSPACE_DOC,
  createNote,
  extractNote,
  getContent,
  getStrokes,
  getTranscripts,
  noteDocName,
} from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { runBackup } from '../src/backup'
import { toFtsQuery } from '../src/store'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let wsUrl: string
let dir: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-'))
  const config = loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_BACKUP_INTERVAL_HOURS: '0' })
  app = createApp(config, { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  const port = (app.server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/sync`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const auth = { Authorization: `Bearer ${TOKEN}` }

function connect(name: string, doc: Y.Doc, token = TOKEN) {
  const socket = new HocuspocusProviderWebsocket({ url: wsUrl })
  const provider = new HocuspocusProvider({ websocketProvider: socket, name, document: doc, token })
  provider.attach()
  return { provider, socket }
}

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function para(text: string) {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  return p
}

describe('http api', () => {
  it('reports health without auth and rejects requests without a token', async () => {
    const h = await fetch(`${base}/api/health`).then((r) => r.json())
    expect(h.ok).toBe(true)
    expect((await fetch(`${base}/api/auth/check`)).status).toBe(401)
    expect((await fetch(`${base}/api/auth/check`, { headers: auth })).status).toBe(200)
  })

  it('builds safe FTS queries', () => {
    expect(toFtsQuery('meet "john" OR -x')).toBe('"meet"* "john"* "OR"* "x"*')
  })
})

describe('sync', () => {
  it('rejects a device with the wrong token', async () => {
    let failed = false
    const doc = new Y.Doc()
    const socket = new HocuspocusProviderWebsocket({ url: wsUrl })
    const p = new HocuspocusProvider({
      websocketProvider: socket,
      name: WORKSPACE_DOC,
      document: doc,
      token: 'wrong-token-wrong-token',
      onAuthenticationFailed: () => {
        failed = true
      },
    })
    p.attach()
    await waitFor(() => failed)
    p.destroy()
    socket.destroy()
  })

  it('merges edits two devices made offline to the same note', async () => {
    // Device 1 creates a note and syncs it.
    const ws1 = new Y.Doc()
    const noteId = createNote(ws1)
    const iphone = new Y.Doc()
    getContent(iphone).insert(0, [para('Meeting notes')])
    const a = connect(noteDocName(noteId), iphone)
    const aw = connect(WORKSPACE_DOC, ws1)
    await waitFor(() => a.provider.isSynced && aw.provider.isSynced && a.provider.unsyncedChanges === 0)

    // Device 2 syncs the note, then both go offline.
    const ipad = new Y.Doc()
    const b = connect(noteDocName(noteId), ipad)
    await waitFor(() => extractNote(ipad).text === 'Meeting notes')
    a.provider.destroy()
    a.socket.destroy()
    b.provider.destroy()
    b.socket.destroy()

    // Offline edits on both devices, including ink in the same drawing.
    getContent(iphone).insert(1, [para('typed on the iPhone')])
    getContent(ipad).insert(1, [para('typed on the iPad')])
    getStrokes(iphone, 'drawing1').push([{ id: 's1', tool: 'pen', color: '#000', size: 3, pts: [0, 0, 0.5] }])
    getStrokes(ipad, 'drawing1').push([{ id: 's2', tool: 'pen', color: '#f00', size: 3, pts: [5, 5, 0.5] }])

    // Both reconnect at the same time.
    const a2 = connect(noteDocName(noteId), iphone)
    const b2 = connect(noteDocName(noteId), ipad)
    await waitFor(() => extractNote(iphone).text === extractNote(ipad).text && getStrokes(ipad, 'drawing1').length === 2)
    const text = extractNote(iphone).text
    expect(text).toContain('typed on the iPhone')
    expect(text).toContain('typed on the iPad')
    expect(text.split('\n')[0]).toBe('Meeting notes')
    expect(getStrokes(iphone, 'drawing1').length).toBe(2)

    // The server persisted the merged note and indexed it for search.
    await waitFor(() => a2.provider.unsyncedChanges === 0 && b2.provider.unsyncedChanges === 0)
    app.sync.hocuspocus.flushPendingStores()
    await waitFor(() => app.store.search('iPad').length > 0)
    const res = await fetch(`${base}/api/search?q=typed%20ipho`, { headers: auth }).then((r) => r.json())
    expect(res.hits.map((h: { noteId: string }) => h.noteId)).toContain(noteId)

    for (const c of [a2, b2, aw]) {
      c.provider.destroy()
      c.socket.destroy()
    }
  })
})

describe('attachments', () => {
  it('stores, serves and indexes text from an attachment', async () => {
    const id = 'att0000000000000000001'
    const put = await fetch(`${base}/api/attachments/${id}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('recipe.txt') },
      body: 'Grandma pancake recipe: flour, eggs, buttermilk',
    })
    expect(put.status).toBe(201)
    const got = await fetch(`${base}/api/attachments/${id}`, { headers: auth })
    expect(await got.text()).toContain('buttermilk')

    // A note referencing the attachment becomes searchable by its contents,
    // and the text is copied into the note so offline search finds it too.
    const noteId = 'note0000000000000000001'
    await app.sync.change(noteDocName(noteId), (doc) => {
      const file = new Y.XmlElement('file')
      file.setAttribute('attachmentId', id)
      file.setAttribute('name', 'recipe.txt')
      getContent(doc).insert(0, [para('Breakfast ideas'), file])
    })
    app.sync.hocuspocus.flushPendingStores()
    await waitFor(() => app.store.search('buttermilk').some((h) => h.noteId === noteId))
    await waitFor(() => Boolean(getTranscripts(app.sync.getDoc(noteDocName(noteId))!).get(`att:${id}`)))
  })
})

describe('backups', () => {
  it('writes a database copy and a markdown export', async () => {
    const out = await runBackup(app.config, app.store, app.sync)
    expect(fs.existsSync(path.join(out, 'reconnotes.db'))).toBe(true)
    const md = fs.readdirSync(path.join(out, 'markdown'))
    expect(md.some((f) => f.startsWith('Meeting notes'))).toBe(true)
  })
})

describe('handwriting rendering', () => {
  it('rasterises a drawing for recognition, cropped to the ink', async () => {
    const { renderDrawingPng } = await import('../src/ai')
    const png = renderDrawingPng([
      { id: 'a', tool: 'pen', color: '#000000', size: 4, pts: [100, 100, 0.5, 200, 150, 0.6, 300, 120, 0.4] },
    ])!
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(renderDrawingPng([])).toBeNull()
  })
})
