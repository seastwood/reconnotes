import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { GPU_STATS_PORT } from '../src/gpu'

const MB = 1048576
let app: App
let dir: string
const servers: http.Server[] = []
const listen = async (s: http.Server, port = 0) => {
  servers.push(s)
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()))
  return (s.address() as AddressInfo).port
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-gpuhealth-'))
  app = createApp(loadConfig({ RECON_TOKEN: 'test-token-0123456789abcdef', RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
})
afterAll(async () => {
  for (const s of servers) s.close()
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('how full the GPU is', () => {
  it('Ollama’s models as measured, Whisper as what’s left of the GPU’s use – the total from the GPU monitor', async () => {
    const ollama = await listen(
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (req.url === '/api/version') return res.end('{"version":"0.0.0"}')
        if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5940 * MB, size_vram: 5940 * MB }] }))
        res.end('{}')
      }),
    )
    const speaches = await listen(
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(req.url === '/api/ps' ? JSON.stringify({ models: ['silero_vad_v5', 'deepdml/faster-whisper-large-v3-turbo-ct2'] }) : '{"data":[]}')
      }),
    )
    // what deploy/gpu-stats.py answers
    await listen(http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ gpus: [{ index: 0, name: 'NVIDIA GeForce GTX 1070', totalMb: 8192, usedMb: 7540 }] }))), GPU_STATS_PORT)
    app.ai.agents.save({ name: 'Ollama', kind: 'ollama', baseUrl: `http://127.0.0.1:${ollama}`, model: 'qwen3:8b', vision: false })
    app.ai.agents.save({ name: 'Whisper', kind: 'openai', baseUrl: `http://127.0.0.1:${speaches}/v1`, model: 'deepdml/faster-whisper-large-v3-turbo-ct2', vision: false })
    const { aiHealth } = await import('../src/health')
    const h = await aiHealth(app.ai.agents, app.jobs, true)
    expect(h.gpus).toEqual([{ host: '127.0.0.1', name: 'NVIDIA GeForce GTX 1070', totalMb: 8192, usedMb: 7540, otherMb: 0 }])
    const whisper = h.speech.find((m) => m.model.includes('whisper'))!
    const vad = h.speech.find((m) => m.model.includes('vad'))!
    // 7540 used − 5940 Ollama = 1600: the voice detector's small share, Whisper the rest
    expect(whisper.measured).toBe(true)
    expect(vad.mb + whisper.mb).toBe(1600)
    expect(vad.mb).toBeLessThan(100)
  })
})
