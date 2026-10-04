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
/** how the fake model behaves: 'think-then-answer' | 'think-only' | 'empty' | 'answer' */
let mode = 'answer'
const requests: { think?: boolean }[] = []

beforeAll(async () => {
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body || '{}')
    requests.push(json)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const reply = (content: string, thinking = '') => res.end(JSON.stringify({ message: { role: 'assistant', content, thinking } }))
    if (mode === 'answer') return reply('Buy milk')
    if (mode === 'empty') return reply('')
    if (mode === 'think-only') return reply('', 'I see strokes that might be letters')
    // think-then-answer: reasoning only unless thinking is switched off
    return json.think === false ? reply('Buy milk') : reply('', 'Let me look at this image carefully')
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-hw-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  app.ai.agents.save({ name: 'OCR', kind: 'ollama', baseUrl: ollamaUrl, model: 'strike-ocr' })
  await app.sync.change(noteDocName('notehw00000000000001'), (doc) => {
    getStrokes(doc, 'drawinghw000000001').push([{ id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 90, 40, 0.5] }])
  })
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const convert = async (drawingId = 'drawinghw000000001') => {
  const res = await fetch(`${base}/api/ai/handwriting`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId: 'notehw00000000000001', drawingId }),
  })
  return { status: res.status, body: await res.json() }
}

describe('handwriting conversion troubleshooting', () => {
  it('retries a reasoning-only reply with thinking switched off', async () => {
    mode = 'think-then-answer'
    requests.length = 0
    const r = await convert()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ text: 'Buy milk', agent: 'OCR' })
    expect(requests.map((q) => q.think)).toEqual([undefined, false])
  })

  it('explains when the model only reasons and never answers', async () => {
    mode = 'think-only'
    const r = await convert()
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/only produced reasoning/)
    expect(r.body.error).toMatch(/strokes that might be letters/)
  })

  it('treats an empty reply to an explicit conversion as a failure with advice', async () => {
    mode = 'empty'
    const r = await convert()
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/OCR: returned no text/)
    expect(r.body.error).toMatch(/Handwriting prompt/)
  })

  it('says so when the drawing has no ink on the server', async () => {
    mode = 'answer'
    const r = await convert('drawinghwempty0001')
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/no ink on the server/)
  })

  it('serves the exact image sent to the AI', async () => {
    const res = await fetch(`${base}/api/ai/drawing-image?noteId=notehw00000000000001&drawingId=drawinghw000000001&token=${TOKEN}`)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG')
  })
})
