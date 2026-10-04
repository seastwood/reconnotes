import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getStrokes, getTranscripts, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { stripThinking } from '../src/ai'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let ollama: http.Server
let base: string
let dir: string
const requests: { model: string; messages: { content: string; images?: string[] }[] }[] = []

beforeAll(async () => {
  // A stand-in for `ollama serve` with an OCR model loaded.
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body)
    requests.push(json)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: { role: 'assistant', content: '<think>reading strokes</think>\nBuy milk' } }))
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-ollama-'))
  app = createApp(
    loadConfig({
      RECON_TOKEN: TOKEN,
      RECON_DATA_DIR: dir,
      RECON_OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
      RECON_OLLAMA_MODEL: 'HSR-DeepThink/strike-ocr:latest',
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

describe('ollama backend', () => {
  it('is imported from RECON_OLLAMA_URL on first start', async () => {
    const h = await fetch(`${base}/api/health`).then((r) => r.json())
    expect(h.ai).toEqual({ handwriting: true, images: true, pdf: false, compile: true })
  })

  it('converts handwriting with the local OCR model', async () => {
    const noteId = 'noteollama0000000001'
    await app.sync.change(noteDocName(noteId), (doc) => {
      getStrokes(doc, 'drawingollama001').push([
        { id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 80, 40, 0.5, 150, 20, 0.5] },
      ])
    })
    const res = await fetch(`${base}/api/ai/handwriting`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId, drawingId: 'drawingollama001' }),
    }).then((r) => r.json())
    expect(res.text).toBe('Buy milk')
    const last = requests.at(-1)!
    expect(last.model).toBe('HSR-DeepThink/strike-ocr:latest')
    expect(last.messages[0].images).toHaveLength(1)
    // The transcript is stored in the note so it syncs and is searchable.
    expect(getTranscripts(app.sync.getDoc(noteDocName(noteId))!).get('drawingollama001')).toBe('Buy milk')
  })

  it('strips reasoning blocks from model output', () => {
    expect(stripThinking('<think>hmm</think>\n# Title')).toBe('# Title')
    expect(stripThinking('partial reasoning</think>answer')).toBe('answer')
  })
})
