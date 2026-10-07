import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, getStrokes, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { readingScore } from '../src/bench'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let fake: http.Server
let url: string
let readerId: string
let goodId: string
const NOTE = 'notefailproof0000001'
const DRAWING = 'drawingfailproof01'

beforeAll(async () => {
  fake = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body || '{}')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'vision'] }))
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.9.0' }))
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'reader:latest', size: 5 * 1048576 * 1000, size_vram: 5 * 1048576 * 1000 }] }))
    // "reader" misreads, "good" reads it right
    const content = json.model === 'good' ? 'Order safety glasses' : 'Order safty glases'
    res.end(JSON.stringify({ message: { role: 'assistant', content }, done_reason: 'stop', eval_count: 5 }))
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-failproof-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  readerId = app.ai.agents.save({ name: 'Reader', kind: 'ollama', baseUrl: url, model: 'reader' }).id
  goodId = app.ai.agents.save({ name: 'Good', kind: 'ollama', baseUrl: url, model: 'good' }).id
  app.ai.agents.updateSettings({ routing: { ...app.ai.agents.settings().routing, handwriting: [readerId], format: [], compile: [] } })
  await app.sync.change(WORKSPACE_DOC, (ws) => createNote(ws, { id: NOTE, title: 'Supplies' }))
  await app.sync.change(noteDocName(NOTE), (doc) => {
    const d = new Y.XmlElement('drawing')
    d.setAttribute('drawingId', DRAWING)
    getContent(doc).insert(0, [d])
    getStrokes(doc, DRAWING).push([{ id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 90, 40, 0.5] }])
  })
})

beforeEach(() => {
  app.store.db.exec('DELETE FROM ai_readings')
})

afterAll(async () => {
  await app.close()
  fake.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const runJob = async (spec: Record<string, unknown>) => {
  const job = (await api('POST', '/api/jobs', spec)).body.job
  return (await api('GET', `/api/jobs/${job.id}/wait`)).body.job
}

describe('AI health', () => {
  it('reports reachable agents and the models loaded in memory', async () => {
    const h = (await api('GET', '/api/ai/health?fresh=1')).body
    expect(h.status).toBe('ok')
    expect(h.ollama[0]).toMatchObject({ ok: true, version: '0.9.0' })
    expect(h.ollama[0].loaded[0]).toMatchObject({ name: 'reader:latest', vramMb: 5000 })
    expect(h.agents.find((a: any) => a.id === readerId)).toMatchObject({ ok: true, loaded: true })
    expect(h.agents.find((a: any) => a.id === goodId)).toMatchObject({ ok: true, loaded: false })
    expect(h.summary).toContain('reader:latest')
  })

  it('says which agents are unreachable', async () => {
    const down = app.ai.agents.save({ name: 'Offline box', kind: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'x' })
    const h = (await api('GET', '/api/ai/health?fresh=1')).body
    expect(h.status).toBe('degraded')
    expect(h.summary).toContain('Offline box')
    app.ai.agents.remove(down.id)
  })
})

describe('Claude spending limit', () => {
  it('stops using Claude once the month’s limit is reached', async () => {
    const claude = app.ai.agents.save({ name: 'Claude', kind: 'anthropic', apiKey: 'sk-ant-test-123456789', model: 'claude-haiku-4-5', monthlyLimitUsd: 2 })
    app.store.setSetting('claude.spend', { month: new Date().toISOString().slice(0, 7), byAgent: { [claude.id]: 2.5 } })
    const view = (await api('GET', '/api/ai/agents')).body.agents.find((a: any) => a.id === claude.id)
    expect(view).toMatchObject({ monthlyLimitUsd: 2, spentThisMonthUsd: 2.5 })
    const h = (await api('GET', '/api/ai/health?fresh=1')).body
    expect(h.agents.find((a: any) => a.id === claude.id)).toMatchObject({ ok: false, error: 'monthly spending limit reached' })

    const routing = app.ai.agents.settings().routing
    app.ai.agents.updateSettings({ routing: { ...routing, handwriting: [claude.id] } })
    const done = await runJob({ kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })
    expect(done.status).toBe('failed')
    expect(done.error).toContain('monthly spending limit')
    app.ai.agents.updateSettings({ routing })
    app.ai.agents.remove(claude.id)
    app.store.setSetting('claude.spend', null)
  })
})

describe('model test bench', () => {
  it('scores readings', () => {
    expect(readingScore('Order safety glasses', 'Order safety glasses.')).toBe(100)
    expect(readingScore('Order safty glases', 'Order safety glasses')).toBeGreaterThan(80)
    expect(readingScore('', 'Order safety glasses')).toBe(0)
  })

  it('saves a corrected conversion as a sample and ranks the agents on it', async () => {
    const conv = await runJob({ kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })
    expect(conv.status).toBe('done')
    // you correct the converted text, then save it as a sample
    const saved = await api('POST', '/api/ai/samples', { jobId: conv.id })
    expect(saved.status).toBe(201)
    expect(saved.body.sample.truth).toContain('Order safty glases')
    const fixed = await api('PUT', `/api/ai/samples/${saved.body.sample.id}`, { truth: 'Order safety glasses' })
    expect(fixed.body.samples).toHaveLength(1)
    const img = await fetch(`${base}/api/ai/samples/${saved.body.sample.id}/image`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(img.headers.get('content-type')).toBe('image/png')

    const bench = await runJob({ kind: 'benchmark' })
    expect(bench.status).toBe('done')
    const results = bench.result.results
    expect(results.map((r: any) => r.name)).toEqual(['Good', 'Reader'])
    expect(results[0].accuracy).toBe(100)
    expect(results[1].accuracy).toBeLessThan(100)
    expect(bench.result.text).toContain('Good')

    const bad = await api('POST', '/api/ai/samples', { jobId: bench.id })
    expect(bad.status).toBe(400)
    expect((await api('DELETE', `/api/ai/samples/${saved.body.sample.id}`)).body.samples).toHaveLength(0)
  })

  it('explains what to do with no samples', async () => {
    const bench = await runJob({ kind: 'benchmark' })
    expect(bench.status).toBe('failed')
    expect(bench.error).toContain('Save a few test samples')
  })
})
