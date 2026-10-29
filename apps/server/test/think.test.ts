import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, noteDocName } from '@reconnotes/core'
import { askNotes } from '../src/ask'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

let app: App
let ollama: http.Server
let dir: string
/** each chat request: whether it was asked to think, and how many tokens it may write */
const asked: { think?: boolean; room: number }[] = []

beforeAll(async () => {
  // a thinking model on Ollama (qwen3)
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'thinking'], model_info: { 'qwen3.context_length': 40960 } }))
    if (req.url !== '/api/chat') return res.end(JSON.stringify({ models: [], response: '' }))
    const j = JSON.parse(body)
    asked.push({ think: j.think, room: j.options.num_predict })
    const reply = { message: { content: 'Yes, gaps are permissible [1].', ...(j.think ? { thinking: 'R12 says gaps are permissible.' } : {}) }, done: true, done_reason: 'stop', eval_count: 30 }
    if (!j.stream) return res.end(JSON.stringify(reply))
    res.end(JSON.stringify(reply) + '\n')
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-think-'))
  app = createApp(
    loadConfig({
      RECON_TOKEN: 'test-token-0123456789abcdef',
      RECON_DATA_DIR: dir,
      RECON_OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
      RECON_OLLAMA_MODEL: 'qwen3:8b',
      RECON_AUTO_HANDWRITING: 'false',
    }),
    { backups: false },
  )
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('thinking for questions that need it', () => {
  it('a reasoning question thinks first (a bounded amount); a lookup answers straight away', async () => {
    const id = 'thinknote00001'
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: 'Rules' }))
    await app.sync.change(noteDocName(id), (doc) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('R12. BUMPERS are required. Gaps in the bumpers and frame perimeter are permissible. R01. The ROBOT must be no taller than 60 in.')])
      getContent(doc).insert(0, [p])
    })
    asked.length = 0
    await askNotes(app.store, app.sync, app.ai, 'can the bumper perimeter have gaps in it?', null, {}, { notes: [id] })
    expect(asked[0].think).toBe(true)
    // the answer's room and the thinking's, not the 3072 of "Let it think"
    expect(asked[0].room).toBe(1000 + 1200)
    asked.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the max height of the robot?', null, {}, { notes: [id] })
    expect(asked[0].think).toBe(false)
  })
})
