import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getStrokes, noteDocName, type Stroke } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let ollama: http.Server
const calls: { model: string; prompt: string; images: number }[] = []
const ocrAnswers = ['Leadership Meeting 9/3/26', 'Sprint goals', '- how?']
let ocrIndex = 0
let tidyAnswer = '```markdown\n# Leadership Meeting 9/3/26\n\n- Sprint goals\n  - how?\n```'

let n = 0
function word(x: number, y: number, letters: number, h = 50): Stroke[] {
  return Array.from({ length: letters }, (_, i) => ({
    id: `w${n++}`,
    tool: 'pen' as const,
    color: '#000',
    size: 3,
    pts: [x + i * 30, y + h, 0.5, x + i * 30 + 10, y - (i % 3 ? 0 : 15), 0.5, x + i * 30 + 20, y + h, 0.5],
  }))
}
const dash = (x: number, y: number): Stroke => ({ id: `d${n++}`, tool: 'pen', color: '#000', size: 3, pts: [x, y + 28, 0.5, x + 25, y + 26, 0.5] })

beforeAll(async () => {
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const j = JSON.parse(body)
    const m = j.messages?.[0] ?? { content: j.prompt, images: j.images }
    calls.push({ model: j.model, prompt: m.content, images: m.images?.length ?? 0 })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const content = j.model === 'tidy' ? tidyAnswer : ocrAnswers[ocrIndex++ % ocrAnswers.length]
    res.end(JSON.stringify(req.url === '/api/generate' ? { response: content, eval_count: 0 } : { message: { content }, eval_count: content ? 5 : 0 }))
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-lines-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  app.ai.agents.save({ name: 'OCR', kind: 'ollama', baseUrl: url, model: 'ocr' }) // reading: auto → line by line
  await app.sync.change(noteDocName('notelines00000000001'), (doc) => {
    getStrokes(doc, 'drawinglines000001').push([...word(70, 60, 10), dash(110, 200), ...word(160, 200, 8), dash(220, 330), ...word(270, 330, 4)])
  })
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const convert = () =>
  fetch(`${base}/api/ai/handwriting`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId: 'notelines00000000001', drawingId: 'drawinglines000001' }),
  }).then((r) => r.json())

describe('line-by-line recognition', () => {
  it('reads each line separately and rebuilds the structure from the strokes', async () => {
    const r = await convert()
    expect(r.text).toBe('Leadership Meeting 9/3/26\n\n- Sprint goals\n  - how?')
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.images === 1 && /single line/.test(c.prompt))).toBe(true)
  })

  it('does not re-read lines that have not changed', async () => {
    calls.length = 0
    await convert()
    expect(calls).toHaveLength(0)
  })

  it('tidies the result with the clean-up agents, sending the text and the image', async () => {
    const tidy = app.ai.agents.save({ name: 'Tidy', kind: 'ollama', baseUrl: app.ai.agents.agents()[0].baseUrl, model: 'tidy', reading: 'page' })
    app.ai.agents.updateSettings({ routing: { ...app.ai.agents.settings().routing, format: [tidy.id], handwriting: [app.ai.agents.agents()[0].id] } })
    calls.length = 0
    const r = await convert()
    expect(r.text).toBe('# Leadership Meeting 9/3/26\n\n- Sprint goals\n  - how?') // fence removed
    expect(calls).toHaveLength(1) // OCR lines came from cache
    expect(calls[0].model).toBe('tidy')
    expect(calls[0].images).toBe(1)
    expect(calls[0].prompt).toMatch(/- Sprint goals\n  - how\?/)
  })

  it('keeps the recognised text if the clean-up agent fails', async () => {
    tidyAnswer = ''
    const r = await convert()
    expect(r.text).toBe('Leadership Meeting 9/3/26\n\n- Sprint goals\n  - how?')
  })
})
