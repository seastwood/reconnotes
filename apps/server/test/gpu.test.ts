import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry, makeBackend, validateAgent } from '../src/agents'
import { loadConfig } from '../src/config'
import { Store } from '../src/store'

/**
 * A fake Ollama that does what the real one did on an 8 GB card: a model that
 * doesn't fit beside the ones already loaded goes mostly onto the CPU.
 */
let GPU = 7000
const SIZES: Record<string, number> = { 'qwen2.5vl:7b': 5000, 'qwen2.5:3b': 2200, 'nomic-embed-text:latest': 300 }
let loaded: { name: string; size: number; vram: number; ctx: number }[] = []
const loads: { name: string; ctx: number }[] = []
const unloads: string[] = []
let server: http.Server
let url: string
let dir: string
let store: Store

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/ps')
      return res.end(JSON.stringify({ models: loaded.map((m) => ({ name: m.name, size: m.size * 1048576, size_vram: m.vram * 1048576 })) }))
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: Object.entries(SIZES).map(([name, mb]) => ({ name, size: mb * 0.8 * 1048576 })) }))
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
  // what's learned about the GPU is kept in the server's settings
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-gpu-'))
  store = new Store(dir)
  new AgentRegistry(store, loadConfig({ RECON_TOKEN: 'x'.repeat(20), RECON_DATA_DIR: dir }))
})
afterAll(() => {
  server.close()
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  store.setSetting('ollama.gpu', null)
  unloads.length = 0
  loads.length = 0
})

const agent = (model: string) => validateAgent({ name: model, kind: 'ollama', baseUrl: url, model })
const run = (model: string, chars = 100) => makeBackend(agent(model)).generate([{ text: 'x'.repeat(chars) }], 500)
const on = (name: string) => loaded.find((m) => m.name === name)

describe('one model at a time on a small GPU', () => {
  it('a fresh server: the vision model makes way before the text model loads', async () => {
    // what you saw: handwriting left the vision model (and the search model) loaded, then Ask
    GPU = 7000
    loaded = [
      { name: 'qwen2.5vl:7b', size: 5000, vram: 5000, ctx: 8192 },
      { name: 'nomic-embed-text:latest', size: 300, vram: 300, ctx: 2048 },
    ]
    await run('qwen2.5:3b')
    expect(unloads).toEqual(['qwen2.5vl:7b'])
    expect(on('qwen2.5:3b')!.vram).toBe(2200) // all on the GPU
    expect(on('nomic-embed-text:latest')).toBeTruthy() // the small search model stays
  })

  it('a model already squeezed onto the CPU is loaded again with the whole GPU', async () => {
    loaded = [
      { name: 'qwen2.5vl:7b', size: 5000, vram: 5000, ctx: 8192 },
      { name: 'nomic-embed-text:latest', size: 300, vram: 300, ctx: 2048 },
      { name: 'qwen2.5:3b', size: 2200, vram: 103, ctx: 8192 },
    ]
    await run('qwen2.5:3b')
    expect(unloads.sort()).toEqual(['qwen2.5:3b', 'qwen2.5vl:7b'])
    expect(on('qwen2.5:3b')!.vram).toBe(2200)
    // and it's remembered (across restarts too): the GPU is small
    expect(store.getSetting<Record<string, { tight: boolean }>>('ollama.gpu')![url].tight).toBe(true)
    // already fully on the GPU: nothing unloaded
    unloads.length = 0
    await run('qwen2.5:3b')
    expect(unloads).toEqual([])
  })

  it('a big GPU: once both have been seen fitting, nothing is unloaded', async () => {
    GPU = 24000
    loaded = [
      { name: 'qwen2.5vl:7b', size: 5000, vram: 5000, ctx: 8192 },
      { name: 'qwen2.5:3b', size: 2200, vram: 2200, ctx: 8192 },
      { name: 'nomic-embed-text:latest', size: 300, vram: 300, ctx: 2048 },
    ]
    await run('qwen2.5:3b') // learns that 7.5 GB fit
    loaded = loaded.filter((m) => m.name !== 'qwen2.5:3b')
    unloads.length = 0
    await run('qwen2.5:3b')
    expect(unloads).toEqual([])
    expect(on('qwen2.5vl:7b')).toBeTruthy()
    GPU = 7000
  })

  it('keeps the context size a model was loaded with, so it isn’t loaded again', async () => {
    loaded = []
    await run('qwen2.5vl:7b', 40_000) // a long job: bigger context
    await run('qwen2.5vl:7b', 100) // a short one: keeps the bigger one, no reload
    expect(loads).toHaveLength(1)
    expect(loads[0].ctx).toBe(16384)
  })
})
