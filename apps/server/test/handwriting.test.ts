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
const requests: { think?: boolean; url?: string }[] = []

beforeAll(async () => {
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body || '{}')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/show') {
      // what Ollama says about a model: "qwen3-vl" models say they think
      const thinks = /qwen3-vl/.test(json.model)
      return res.end(JSON.stringify({ capabilities: ['completion', 'vision', ...(thinks ? ['thinking'] : [])], model_info: { 'qwen3vl.context_length': 262144 } }))
    }
    requests.push({ ...json, url: req.url })
    const isGenerate = req.url === '/api/generate'
    const prompt: string = isGenerate ? json.prompt : json.messages?.[0]?.content ?? ''
    const reply = (content: string, thinking = '', evalCount = content ? 5 : 0) =>
      res.end(
        JSON.stringify(
          isGenerate
            ? { response: content, thinking, done_reason: 'stop', eval_count: evalCount }
            : { message: { role: 'assistant', content, thinking }, done_reason: 'stop', eval_count: evalCount },
        ),
      )
    switch (mode) {
      case 'answer':
        return reply('Buy milk')
      case 'empty':
        return reply('')
      case 'think-only':
        return isGenerate ? reply('') : reply('', 'I see strokes that might be letters', 40)
      case 'think-then-answer':
        return json.think === false ? reply('Buy milk') : reply('', 'Let me look at this image carefully', 40)
      case 'generate-only':
        return isGenerate ? reply('Buy milk') : reply('')
      case 'think-long':
        // reasons until it hits the limit, unless asked not to think
        return /\/no_think$/.test(prompt) && json.options?.num_predict >= 2048
          ? reply('Buy milk')
          : res.end(JSON.stringify({ message: { content: '', thinking: 'Got it, let me look carefully…' }, done_reason: 'length', eval_count: 527 }))
      case 'thinker':
        // a thinking model that ignores think:false and needs ~3000 tokens of reasoning
        if (json.think === true && json.options?.num_predict >= 3500)
          return res.end(JSON.stringify({ message: { content: 'Buy milk', thinking: 'Long careful look…' }, done_reason: 'stop', eval_count: 3100 }))
        return res.end(JSON.stringify({ message: { content: '<think>Okay, let me tackle this…', thinking: '' }, done_reason: 'length', eval_count: json.options?.num_predict ?? 0 }))
      case 'endless-thinker':
        return res.end(JSON.stringify({ message: { content: '', thinking: 'Okay, let me tackle this query…' }, done_reason: 'length', eval_count: json.options?.num_predict ?? 0 }))
      case 'short-prompt':
        return prompt.length < 80 ? reply('Buy milk') : reply('', '', 3)
    }
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
    expect(r.body.error).toMatch(/reasoning only/)
    expect(r.body.error).toMatch(/strokes that might be letters/)
  })

  it('falls back to the plain generate endpoint', async () => {
    mode = 'generate-only'
    requests.length = 0
    const r = await convert()
    expect(r.body).toEqual({ text: 'Buy milk', agent: 'OCR' })
    expect(requests.map((q) => q.url)).toEqual(['/api/chat', '/api/generate'])
  })

  it('falls back to a minimal prompt for OCR models that ignore long ones', async () => {
    mode = 'short-prompt'
    const r = await convert()
    expect(r.status).toBe(200)
    expect(r.body.text).toBe('Buy milk')
  })

  it('reports what the model did and hints at missing vision support', async () => {
    mode = 'empty'
    const r = await convert()
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/OCR: .*returned no text/)
    expect(r.body.error).toMatch(/0 tokens/)
    expect(r.body.error).toMatch(/ollama show strike-ocr/)
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

describe('testing an agent with a sample word', () => {
  it('reports whether the agent read the sample correctly', async () => {
    mode = 'answer' // the fake model always says "Buy milk"
    const agent = app.ai.agents.agents()[0]
    const res = await fetch(`${base}/api/ai/try-handwriting`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agent.id }),
    }).then((r) => r.json())
    expect(res.ok).toBe(false)
    expect(res.text).toBe('Buy milk')
    expect(res.message).toMatch(/HELLO/)
  })
})

