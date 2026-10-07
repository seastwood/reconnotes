import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, getTranscripts, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string

const para = (t: string) => {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(t)])
  return p
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-where-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  await app.sync.change(WORKSPACE_DOC, (ws) => {
    createNote(ws, { id: 'notewhere0000001', title: 'Pit plan' })
    createNote(ws, { id: 'notewhere0000002', title: 'Groceries' })
  })
  // typed text, then handwriting whose recognised text mentions the breaker
  await app.sync.change(noteDocName('notewhere0000001'), (doc) => {
    const d = new Y.XmlElement('drawing')
    d.setAttribute('drawingId', 'drawingwhere0001')
    getContent(doc).insert(0, [para('Pit plan for Saturday'), d])
    getTranscripts(doc).set('drawingwhere0001', 'Rewire the main breaker before the first match')
  })
  // a checklist
  await app.sync.change(noteDocName('notewhere0000002'), (doc) => {
    const list = new Y.XmlElement('taskList')
    const item = new Y.XmlElement('taskItem')
    item.setAttribute('checked', false as unknown as string)
    item.insert(0, [para('milk and eggs')])
    list.insert(0, [item])
    getContent(doc).insert(0, [list])
  })
  app.sync.hocuspocus.flushPendingStores()
  await new Promise((r) => setTimeout(r, 400))
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const search = async (params: string) => {
  const res = await fetch(`${base}/api/search?${params}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  return (await res.json()).hits as { noteId: string; where?: { kind: string; line: string } }[]
}

describe('where a search matched', () => {
  it('says it was in the handwriting, with the line', async () => {
    const [hit] = await search('q=breaker')
    expect(hit.noteId).toBe('notewhere0000001')
    expect(hit.where).toEqual({ kind: 'handwriting', line: 'Rewire the main breaker before the first match' })
  })
  it('prefers typed text when that matches', async () => {
    const [hit] = await search('q=saturday')
    expect(hit.where?.kind).toBe('text')
  })
})

describe('has:', () => {
  it('finds notes that have handwriting, or a checklist – with or without words', async () => {
    expect((await search('q=&has=handwriting')).map((h) => h.noteId)).toEqual(['notewhere0000001'])
    expect((await search('q=&has=checklist')).map((h) => h.noteId)).toEqual(['notewhere0000002'])
    expect(await search('q=milk&has=handwriting')).toEqual([])
  })
})
