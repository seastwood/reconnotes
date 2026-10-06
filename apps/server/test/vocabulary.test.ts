import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, getStrokes, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { corrections, guessedWords } from '../src/vocabulary'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let fake: http.Server
const prompts: { model: string; prompt: string }[] = []
const NOTE = 'notevocab00000000001'
const DRAWING = 'drawingvocab000001'

beforeAll(async () => {
  fake = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body || '{}')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'vision'] }))
    const prompt: string = json.messages?.[0]?.content ?? json.prompt ?? ''
    prompts.push({ model: json.model, prompt })
    // the reader misreads a name; the text model fixes it
    const content = json.model === 'reader' ? 'Klay picked Leutenant' : 'Klay picked Lieutenant'
    res.end(JSON.stringify({ message: { role: 'assistant', content }, done_reason: 'stop', eval_count: 5 }))
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-vocab-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const reader = app.ai.agents.save({ name: 'Reader', kind: 'ollama', baseUrl: url, model: 'reader' })
  const writer = app.ai.agents.save({ name: 'Writer', kind: 'ollama', baseUrl: url, model: 'writer', vision: false })
  app.ai.agents.updateSettings({ routing: { ...app.ai.agents.settings().routing, handwriting: [reader.id], format: [writer.id], compile: [writer.id] } })
  await app.sync.change(WORKSPACE_DOC, (ws) => createNote(ws, { id: NOTE, title: 'Teams' }))
  await app.sync.change(noteDocName(NOTE), (doc) => {
    const d = new Y.XmlElement('drawing')
    d.setAttribute('drawingId', DRAWING)
    getContent(doc).insert(0, [d])
    getStrokes(doc, DRAWING).push([{ id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 90, 40, 0.5] }])
  })
})

afterAll(async () => {
  await app.close()
  fake.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return (await res.json()) as Record<string, any>
}

describe('corrections', () => {
  it('finds misread words you fixed, not rewording', () => {
    expect(corrections('Make decision on Leutenant today', 'Make decision on Lieutenant today')).toEqual([{ from: 'Leutenant', to: 'Lieutenant' }])
    expect(corrections('Make decision on Leu tenant today', 'Make decision on Lieutenant today')).toEqual([{ from: 'Leu tenant', to: 'Lieutenant' }])
    expect(corrections('Buy milk today', 'Buy bread today')).toEqual([]) // a different word, not a misreading
    expect(corrections('Buy milk', 'Buy milk and eggs')).toEqual([])
  })
  it('lists the words the clean-up changed', () => {
    expect([...guessedWords('Klay picked Leutenant', 'Klay picked Lieutenant')]).toEqual(['Lieutenant'])
  })
})

describe('your words', () => {
  it('marks words the clean-up guessed, learns your corrections and tells the AI', async () => {
    const job = (await api('POST', '/api/jobs', { kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })).job
    const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
    expect(done.status).toBe('done')
    // "Lieutenant" was changed by the clean-up: it carries the uncertain mark
    const doc = app.sync.getDoc(noteDocName(NOTE))!
    const para = getContent(doc).get(1) as Y.XmlElement
    const delta = para.toArray().flatMap((t) => (t as Y.XmlText).toDelta()) as { insert: string; attributes?: Record<string, unknown> }[]
    expect(delta.find((d) => d.insert === 'Lieutenant')?.attributes).toEqual({ uncertain: {} })
    expect(delta.find((d) => d.insert.includes('Klay'))?.attributes).toBeUndefined()

    // you correct the name in the note
    await app.sync.change(noteDocName(NOTE), (d) => {
      const t = (getContent(d).get(1) as Y.XmlElement).get(0) as Y.XmlText
      t.delete(0, 4)
      t.insert(0, 'Klai')
    })
    app.sync.indexNote(NOTE, app.sync.getDoc(noteDocName(NOTE))!)
    const vocab = await api('GET', '/api/ai/vocabulary')
    expect(vocab.learned.map((l: { from: string; to: string }) => `${l.from}→${l.to}`)).toEqual(['Klay→Klai'])

    // your own words, and the learned one, go to the next reading and clean-up
    await api('PUT', '/api/ai/vocabulary', { words: ['Sophie', 'Doug'] })
    app.store.db.exec('DELETE FROM ai_readings')
    prompts.length = 0
    const again = (await api('POST', `/api/jobs/${done.id}/redo`, {})).job
    await api('GET', `/api/jobs/${again.id}/wait`)
    const reading = prompts.find((p) => p.model === 'reader')!.prompt
    const tidy = prompts.find((p) => p.model === 'writer')!.prompt
    for (const p of [reading, tidy]) {
      expect(p).toMatch(/Sophie, Doug, Klai/)
      expect(p).toMatch(/Klay → Klai/)
    }
    // and you can forget a learned correction
    expect((await api('POST', '/api/ai/vocabulary/forget', { from: 'Klay', to: 'Klai' })).learned).toEqual([])
  })
})
