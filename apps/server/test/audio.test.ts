import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let whisper: http.Server
let whisperUrl: string
const uploads: { url: string; auth: string; body: string }[] = []

beforeAll(async () => {
  // a fake OpenAI-compatible speech-to-text server (like Speaches or whisper.cpp)
  whisper = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    uploads.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: ' Remember to order the T8 bins before Monday. ' }))
  })
  await new Promise<void>((r) => whisper.listen(0, '127.0.0.1', () => r()))
  whisperUrl = `http://127.0.0.1:${(whisper.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-audio-'))
  // the old environment-variable setup is turned into an agent
  app = createApp(
    loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_TRANSCRIBE_URL: whisperUrl, RECON_TRANSCRIBE_MODEL: 'Systran/faster-whisper-small', RECON_TRANSCRIBE_API_KEY: 'sk-test' }),
    { backups: false },
  )
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  whisper.close()
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

describe('audio to text', () => {
  it('turns RECON_TRANSCRIBE_URL into a speech-to-text agent', async () => {
    const { body } = await api('GET', '/api/ai/agents')
    const agent = body.agents.find((a: { name: string }) => a.name === 'Speech to text')
    expect(agent).toBeTruthy()
    expect(agent.kind).toBe('openai')
    expect(agent.baseUrl).toBe(whisperUrl + '/v1')
    expect(body.settings.routing.audio).toEqual([agent.id])
    expect(body.tasks.map((t: { id: string }) => t.id)).toContain('audio')
  })

  it('transcribes an uploaded recording on request', async () => {
    const id = 'rec0123456789ab'
    const put = await fetch(`${base}/api/attachments/${id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'audio/mp4', 'X-File-Name': 'Recording.m4a' },
      body: Buffer.from('fake audio data'),
    })
    expect(put.status).toBe(201)
    const { status, body } = await api('POST', '/api/ai/audio-to-text', { attachmentId: id })
    expect(status).toBe(200)
    expect(body.text).toBe('Remember to order the T8 bins before Monday.')
    const call = uploads.find((u) => u.url === '/v1/audio/transcriptions')!
    expect(call.auth).toBe('Bearer sk-test')
    expect(call.body).toContain('Systran/faster-whisper-small')
    expect(call.body).toContain('filename="Recording.m4a"')
  })

  it('new Whisper agents are used for audio only', async () => {
    const { body } = await api('POST', '/api/ai/agents', { name: 'OpenAI Whisper', kind: 'openai', baseUrl: whisperUrl + '/v1', model: 'whisper-1' })
    const id = body.agent.id
    expect(body.settings.routing.audio).toContain(id)
    expect(body.settings.routing.handwriting).not.toContain(id)
    expect(body.settings.routing.compile).not.toContain(id)
  })

  it('explains when the recording is not on the server', async () => {
    const { status, body } = await api('POST', '/api/ai/audio-to-text', { attachmentId: 'missing0000000' })
    expect(status).toBe(409)
    expect(body.error).toMatch(/hasn't reached the server/)
  })
})