describe('converting a picture to text', () => {
  it('runs a pasted photo through the handwriting agents with a photo prompt', async () => {
    mode = 'answer'
    requests.length = 0
    const { sampleHandwritingPng } = await import('../src/ai')
    const res = await fetch(`${base}/api/ai/image-to-text`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
      body: new Uint8Array(sampleHandwritingPng()),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'Buy milk', agent: 'OCR' })
    const sent = requests[0] as unknown as { messages: { content: string; images: string[] }[] }
    expect(sent.messages[0].content).toMatch(/handwritten and printed/)
    expect(sent.messages[0].images).toHaveLength(1)
  })

  it('rejects files that are not images', async () => {
    const res = await fetch(`${base}/api/ai/image-to-text`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/pdf' },
      body: 'x',
    })
    expect(res.status).toBe(415)
  })
})

describe('compiling a note with pictures', () => {
  it('has a local model compile text: drawings and pictures are read first, in reading order', async () => {
    mode = 'answer'
    const noteId = 'notehwcompile0000001'
    // an uploaded picture
    const { sampleHandwritingPng } = await import('../src/ai')
    const put = await fetch(`${base}/api/attachments/attcompile000000001`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
      body: new Uint8Array(sampleHandwritingPng()),
    })
    expect(put.status).toBe(201)
    const Y = await import('yjs')
    const { getContent } = await import('@reconnotes/core')
    await app.sync.change(noteDocName(noteId), (doc) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('Meeting notes')])
      const d = new Y.XmlElement('drawing')
      d.setAttribute('drawingId', 'drawinghw000000001')
      const img = new Y.XmlElement('image')
      img.setAttribute('attachmentId', 'attcompile000000001')
      getContent(doc).insert(0, [p, d, img])
      getStrokes(doc, 'drawinghw000000001').push([{ id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 90, 40, 0.5] }])
    })
    app.ai.agents.updateSettings({ routing: { ...app.ai.agents.settings().routing, compile: app.ai.agents.agents().map((a) => a.id) } })
    requests.length = 0
    const res = await fetch(`${base}/api/ai/compile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId }),
    })
    expect(res.status).toBe(200)
    const sent = requests as unknown as { messages?: { content: string; images?: string[] }[] }[]
    const last = sent[sent.length - 1].messages![0]
    expect(last.images ?? []).toHaveLength(0) // the compile request itself is text only
    expect(last.content).toMatch(/Meeting notes[\s\S]*\[handwritten section\][\s\S]*Buy milk[\s\S]*\[picture, transcribed\]/)
    // the drawing and the picture were each read before that
    expect(sent.slice(0, -1).filter((r) => r.messages?.[0].images?.length).length).toBeGreaterThanOrEqual(2)
  })
})

describe('thinking models', () => {
  const useModel = (model: string) => {
    const a = app.ai.agents.agents().find((x) => x.name === 'OCR')!
    app.ai.agents.save({ ...a, model })
  }

  it('asks a thinking model for the answer straight away, then gives it room to think, with a context that fits', async () => {
    useModel('qwen3-vl:4b')
    mode = 'thinker'
    requests.length = 0
    try {
      const r = await convert()
      expect(r.status).toBe(200)
      expect(r.body.text).toBe('Buy milk')
      const sent = requests as unknown as { think?: boolean; options: { num_predict: number; num_ctx: number } }[]
      expect(sent[0].think).toBe(false)
      expect(sent[1].think).toBe(true)
      expect(sent[1].options.num_predict).toBeGreaterThan(sent[0].options.num_predict)
      expect(sent[1].options.num_ctx).toBeGreaterThanOrEqual(sent[1].options.num_predict + 1500)
    } finally {
      useModel('strike-ocr')
    }
  })

  it('explains a thinking model that never gets to an answer', async () => {
    useModel('qwen3-vl:4b')
    mode = 'endless-thinker'
    try {
      const r = await convert()
      expect(r.status).toBe(502)
      expect(r.body.error).toMatch(/thinking model/)
      expect(r.body.error).toMatch(/qwen3-vl:4b-instruct/)
      // gave up once it couldn't finish even with room to think – no more attempts, no second prompt
      expect(r.body.error).not.toMatch(/generate:|prompt 2/)
    } finally {
      useModel('strike-ocr')
    }
  })
})

describe('thinking models that run out of room', () => {
  it('retries with /no_think and a bigger budget', async () => {
    mode = 'think-long'
    requests.length = 0
    const r = await convert()
    expect(r.status).toBe(200)
    expect(r.body.text).toBe('Buy milk')
    const retry = requests[1] as unknown as { think?: boolean; options: { num_predict: number }; messages: { content: string }[] }
    expect(retry.think).toBe(false)
    expect(retry.options.num_predict).toBeGreaterThanOrEqual(2048)
    expect(retry.messages[0].content).toMatch(/\/no_think$/)
  })
})
