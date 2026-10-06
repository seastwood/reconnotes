import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let fake: http.Server
let fakeUrl: string
/** what the fake ntfy / Home Assistant received */
const pushes: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = []
const NOTE = 'notenotify0000000001'

beforeAll(async () => {
  // one server plays the AI model (Ollama) and the notification services
  fake = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }))
    if (req.url === '/api/chat' || req.url === '/api/generate')
      return res.end(JSON.stringify({ message: { role: 'assistant', content: '- It works' }, response: '- It works', done_reason: 'stop', eval_count: 5 }))
    pushes.push({ url: req.url!, headers: req.headers, body })
    res.end('{}')
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-notify-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const agent = app.ai.agents.save({ name: 'Local', kind: 'ollama', baseUrl: fakeUrl, model: 'qwen2.5:7b' })
  app.ai.agents.updateSettings({ routing: { ...app.ai.agents.settings().routing, compile: [agent.id] } })
  await app.sync.change(WORKSPACE_DOC, (ws) => createNote(ws, { id: NOTE, title: 'Plans' }))
  await app.sync.change(noteDocName(NOTE), (doc) => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText('Plans for the week')])
    getContent(doc).insert(0, [p])
  })
})

afterAll(async () => {
  await app.close()
  fake.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const summarise = async () => {
  const { body } = await api('POST', '/api/jobs', { kind: 'summary', noteId: NOTE })
  return (await api('GET', `/api/jobs/${body.job.id}/wait`)).body.job
}

describe('notifications when jobs finish', () => {
  it('sends nothing while off', async () => {
    pushes.length = 0
    await summarise()
    await new Promise((r) => setTimeout(r, 200))
    expect(pushes).toEqual([])
  })

  it('pushes to ntfy with a link that opens the note, and keeps the token secret', async () => {
    const r = await api('PUT', '/api/notify', { kind: 'ntfy', url: `${fakeUrl}/my-topic`, token: 'tk_secret' })
    expect(r.body.hasToken).toBe(true)
    expect(r.body.token).toBe('')
    pushes.length = 0
    expect((await api('POST', '/api/notify/test')).status).toBe(200)
    expect(pushes[0].url).toBe('/my-topic')
    expect(pushes[0].headers.authorization).toBe('Bearer tk_secret')
    pushes.length = 0
    await summarise()
    await new Promise((r) => setTimeout(r, 300))
    expect(pushes).toHaveLength(1)
    expect(pushes[0].headers.title).toBe('Summary finished')
    expect(pushes[0].headers.click).toBe(`reconnotes://open?note=${NOTE}`)
    expect(pushes[0].body).toBe('Plans')
  })

  it("doesn't push while the device that asked is open, or for background work", async () => {
    pushes.length = 0
    await api('GET', '/api/jobs') // the app is open and following its jobs
    await summarise()
    await new Promise((r) => setTimeout(r, 300))
    expect(pushes).toEqual([])
  })

  it('sends to Home Assistant’s notify service', async () => {
    await api('PUT', '/api/notify', { kind: 'homeassistant', url: fakeUrl + '/', token: 'ha_token', service: 'notify.mobile_app_phone' })
    pushes.length = 0
    expect((await api('POST', '/api/notify/test')).status).toBe(200)
    expect(pushes[0].url).toBe('/api/services/notify/mobile_app_phone')
    expect(pushes[0].headers.authorization).toBe('Bearer ha_token')
    expect(JSON.parse(pushes[0].body).data.url).toBe('reconnotes://open')
  })
})
