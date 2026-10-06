import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, getNotes, getStrokes, noteDocName, readNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import type { Job } from '../src/jobs'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let ollama: http.Server
/** how long the fake model takes to answer */
let delay = 0
const prompts: string[] = []

const NOTE = 'notejobs000000000001'
const DRAWING = 'drawingjobs0000001'

beforeAll(async () => {
  ollama = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body || '{}')
    if (req.url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ capabilities: ['completion', 'vision'] }))
    }
    const prompt: string = req.url === '/api/generate' ? json.prompt : (json.messages?.[0]?.content ?? '')
    prompts.push(prompt)
    if (delay) await new Promise((r) => setTimeout(r, delay))
    // answer differently when given extra instructions, so a redo is visible
    const content = /LOUDER/.test(prompt) ? 'BUY MILK' : /Summarise/.test(prompt) ? '- Milk is needed' : 'Buy milk'
    if (res.destroyed) return
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url === '/api/generate' ? { response: content, done_reason: 'stop', eval_count: 5 } : { message: { role: 'assistant', content }, done_reason: 'stop', eval_count: 5 }))
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  const ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-jobs-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const agent = app.ai.agents.save({ name: 'Local', kind: 'ollama', baseUrl: ollamaUrl, model: 'qwen2.5vl:7b' })
  app.ai.agents.updateSettings({ routing: { ...app.ai.agents.settings().routing, handwriting: [agent.id], compile: [agent.id] } })
  await app.sync.change(WORKSPACE_DOC, (ws) => createNote(ws, { id: NOTE, title: 'Shopping' }))
  await app.sync.change(noteDocName(NOTE), (doc) => {
    const title = new Y.XmlElement('paragraph')
    title.insert(0, [new Y.XmlText('Shopping #home')])
    const d = new Y.XmlElement('drawing')
    d.setAttribute('drawingId', DRAWING)
    const rec = new Y.XmlElement('audio')
    rec.setAttribute('attachmentId', 'attjobsaudio000001')
    rec.setAttribute('name', 'Memo.m4a')
    const end = new Y.XmlElement('paragraph')
    end.insert(0, [new Y.XmlText('The end')])
    getContent(doc).insert(0, [title, d, rec, end])
    getStrokes(doc, DRAWING).push([{ id: 's1', tool: 'pen', color: '#000000', size: 3, pts: [10, 10, 0.5, 90, 40, 0.5] }])
  })
})

