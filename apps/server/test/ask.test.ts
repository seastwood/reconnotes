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
let llm: http.Server
const prompts: string[] = []

beforeAll(async () => {
  llm = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gen' }] }))
    const prompt = JSON.parse(body).messages[0].content.map((c: { text?: string }) => c.text ?? '').join('')
    prompts.push(prompt)
    res.end(JSON.stringify({ choices: [{ message: { content: 'Team A sorts the T8 bins on Monday [1].' } }] }))
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-ask-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  app.ai.agents.save({ name: 'Gen', kind: 'openai', baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, model: 'gen', vision: false })
})

afterAll(async () => {
  await app.close()
  llm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function addNote(id: string, lines: string[]) {
  await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: lines[0] }))
  await app.sync.change(noteDocName(id), (doc) => {
    getContent(doc).insert(
      0,
      lines.map((t) => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText(t)])
        return p
      }),
    )
  })
}

describe('excerpts', () => {
  it('keeps the start of a long note and the lines about the question', async () => {
    const { excerpt } = await import('../src/ask')
    const lines = ['# Leadership meeting', 'Attendees: all', ...Array.from({ length: 300 }, (_, i) => `filler line ${i} about nothing in particular`)]
    lines[150] = '- [ ] Order safety glasses for the shop'
    const out = excerpt(lines.join('\n'), ['safety', 'glasses'], 600)
    expect(out.length).toBeLessThanOrEqual(600)
    expect(out).toContain('# Leadership meeting')
    expect(out).toContain('Order safety glasses')
    expect(out).toContain('filler line 147') // the line before, for context
    expect(out).not.toContain('filler line 10 ')
  })
})

describe('answer formatting', () => {
  it('turns plain lines after "…:" into a list, and • bullets into Markdown ones', async () => {
    const { listify } = await import('../src/ask')
    const plain = 'After your last leadership meeting, you need to:\nSort the metal on the shelf.\nMake a decision about the lieutenant today.\nSort Team A + B bins.'
    expect(listify(plain)).toBe(
      'After your last leadership meeting, you need to:\n\n- Sort the metal on the shelf.\n- Make a decision about the lieutenant today.\n- Sort Team A + B bins.',
    )
    expect(listify('Things:\n• one\n• two')).toBe('Things:\n- one\n- two')
    // already a list, or a single sentence: left alone
    expect(listify('You need to:\n- [ ] one [1]\n- [ ] two [1]')).toBe('You need to:\n- [ ] one [1]\n- [ ] two [1]')
    expect(listify('The answer is:\nGlasses.')).toBe('The answer is:\nGlasses.')
  })
})

describe('ask your notes', () => {
  it('answers from the matching notes and cites them', async () => {
    await addNote('asknote000001', ['Monday plan', 'Team A sorts the T8 bins with all the parts'])
    await addNote('asknote000002', ['Groceries', 'milk, eggs, bread'])
    app.sync.hocuspocus.flushPendingStores()
    await new Promise((r) => setTimeout(r, 300))
    const res = await fetch(`${base}/api/ai/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is team A doing with the bins?' }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.answer).toContain('[1]')
    expect(body.sources).toEqual([{ n: 1, noteId: 'asknote000001', title: 'Monday plan' }])
    expect(prompts[0]).toContain('T8 bins')
    expect(prompts[0]).not.toContain('milk') // unrelated note left out
  })
})
