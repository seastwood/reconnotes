import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getStrokes, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let ollama: http.Server
let ollamaUrl: string
let deadUrl: string
const chats: { model: string }[] = []

beforeAll(async () => {
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'strike-ocr:latest' }, { name: 'qwen3:8b' }] }))
    if (req.url === '/api/show') {
      const { model } = JSON.parse(body)
      return res.end(JSON.stringify({ capabilities: model.startsWith('qwen') ? ['completion'] : ['completion', 'vision'] }))
    }
    chats.push(JSON.parse(body))
    res.end(JSON.stringify({ message: { content: 'Call the plumber' } }))
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`
  // a port with nothing listening
  const tmp = http.createServer()
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()))
  deadUrl = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}`
  tmp.close()

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-agents-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function drawing(noteId: string, drawingId: string) {
  await app.sync.change(noteDocName(noteId), (doc) => {
    getStrokes(doc, drawingId).push([{ id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 90, 40, 0.5] }])
  })
}

describe('AI agents managed from the app', () => {
  it('starts with no agents and explains how to add one', async () => {
    const { body } = await api('GET', '/api/ai/agents')
    expect(body.agents).toEqual([])
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual(['handwriting', 'format', 'images', 'pdf', 'compile'])
    await drawing('note00000000000000a1', 'drawing000000000a1')
    const r = await api('POST', '/api/ai/handwriting', { noteId: 'note00000000000000a1', drawingId: 'drawing000000000a1' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/Settings › AI agents/)
  })

  it('explains connection problems when testing an agent', async () => {
    const dead = await api('POST', '/api/ai/probe', { kind: 'ollama', baseUrl: deadUrl, model: 'strike-ocr' })
    expect(dead.body.ok).toBe(false)
    expect(dead.body.message).toMatch(/connection refused/)
    expect(dead.body.message).toMatch(/OLLAMA_HOST/)

    const missing = await api('POST', '/api/ai/probe', { kind: 'ollama', baseUrl: ollamaUrl, model: 'llava' })
    expect(missing.body.ok).toBe(false)
    expect(missing.body.message).toMatch(/ollama pull llava/)
    expect(missing.body.models).toContain('strike-ocr:latest')

    const good = await api('POST', '/api/ai/probe', { kind: 'ollama', baseUrl: ollamaUrl, model: 'strike-ocr' })
    expect(good.body.ok).toBe(true)

    const noVision = await api('POST', '/api/ai/probe', { kind: 'ollama', baseUrl: ollamaUrl, model: 'qwen3:8b', vision: true })
    expect(noVision.body.warnings[0]).toMatch(/can't read images/)
  })

  it('fails over to the next agent in priority order', async () => {
    const a = await api('POST', '/api/ai/agents', { name: 'Desk PC', kind: 'ollama', baseUrl: deadUrl, model: 'strike-ocr', timeoutSec: 5 })
    const b = await api('POST', '/api/ai/agents', { name: 'OCR box', kind: 'ollama', baseUrl: ollamaUrl, model: 'strike-ocr:latest' })
    expect(a.status).toBe(201)
    // new agents join the end of the queue for the tasks they can do
    expect(b.body.settings.routing.handwriting).toEqual([a.body.agent.id, b.body.agent.id])
    expect(b.body.settings.routing.pdf).toEqual([])

    const r = await api('POST', '/api/ai/handwriting', { noteId: 'note00000000000000a1', drawingId: 'drawing000000000a1' })
    expect(r.status).toBe(200)
    expect(r.body.text).toBe('Call the plumber')

    const { body } = await api('GET', '/api/ai/agents')
    const desk = body.agents.find((x: { name: string }) => x.name === 'Desk PC')
    expect(desk.status.lastError).toMatch(/connection refused/)
    expect(body.agents.find((x: { name: string }) => x.name === 'OCR box').status.lastOkAt).toBeGreaterThan(0)
  })

  it('respects priority changes and disabled agents', async () => {
    const { body } = await api('GET', '/api/ai/agents')
    const [desk, box] = body.agents
    await api('PUT', '/api/ai/settings', { routing: { handwriting: [box.id, desk.id] } })
    expect(app.ai.agents.chain('handwriting').map((x) => x.name)).toEqual(['OCR box', 'Desk PC'])
    await api('PUT', `/api/ai/agents/${box.id}`, { enabled: false })
    expect(app.ai.agents.chain('handwriting').map((x) => x.name)).toEqual(['Desk PC'])
    const r = await api('POST', '/api/ai/handwriting', { noteId: 'note00000000000000a1', drawingId: 'drawing000000000a1' })
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/Desk PC: connection refused/)
    await api('PUT', `/api/ai/agents/${box.id}`, { enabled: true })
  })

  it('never sends API keys back and keeps them when not re-entered', async () => {
    const c = await api('POST', '/api/ai/agents', { name: 'Claude', kind: 'anthropic', apiKey: 'sk-ant-secret-123456789', model: 'claude-opus-5-5' })
    expect(JSON.stringify(c.body)).not.toContain('sk-ant-secret')
    expect(c.body.agent.hasApiKey).toBe(true)
    expect(c.body.agent.apiKeyHint).toBe('…6789')
    expect(c.body.settings.routing.pdf).toEqual([c.body.agent.id])
    await api('PUT', `/api/ai/agents/${c.body.agent.id}`, { name: 'Claude Opus' })
    expect(app.ai.agents.get(c.body.agent.id)!.apiKey).toBe('sk-ant-secret-123456789')
    await api('DELETE', `/api/ai/agents/${c.body.agent.id}`)
    expect(app.ai.agents.settings().routing.pdf).toEqual([])
  })

  it('rejects invalid agents', async () => {
    const r = await api('POST', '/api/ai/agents', { kind: 'ollama', baseUrl: 'ftp://x', model: 'm' })
    expect(r.status).toBe(400)
  })
})
