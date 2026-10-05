import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractNote, getContent, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { maybeSnapshot, prune } from '../src/versions'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-versions-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}` } })
  return { status: res.status, body: await res.json() }
}

function setText(doc: Y.Doc, ...lines: string[]) {
  const c = getContent(doc)
  doc.transact(() => {
    if (c.length) c.delete(0, c.length)
    c.insert(
      0,
      lines.map((t) => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText(t)])
        return p
      }),
    )
  })
}

describe('version history', () => {
  it('snapshots at most every 10 minutes, and only when the note changed', () => {
    const name = noteDocName('vers0000000001')
    const doc = new Y.Doc()
    const t0 = Date.now()
    maybeSnapshot(app.store, name, doc, t0) // empty: nothing to keep
    expect(app.store.listVersions(name)).toHaveLength(0)
    setText(doc, 'Plan A')
    maybeSnapshot(app.store, name, doc, t0)
    setText(doc, 'Plan B')
    maybeSnapshot(app.store, name, doc, t0 + 5 * 60_000) // too soon
    maybeSnapshot(app.store, name, doc, t0 + 11 * 60_000)
    maybeSnapshot(app.store, name, doc, t0 + 25 * 60_000) // unchanged
    expect(app.store.listVersions(name).map((v) => v.title)).toEqual(['Plan B', 'Plan A'])
  })

  it('thins out old versions', () => {
    const name = noteDocName('vers0000000002')
    const doc = new Y.Doc()
    setText(doc, 'x')
    const state = Y.encodeStateAsUpdate(doc)
    const now = Date.now()
    const H = 3_600_000
    // every 10 minutes for 10 days
    for (let t = now - 10 * 24 * H; t <= now; t += 10 * 60_000) app.store.addVersion(name, { createdAt: t, title: 'x', chars: 1, state })
    prune(app.store, name, now)
    const left = app.store.listVersions(name)
    const lastDay = left.filter((v) => now - v.createdAt <= 24 * H).length
    expect(lastDay).toBeGreaterThanOrEqual(144) // all of the last day kept
    const week = left.filter((v) => now - v.createdAt > 24 * H && now - v.createdAt <= 7 * 24 * H).length
    const older = left.filter((v) => now - v.createdAt > 7 * 24 * H).length
    expect(week).toBeLessThanOrEqual(6 * 24 + 1) // one per hour
    expect(older).toBeLessThanOrEqual(4) // one per day
  })

  it('restores an old version through the API, keeping the current one', async () => {
    const id = 'vers0000000003'
    const name = noteDocName(id)
    await app.sync.change(name, (doc) => setText(doc, 'Shopping', 'milk', 'eggs'))
    const old = app.sync.getDoc(name)!
    app.store.addVersion(name, { createdAt: Date.now() - 3_600_000, title: 'Shopping', chars: 18, state: Y.encodeStateAsUpdate(old) })
    await app.sync.change(name, (doc) => setText(doc, 'Shopping', 'bread'))

    const list = await api('GET', `/api/notes/${id}/versions`)
    const target = list.body.versions.find((v: { title: string }) => v.title === 'Shopping')
    const preview = await api('GET', `/api/notes/${id}/versions/${target.id}`)
    expect(preview.body.markdown).toContain('eggs')

    const r = await api('POST', `/api/notes/${id}/versions/${target.id}/restore`)
    expect(r.status).toBe(200)
    expect(extractNote(app.sync.getDoc(name)!).text).toBe('Shopping\nmilk\neggs')
    const after = await api('GET', `/api/notes/${id}/versions`)
    expect(after.body.versions[0].label).toBe('Before restoring')
  })
})
