import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, getNotes, noteDocName } from '@reconnotes/core'
import { timeRange } from '../src/timeRange'
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

describe('questions about a time', () => {
  // Tuesday 6 October 2026, 6:50 pm, in a time zone 6 hours behind UTC
  const TZ = 360
  const now = Date.UTC(2026, 9, 7, 0, 50)
  const day = (r: ReturnType<typeof timeRange>) => r && [new Date(r.from - TZ * 60_000).toISOString().slice(0, 10), Math.round((r.to - r.from) / 86_400_000)]
  it('understands yesterday, weekdays, weeks and dates in the asker’s time zone', () => {
    expect(day(timeRange('where are my notes from yesterday', now, TZ))).toEqual(['2026-10-05', 1])
    expect(timeRange('what did I do yesterday', now, TZ)!.label).toBe('yesterday (Monday 5 October 2026)')
    expect(day(timeRange('what did I write today?', now, TZ))).toEqual(['2026-10-06', 1])
    expect(day(timeRange('notes from Friday', now, TZ))).toEqual(['2026-10-02', 1])
    expect(day(timeRange('last tuesday', now, TZ))).toEqual(['2026-09-29', 1])
    expect(day(timeRange('what did I work on this week', now, TZ))).toEqual(['2026-10-05', 2])
    expect(day(timeRange('last week', now, TZ))).toEqual(['2026-09-28', 7])
    expect(day(timeRange('the past 3 days', now, TZ))).toEqual(['2026-10-04', 3])
    expect(day(timeRange('what was on 10/5?', now, TZ))).toEqual(['2026-10-05', 1])
    expect(day(timeRange('my notes from Oct 1st', now, TZ))).toEqual(['2026-10-01', 1])
    expect(day(timeRange('2 September notes', now, TZ))).toEqual(['2026-09-02', 1])
    expect(timeRange('what do I need to do after my leadership meeting', now, TZ)).toBeNull()
  })
})

describe('excerpts', () => {
  it('keeps the whole list under a matching line', async () => {
    const { excerpt } = await import('../src/ask')
    const md = [
      '# 10/5/26',
      ...Array.from({ length: 120 }, (_, i) => `filler ${i} nothing to see here at all`),
      'Leadership Meeting',
      '',
      '- Thursday focus on power tool training',
      '- Ensure students are returning safety glasses & grabbing their assigned ones.',
      '- Verify all build is on github',
      '',
      '',
      ...Array.from({ length: 120 }, (_, i) => `more filler ${i} nothing here`),
    ].join('\n')
    const out = excerpt(md, ['leadership', 'meeting'], 1500)
    expect(out).toContain('Thursday focus on power tool training')
    expect(out).toContain('Ensure students')
    expect(out).toContain('Verify all build')
    expect(out).not.toContain('more filler 5 ')
  })

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

describe('ask about a day', () => {
  it('uses the notes written or edited that day, and tells the AI the date', async () => {
    const DAY = 86_400_000
    await addNote('asknote000003', ['Robot wiring', 'Rewired the CAN bus on the drivetrain'])
    await addNote('asknote000004', ['Old idea', 'Paint the pit blue'])
    // the first was worked on yesterday, the second a week ago
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      const set = (id: string, t: number) => {
        getNotes(ws).get(id)!.set('createdAt', t)
        getNotes(ws).get(id)!.set('updatedAt', t)
      }
      set('asknote000003', Date.now() - DAY)
      set('asknote000004', Date.now() - 8 * DAY)
      set('asknote000001', Date.now() - 8 * DAY)
      set('asknote000002', Date.now() - 8 * DAY)
    })
    prompts.length = 0
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    const job = (await api('POST', '/api/jobs', { kind: 'ask', input: { question: 'where are my notes from yesterday?', tzOffset: new Date().getTimezoneOffset() } })).job
    const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
    expect(done.status).toBe('done')
    expect(prompts[0]).toMatch(/Today is \w+day \d+ \w+ \d{4}\./)
    expect(prompts[0]).toContain('The question is about yesterday')
    expect(prompts[0]).toContain('CAN bus')
    expect(prompts[0]).not.toContain('Paint the pit')
    expect(done.result.sources.map((s: { noteId: string }) => s.noteId)).toEqual(['asknote000003'])

    // nothing that day: says so without asking the AI
    prompts.length = 0
    const none = (await api('POST', '/api/jobs', { kind: 'ask', input: { question: 'what did I write on 1/1/2020?' } })).job
    const r = (await api('GET', `/api/jobs/${none.id}/wait`)).job
    expect(r.result.answer).toMatch(/didn't write or edit any notes/)
    expect(prompts).toHaveLength(0)
  })
})
