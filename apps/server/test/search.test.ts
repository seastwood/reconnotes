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
import { passages } from '../src/semantic'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let fake: http.Server
let embedCalls = 0

/** a pretend embedding model: three "topics" */
const vectorFor = (t: string) =>
  /glass|safety|goggle|protect|gear/i.test(t) ? [1, 0, 0.1] : /milk|egg|grocer|food|bread/i.test(t) ? [0, 1, 0.1] : [0.05, 0.05, 1]

beforeAll(async () => {
  fake = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = JSON.parse(body || '{}')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/embed') {
      embedCalls++
      return res.end(JSON.stringify({ embeddings: (json.input as string[]).map(vectorFor) }))
    }
    res.end(JSON.stringify({ capabilities: ['completion'] }))
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-search-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const note = async (id: string, title: string, text: string) => {
    await app.sync.change(WORKSPACE_DOC, (ws) => createNote(ws, { id, title }))
    await app.sync.change(noteDocName(id), (doc) => {
      const els = [title, text].map((t) => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText(t)])
        return p
      })
      getContent(doc).insert(0, els)
    })
    app.sync.indexNote(id, app.sync.getDoc(noteDocName(id))!)
  }
  await note('notesearch0000000001', 'Leadership', 'Ensure students are returning safety glasses. Make decision on Lieutenant today.')
  await note('notesearch0000000002', 'Shopping', 'Buy milk, eggs and bread')
})

afterAll(async () => {
  await app.close()
  fake.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const search = async (q: string) =>
  (await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).hits as { noteId: string; meaning?: boolean }[]

describe('search', () => {
  it('finds words with a letter or two wrong (as handwriting is sometimes read)', async () => {
    expect((await search('Leutenant')).map((h) => h.noteId)).toEqual(['notesearch0000000001'])
    expect((await search('studnets')).map((h) => h.noteId)).toEqual(['notesearch0000000001'])
    expect(await search('zebra')).toEqual([])
  })

  it('splits a note into passages that keep the title', () => {
    const p = passages('Trip', 'a'.repeat(500) + '\n\n' + 'b'.repeat(500))
    expect(p).toHaveLength(2)
    expect(p[1].startsWith('Trip: ')).toBe(true)
  })

  it('finds notes by meaning once an embedding model is set up, embedding only what changed', async () => {
    expect((await search('protective gear')).length).toBe(0) // no embedding model yet: words only
    const agent = app.ai.agents.save({ name: 'Embed', kind: 'ollama', baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, model: 'nomic-embed-text' })
    expect(app.ai.agents.settings().routing.embed).toEqual([agent.id]) // an embedding model only does this
    expect(app.ai.agents.settings().routing.compile).not.toContain(agent.id)
    for (const id of ['notesearch0000000001', 'notesearch0000000002']) {
      await app.sync.meaning!.indexNote(id, ...(['Leadership', 'Ensure students are returning safety glasses. Make decision on Lieutenant today.', 'Shopping', 'Buy milk, eggs and bread'].slice(id.endsWith('1') ? 0 : 2, id.endsWith('1') ? 2 : 4) as [string, string]))
    }
    const hits = await search('protective gear')
    expect(hits.map((h) => h.noteId)).toEqual(['notesearch0000000001'])
    expect(hits[0].meaning).toBe(true)
    // nothing changed: no new embeddings
    const before = embedCalls
    await app.sync.meaning!.indexNote('notesearch0000000002', 'Shopping', 'Buy milk, eggs and bread')
    expect(embedCalls).toBe(before)
  })

  it('finds related notes by meaning, without asking the AI again', async () => {
    const id = 'notesearch0000000003'
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: 'Lab rules' }))
    await app.sync.meaning!.indexNote(id, 'Lab rules', 'Safety glasses on at all times, goggles for grinding')
    // about the same thing in other words only: not related (embeddings alone rate too much as alike)
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'notesearch0000000004', title: 'Workshop' }))
    await app.sync.meaning!.indexNote('notesearch0000000004', 'Workshop', 'Protective gear required near the lathe and drill press')
    const before = embedCalls
    const r = await (await fetch(`${base}/api/notes/notesearch0000000001/related`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
    expect(r.available).toBe(true)
    expect(r.related.map((h: { noteId: string }) => h.noteId)).toEqual([id]) // shares “safety glasses”; the workshop note doesn't
    expect(r.related[0].title).toBe('Lab rules')
    expect(embedCalls).toBe(before)
    // a note with hardly anything in it says too little to find related ones
    await app.sync.meaning!.indexNote(id, 'Lab', 'Goggles')
    expect(app.sync.meaning!.related(id)).toEqual([])
  })
})