afterAll(async () => {
  await app.close()
  ollama.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// each test reads afresh (the server keeps readings of unchanged images)
beforeEach(() => {
  app.store.db.exec('DELETE FROM ai_readings')
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const waitFor = async (id: string): Promise<Job> => (await api('GET', `/api/jobs/${id}/wait`)).body.job
/** the note's top-level blocks as "name:text[job]" */
const blocks = (noteId = NOTE) =>
  getContent(app.sync.getDoc(noteDocName(noteId))!)
    .toArray()
    .map((n) => {
      const el = n as Y.XmlElement
      const job = el.getAttribute('job')
      return `${el.nodeName}:${el.toArray().map((c) => c.toString().replace(/<[^>]+>/g, '')).join('')}${job ? '*' : ''}`
    })

describe('jobs', () => {
  let convertJob: Job

  it('converts handwriting as a job and writes the text right below the drawing', async () => {
    const { status, body } = await api('POST', '/api/jobs', { kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })
    expect(status).toBe(201)
    expect(body.job.status).toMatch(/queued|running/)
    convertJob = await waitFor(body.job.id)
    expect(convertJob.status).toBe('done')
    expect(convertJob.agent).toMatch(/Local/)
    expect(convertJob.title).toBe('Shopping')
    expect(convertJob.startedAt).toBeGreaterThan(0)
    expect(convertJob.finishedAt).toBeGreaterThanOrEqual(convertJob.startedAt!)
    expect(blocks()).toEqual(['paragraph:Shopping #home', 'drawing:', 'paragraph:Buy milk*', 'audio:', 'paragraph:The end'])
    const list = (await api('GET', '/api/jobs')).body
    expect(list.jobs.find((j: Job) => j.id === convertJob.id)).toBeTruthy()
  })

  it('redoes a job with extra instructions, replacing its result in place', async () => {
    prompts.length = 0
    const { body } = await api('POST', `/api/jobs/${convertJob.id}/redo`, { prompt: 'Write it LOUDER' })
    const redo = await waitFor(body.job.id)
    expect(redo.status).toBe('done')
    expect(redo.prompt).toBe('Write it LOUDER')
    expect(redo.parentId).toBe(convertJob.id)
    expect(prompts.some((p) => p.includes('Write it LOUDER'))).toBe(true)
    expect(blocks()).toEqual(['paragraph:Shopping #home', 'drawing:', 'paragraph:BUY MILK*', 'audio:', 'paragraph:The end'])
    expect((await api('GET', `/api/jobs/${convertJob.id}`)).body.job.replacedBy).toBe(redo.id)
    // redoing the old run again replaces the newest result, not adds another
    const again = await waitFor((await api('POST', `/api/jobs/${convertJob.id}/redo`, { prompt: '' })).body.job.id)
    expect(blocks()).toEqual(['paragraph:Shopping #home', 'drawing:', 'paragraph:Buy milk*', 'audio:', 'paragraph:The end'])
    expect((await api('GET', `/api/jobs/${redo.id}`)).body.job.replacedBy).toBe(again.id)
    // and its result can be removed
    const removed = await api('POST', `/api/jobs/${again.id}/remove-result`)
    expect(removed.body.job.result.removed).toBe(true)
    expect(blocks()).toEqual(['paragraph:Shopping #home', 'drawing:', 'audio:', 'paragraph:The end'])
  })

  it('converts a picture by tidying what the server read when it was added (no second reading)', async () => {
    const { sampleHandwritingPng } = await import('../src/ai')
    const put = await fetch(`${base}/api/attachments/attjobspicture0001`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
      body: new Uint8Array(sampleHandwritingPng()),
    })
    expect(put.status).toBe(201)
    app.store.setAttachmentText('attjobspicture0001', 'Buy milk\nDescription: a handwritten shopping list', 'done')
    await app.sync.change(noteDocName(NOTE), (doc) => {
      const img = new Y.XmlElement('image')
      img.setAttribute('attachmentId', 'attjobspicture0001')
      getContent(doc).push([img])
    })
    prompts.length = 0
    const job = await waitFor((await api('POST', '/api/jobs', { kind: 'convert-picture', noteId: NOTE, input: { attachmentId: 'attjobspicture0001' } })).body.job.id)
    expect(job.status).toBe('done')
    expect(job.agent).toMatch(/Read when the picture was added/)
    // the picture wasn't read again (here no separate text model tidies it), and the search description is left out
    expect(prompts.every((p) => !/Transcribe all the text/.test(p))).toBe(true)
    expect(blocks().slice(-2)).toEqual(['image:', 'paragraph:Buy milk*'])
    await api('POST', `/api/jobs/${job.id}/remove-result`)
    await app.sync.change(noteDocName(NOTE), (doc) => getContent(doc).delete(getContent(doc).length - 1, 1))
  })

  it('adds a summary under the title', async () => {
    const { body } = await api('POST', '/api/jobs', { kind: 'summary', noteId: NOTE })
    const job = await waitFor(body.job.id)
    expect(job.status).toBe('done')
    expect(blocks().slice(0, 3)).toEqual(['paragraph:Shopping #home', 'paragraph:Summary*', 'bulletList:Milk is needed*'])
    await api('POST', `/api/jobs/${job.id}/remove-result`)
  })

  it('cancels a running job straight away and runs the next one', async () => {
    delay = 3000
    const slow = (await api('POST', '/api/jobs', { kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })).body.job
    const next = (await api('POST', '/api/jobs', { kind: 'summary', noteId: NOTE })).body.job
    await new Promise((r) => setTimeout(r, 300))
    expect((await api('GET', `/api/jobs/${slow.id}`)).body.job.status).toBe('running')
    expect((await api('GET', `/api/jobs/${next.id}`)).body.job.status).toBe('queued')
    const t = Date.now()
    delay = 0
    await api('POST', `/api/jobs/${slow.id}/cancel`)
    expect((await waitFor(slow.id)).status).toBe('cancelled')
    expect(Date.now() - t).toBeLessThan(1500)
    expect((await waitFor(next.id)).status).toBe('done')
    expect(blocks().filter((b) => b.includes('BUY') || b === 'paragraph:Buy milk*')).toEqual([]) // the cancelled one wrote nothing
    await api('POST', `/api/jobs/${next.id}/remove-result`)
  })

  it('pauses the queue and single jobs, and runs a job next', async () => {
    await api('POST', '/api/jobs/pause-all', { paused: true })
    const a = (await api('POST', '/api/jobs', { kind: 'summary', noteId: NOTE })).body.job
    const b = (await api('POST', '/api/jobs', { kind: 'todos', noteId: NOTE })).body.job
    await api('POST', `/api/jobs/${a.id}/pause`)
    await api('POST', `/api/jobs/${b.id}/run-next`)
    let list = (await api('GET', '/api/jobs')).body
    expect(list.paused).toBe(true)
    expect(list.counts).toEqual({ queued: 1, paused: 1, running: 0 })
    expect(list.jobs[0].id).toBe(b.id) // moved to the front
    await api('POST', '/api/jobs/pause-all', { paused: false })
    expect((await waitFor(b.id)).status).toBe('done')
    expect((await api('GET', `/api/jobs/${a.id}`)).body.job.status).toBe('paused')
    await api('POST', `/api/jobs/${a.id}/resume`)
    expect((await waitFor(a.id)).status).toBe('done')
    for (const j of [a, b]) await api('POST', `/api/jobs/${j.id}/remove-result`)
    list = (await api('GET', '/api/jobs')).body
    expect(list.counts).toEqual({ queued: 0, paused: 0, running: 0 })
  })

  it('compiles into a new note that keeps the recording, and a redo updates that note', async () => {
    const job = await waitFor((await api('POST', '/api/jobs', { kind: 'compile', noteId: NOTE })).body.job.id)
    expect(job.status).toBe('done')
    const compiled = job.result!.noteId as string
    expect(compiled).not.toBe(NOTE)
    expect(blocks(compiled)).toContain('audio:')
    // the handwriting itself comes along, ink and all
    expect(blocks(compiled)).toContain('drawing:')
    expect(getStrokes(app.sync.getDoc(noteDocName(compiled))!, DRAWING).length).toBe(1)
    expect(blocks(compiled).join('\n')).toMatch(/#home/)
    expect(readNote(getNotes(app.sync.getDoc(WORKSPACE_DOC)!).get(compiled)!).trashedAt).toBeFalsy()
    const redo = await waitFor((await api('POST', `/api/jobs/${job.id}/redo`, { prompt: 'LOUDER please' })).body.job.id)
    expect(redo.result!.noteId).toBe(compiled)
    // removing a compile's result moves the note to Recently Deleted
    await api('POST', `/api/jobs/${redo.id}/remove-result`)
    expect(readNote(getNotes(app.sync.getDoc(WORKSPACE_DOC)!).get(compiled)!).trashedAt).toBeTruthy()
  })

  it('reads unchanged handwriting only once (a redo reads it again)', async () => {
    const first = await waitFor((await api('POST', '/api/jobs', { kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })).body.job.id)
    await api('POST', `/api/jobs/${first.id}/remove-result`)
    prompts.length = 0
    const second = await waitFor((await api('POST', '/api/jobs', { kind: 'convert-drawing', noteId: NOTE, input: { drawingId: DRAWING } })).body.job.id)
    expect(second.status).toBe('done')
    expect(prompts.filter((p) => /Transcribe the handwriting/.test(p))).toHaveLength(0) // not read again
    prompts.length = 0
    const redo = await waitFor((await api('POST', `/api/jobs/${second.id}/redo`, {})).body.job.id)
    expect(redo.status).toBe('done')
    expect(prompts.filter((p) => /Transcribe the handwriting/.test(p)).length).toBeGreaterThan(0) // read afresh
    await api('POST', `/api/jobs/${redo.id}/remove-result`)
  })

  it('runs jobs for the model that is already loaded first', async () => {
    const order: string[] = []
    app.jobs.register('test-x', async (j) => (order.push(j.title), {}))
    app.jobs.register('test-y', async (j) => (order.push(j.title), {}))
    const saved = app.jobs.modelsOf
    app.jobs.modelsOf = (j) => ({ first: j.kind === 'test-x' ? 'X' : 'Y', last: j.kind === 'test-x' ? 'X' : 'Y' })
    await api('POST', '/api/jobs/pause-all', { paused: true })
    const ids = [
      app.jobs.submit({ kind: 'test-x', title: 'x1' }).id,
      app.jobs.submit({ kind: 'test-y', title: 'y1' }).id,
      app.jobs.submit({ kind: 'test-x', title: 'x2' }).id,
      app.jobs.submit({ kind: 'test-y', title: 'y2' }).id,
    ]
    await api('POST', '/api/jobs/pause-all', { paused: false })
    for (const id of ids) await app.jobs.wait(id)
    app.jobs.modelsOf = saved
    // x1 loads model X, so x2 runs before y1; then y1, y2
    expect(order).toEqual(['x1', 'x2', 'y1', 'y2'])
  })

  it('waits and tries again by itself when the AI server is unreachable', async () => {
    const agent = app.ai.agents.agents().find((a) => a.name === 'Local')!
    const good = agent.baseUrl
    app.ai.agents.save({ ...agent, baseUrl: 'http://127.0.0.1:9' }) // nothing listens there
    const job = (await api('POST', '/api/jobs', { kind: 'summary', noteId: NOTE })).body.job
    const waiting = (await api('GET', `/api/jobs/${job.id}/wait`)).body.job
    expect(waiting.status).toBe('queued')
    expect(waiting.retryAt).toBeGreaterThan(Date.now())
    expect(waiting.attempts).toBe(1)
    expect(waiting.error).toMatch(/connection refused|could not connect/)
    // the server is back; "try now" (or the timer) runs it
    app.ai.agents.save({ ...agent, baseUrl: good })
    await api('POST', `/api/jobs/${job.id}/resume`)
    const done = await waitFor(job.id)
    expect(done.status).toBe('done')
    expect(done.error).toBeNull()
    await api('POST', `/api/jobs/${job.id}/remove-result`)
  })

  it('lists work done on a device, and the old AI routes show up as jobs too', async () => {
    const rec = await api('POST', '/api/jobs/record', { kind: 'convert-drawing', title: 'Shopping', noteId: NOTE, input: { drawingId: DRAWING }, agent: 'Apple (on this device)', startedAt: Date.now() - 800 })
    expect(rec.body.job.origin).toBe('device')
    expect(rec.body.job.redoable).toBe(true)
    const r = await api('POST', '/api/ai/note-action', { action: 'clean', text: 'buy  milk' })
    expect(r.status).toBe(200)
    const jobs = (await api('GET', '/api/jobs')).body.jobs as Job[]
    expect(jobs.some((j) => j.kind === 'clean' && j.status === 'done')).toBe(true)
    await api('POST', '/api/jobs/clear-finished')
    expect((await api('GET', '/api/jobs')).body.jobs).toEqual([])
  })
})
