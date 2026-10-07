import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let ollama: http.Server
let base: string
let dir: string
const streamed: boolean[] = []

beforeAll(async () => {
  // Ollama, writing its answer a few words at a time
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }))
    if (req.url !== '/api/chat') return res.end(JSON.stringify({ models: [], response: '' }))
    const j = JSON.parse(body)
    streamed.push(Boolean(j.stream))
    const words = ['You need ', 'to buy ', 'milk [1].']
    if (!j.stream) return res.end(JSON.stringify({ message: { content: words.join('') }, done: true }))
    for (const w of words) {
      res.write(JSON.stringify({ message: { content: w }, done: false }) + '\n')
      await new Promise((r) => setTimeout(r, 600))
    }
    res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', eval_count: 9 }) + '\n')
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-stream-'))
  app = createApp(
    loadConfig({
      RECON_TOKEN: TOKEN,
      RECON_DATA_DIR: dir,
      RECON_OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
      RECON_OLLAMA_MODEL: 'qwen2.5:3b',
      RECON_AUTO_HANDWRITING: 'false',
    }),
    { backups: false },
  )
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) =>
  (await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json())) as { job: { id: string; status: string; partial: { answer: string; sources: { n: number }[] } | null; result: { answer: string } | null } }

describe('streaming answers', () => {
  it('shows the answer while it is being written', async () => {
    const id = 'notestream000000001'
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: 'Shopping' }))
    await app.sync.change(noteDocName(id), (doc) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('Buy milk on the way home')])
      getContent(doc).insert(0, [p])
    })
    const { job } = await api('POST', '/api/jobs', { kind: 'ask', input: { question: 'what do I need to buy?' } })
    const seen: string[] = []
    for (let i = 0; i < 40; i++) {
      const j = (await api('GET', `/api/jobs/${job.id}`)).job
      if (j.partial?.answer && seen.at(-1) !== j.partial.answer) {
        seen.push(j.partial.answer)
        expect(j.partial.sources.map((s) => s.n)).toContain(1)
      }
      if (j.status === 'done') {
        expect(j.partial).toBeNull()
        expect(j.result?.answer).toContain('You need to buy milk [1].')
        break
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    expect(streamed).toContain(true)
    // it grew: a part of the answer first, more later
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[0].length).toBeLessThan(seen.at(-1)!.length)
  })
})
