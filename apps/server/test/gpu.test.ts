import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeBackend, validateAgent } from '../src/agents'

/**
 * A fake Ollama on an 8 GB GPU that does what the real one did: a model that
 * doesn't fit beside the ones already loaded goes mostly onto the CPU.
 */
const GPU = 8000
const SIZES: Record<string, number> = { 'qwen2.5vl:7b': 5000, 'qwen2.5:3b': 2400, 'nomic-embed-text:latest': 300 }
let loaded: { name: string; size: number; vram: number; ctx: number }[] = []
const loads: { name: string; ctx: number }[] = []
const unloads: string[] = []
let server: http.Server
let url: string

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/ps')
      return res.end(JSON.stringify({ models: loaded.map((m) => ({ name: m.name, size: m.size * 1048576, size_vram: m.vram * 1048576 })) }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }))
    if (req.url === '/api/generate' && body.keep_alive === 0) {
      unloads.push(body.model)
      loaded = loaded.filter((m) => m.name !== body.model)
      return res.end('{}')
    }
    // a request: load the model (again, if its context size changed)
    const ctx = body.options?.num_ctx ?? 2048
    const have = loaded.find((m) => m.name === body.model)
    if (!have || have.ctx !== ctx) {
      loaded = loaded.filter((m) => m.name !== body.model)
      const used = loaded.reduce((a, m) => a + m.vram, 0)
      const size = SIZES[body.model] ?? 1000
      loaded.push({ name: body.model, size, vram: Math.max(0, Math.min(size, GPU - used)), ctx })
      loads.push({ name: body.model, ctx })
    }
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done_reason: 'stop', eval_count: 1 }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const agent = (model: string) => validateAgent({ name: model, kind: 'ollama', baseUrl: url, model })
const run = (model: string, chars = 100) => makeBackend(agent(model)).generate([{ text: 'x'.repeat(chars) }], 500)

describe('one model at a time on a small GPU', () => {
  it('unloads the other model once one has been squeezed onto the CPU', async () => {
    // what Jobs showed: the vision model holding the GPU, the text model mostly on the CPU
    loaded = [
      { name: 'qwen2.5vl:7b', size: 5000, vram: 5000, ctx: 8192 },
      { name: 'nomic-embed-text:latest', size: 300, vram: 300, ctx: 2048 },
      { name: 'qwen2.5:3b', size: 2400, vram: 400, ctx: 8192 },
    ]
    unloads.length = 0
    // next job: the vision model goes, the half-loaded text model loads again fully; the embedder stays
    await run('qwen2.5:3b')
    expect(unloads.sort()).toEqual(['qwen2.5:3b', 'qwen2.5vl:7b'])
    const text = loaded.find((m) => m.name === 'qwen2.5:3b')!
    expect(text.vram).toBe(text.size)
    expect(loaded.map((m) => m.name)).toContain('nomic-embed-text:latest')

    // then handwriting: the text model makes way for the vision model
    unloads.length = 0
    await run('qwen2.5vl:7b')
    expect(unloads).toEqual(['qwen2.5:3b'])
    expect(loaded.find((m) => m.name === 'qwen2.5vl:7b')!.vram).toBe(5000)
    // already fully on the GPU: nothing unloaded
    unloads.length = 0
    await run('qwen2.5vl:7b')
    expect(unloads).toEqual([])
  })

  it('keeps the context size a model was loaded with, so it isn’t loaded again', async () => {
    loads.length = 0
    await run('qwen2.5vl:7b', 40_000) // a long job: bigger context
    await run('qwen2.5vl:7b', 100) // a short one: keeps the bigger one, no reload
    expect(loads).toHaveLength(1)
    expect(loads[0].ctx).toBe(16384)
  })
})
