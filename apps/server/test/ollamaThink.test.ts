import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

let app: App
let ollama: http.Server
let dir: string
const chats: { think?: boolean; options: { num_predict: number } }[] = []

beforeAll(async () => {
  // a stand-in for Ollama with a thinking model (qwen3)
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'thinking'], model_info: { 'qwen3.context_length': 40960 } }))
    const json = JSON.parse(body)
    // loading the model (before a request): not a request
    if (json.prompt === '' && !json.messages) return res.end('{}')
    chats.push(json)
    res.end(
      JSON.stringify(
        json.think
          ? { message: { role: 'assistant', thinking: 'R401 permits gaps under 1¼ in…', content: 'Gaps of less than 1 ¼ in. are allowed [1].' }, done_reason: 'stop', eval_count: 900 }
          : { message: { role: 'assistant', content: 'No [1].' }, done_reason: 'stop', eval_count: 3 },
      ),
    )
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-think-'))
  app = createApp(loadConfig({ RECON_TOKEN: 'test-token-0123456789abcdef', RECON_DATA_DIR: dir }), { backups: false })
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('"Let it think" on an Ollama thinking model', () => {
  it('off: asked to answer without thinking', async () => {
    const a = app.ai.agents.save({ name: 'qwen3', kind: 'ollama', baseUrl: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`, model: 'qwen3:8b', vision: false })
    chats.length = 0
    expect((await app.ai.ask('Can a robot have a cutout?')).text).toBe('No [1].')
    expect(chats[0].think).toBe(false)
    app.ai.agents.remove(a.id)
  })
  it('on: it thinks first, with room for it', async () => {
    app.ai.agents.save({ name: 'qwen3 thinking', kind: 'ollama', baseUrl: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`, model: 'qwen3:8b', vision: false, think: true })
    chats.length = 0
    expect((await app.ai.ask('Can a robot have a cutout?')).text).toBe('Gaps of less than 1 ¼ in. are allowed [1].')
    expect(chats[0].think).toBe(true)
    expect(chats[0].options.num_predict).toBeGreaterThan(3000)
  })
  it('meeting notes think even with "Let it think" off – working out what was decided is reasoning', async () => {
    for (const a of app.ai.agents.agents()) app.ai.agents.remove(a.id)
    app.ai.agents.save({ name: 'qwen3', kind: 'ollama', baseUrl: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`, model: 'qwen3:8b', vision: false })
    chats.length = 0
    await app.ai.meetingNotes('', 'We could put the box by the fence. Actually no, put it in the middle of the lot. Yep, done.', 'Friday')
    expect(chats[0].think).toBe(true)
  })
})
