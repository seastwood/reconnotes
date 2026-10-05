import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { parseWyomingUri, readWav } from '../src/wyoming'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let wyoming: net.Server
let wyomingUri: string
/** what the fake server received per connection */
const sessions: { types: string[]; audioBytes: number; format?: Record<string, unknown> }[] = []

/** Write an event the way the Python wyoming library does (data after the header). */
function send(socket: net.Socket, type: string, data: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(data))
  socket.write(JSON.stringify({ type, version: '1.6.0', data_length: body.length }) + '\n')
  socket.write(body)
}

beforeAll(async () => {
  wyoming = net.createServer((socket) => {
    const session = { types: [] as string[], audioBytes: 0, format: undefined as Record<string, unknown> | undefined }
    sessions.push(session)
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) return
        const h = JSON.parse(buf.subarray(0, nl).toString())
        const need = nl + 1 + (h.data_length ?? 0) + (h.payload_length ?? 0)
        if (buf.length < need) return
        buf = buf.subarray(need)
        session.types.push(h.type)
        if (h.type === 'describe')
          send(socket, 'info', { asr: [{ name: 'faster-whisper', installed: true, models: [{ name: 'small-int8', languages: ['en'], installed: true }] }] })
        if (h.type === 'audio-start') session.format = h.data
        if (h.type === 'audio-chunk') session.audioBytes += h.payload_length
        if (h.type === 'audio-stop') send(socket, 'transcript', { text: ' Order the T8 bins before Monday. ' })
      }
    })
  })
  await new Promise<void>((r) => wyoming.listen(0, '127.0.0.1', () => r()))
  wyomingUri = `tcp://127.0.0.1:${(wyoming.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-wyoming-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  wyoming.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

function wav(seconds: number, rate = 16000): Buffer {
  const samples = Buffer.alloc(seconds * rate * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(samples.length, 40)
  return Buffer.concat([h, samples])
}

async function upload(id: string, data: Buffer, mime: string, name: string) {
  const res = await fetch(`${base}/api/attachments/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': mime, 'X-File-Name': name },
    body: new Uint8Array(data),
  })
  expect(res.status).toBe(201)
}

describe('Wyoming (Home Assistant) speech to text', () => {
  it('parses addresses', () => {
    expect(parseWyomingUri('tcp://192.168.1.249:10300')).toEqual({ host: '192.168.1.249', port: 10300 })
    expect(parseWyomingUri('192.168.1.249')).toEqual({ host: '192.168.1.249', port: 10300 })
    expect(readWav(wav(1))?.rate).toBe(16000)
  })

  it('tests the connection and lists the model', async () => {
    const { body } = await api('POST', '/api/ai/probe', { kind: 'wyoming', baseUrl: wyomingUri })
    expect(body.ok).toBe(true)
    expect(body.message).toContain('faster-whisper')
    expect(body.models).toEqual(['small-int8'])
  })

  it('is added for audio only and transcribes a WAV recording', async () => {
    const { body } = await api('POST', '/api/ai/agents', { kind: 'wyoming', baseUrl: wyomingUri.replace('tcp://', '') })
    expect(body.agent.baseUrl).toBe(wyomingUri)
    expect(body.settings.routing.audio).toEqual([body.agent.id])
    expect(body.settings.routing.handwriting).toEqual([])
    await upload('wav0123456789ab', wav(3), 'audio/wav', 'note.wav')
    const r = await api('POST', '/api/ai/audio-to-text', { attachmentId: 'wav0123456789ab' })
    expect(r.status).toBe(200)
    expect(r.body.text).toBe('Order the T8 bins before Monday.')
    const s = sessions.find((x) => x.types.includes('audio-stop'))!
    expect(s.types.slice(0, 2)).toEqual(['transcribe', 'audio-start'])
    expect(s.format).toMatchObject({ rate: 16000, width: 2, channels: 1 })
    expect(s.audioBytes).toBe(3 * 16000 * 2)
  })

  it.skipIf(!hasFfmpeg())('converts an iPhone/iPad recording (m4a) with ffmpeg', async () => {
    const m4a = path.join(dir, 'tone.m4a')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', m4a])
    await upload('m4a0123456789ab', fs.readFileSync(m4a), 'audio/mp4', 'Recording.m4a')
    const before = sessions.length
    const r = await api('POST', '/api/ai/audio-to-text', { attachmentId: 'm4a0123456789ab' })
    expect(r.body.text).toBe('Order the T8 bins before Monday.')
    const s = sessions.slice(before).find((x) => x.types.includes('audio-stop')) ?? sessions.find((x) => x.audioBytes > 60000)!
    expect(s.format).toMatchObject({ rate: 16000, channels: 1 })
    expect(s.audioBytes).toBeGreaterThan(60000) // ~2 s of 16 kHz audio
  })

  it('explains a wrong port', async () => {
    const free = net.createServer()
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()))
    const port = (free.address() as AddressInfo).port
    free.close()
    const { body } = await api('POST', '/api/ai/probe', { kind: 'wyoming', baseUrl: `tcp://127.0.0.1:${port}` })
    expect(body.ok).toBe(false)
    expect(body.message).toMatch(/nothing is listening/)
  })
})

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
