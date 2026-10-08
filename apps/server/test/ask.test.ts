import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createFolder, createNote, getContent, getNotes, noteDocName } from '@reconnotes/core'
import { annotateDates, findDates, timeRange } from '../src/timeRange'
import { findIn } from '../src/sections'
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

describe('dates in notes', () => {
  // Wednesday 7 October 2026, in a time zone 6 hours behind UTC
  const now = Date.UTC(2026, 9, 7, 18, 0)
  const TZ = 360
  it('finds the ways dates are written, and not fractions', () => {
    expect(findDates('Fill out paperwork by 10/22/26', now, TZ)).toHaveLength(1)
    expect(findDates('due !2026-10-22, or Oct 3rd, or 4 May', now, TZ)).toHaveLength(3)
    expect(findDates('add 1/2 cup of sugar', now, TZ)).toHaveLength(0)
    expect(findDates('done by 5/4', now, TZ)).toHaveLength(1)
  })
  it('explains each date so the AI doesn’t have to count', () => {
    expect(annotateDates('Eat an Apple by 5/4/26', now, TZ)).toBe('Eat an Apple by 5/4/26 [Mon 4 May 2026, 156 days ago]')
    expect(annotateDates('Fill out paperwork by 10/22/26', now, TZ)).toBe('Fill out paperwork by 10/22/26 [Thu 22 Oct 2026, in 15 days]')
    expect(annotateDates('call back tomorrow, 10/8/2026', now, TZ)).toContain('[Thu 8 Oct 2026, tomorrow]')
  })
})

describe('items the answer left out', () => {
  // the note as it reads: the handwriting's text, then the converted checklist under two headings
  const note = [
    '# 10/5/26',
    '✍️ Leadership Meeting – Thursday focus on power tool training – Ensure students are returning safety glasses',
    '',
    '## Leadership Meeting',
    '',
    '## 10/5/26',
    '',
    '- [ ] Thursday focus on power tool training',
    '- [ ] Verify all build is on github',
    '- [ ] Ensure students are returning safety glasses & grabbing their assigned ones.',
    '',
    '',
    '## Something else',
    '- [ ] Buy milk',
  ].join('\n')
  const words = ['leadership', 'meeting', 'dos']

  it('finds the list under a heading even with a date heading in between', async () => {
    const { sectionItems, excerpt } = await import('../src/ask')
    const items = sectionItems(new Map([[2, note]]), words)
    expect(items.map((i) => i.text)).toEqual([
      'Thursday focus on power tool training',
      'Verify all build is on github',
      'Ensure students are returning safety glasses & grabbing their assigned ones.',
    ])
    const long = note.replace('# 10/5/26', '# 10/5/26\n' + 'filler line here\n'.repeat(200))
    expect(excerpt(long, words, 2000)).toContain('Thursday focus on power tool training')
  })

  it('adds what the answer missed', async () => {
    const { sectionItems, missingItems } = await import('../src/ask')
    // the answer you got: two of the three
    const answer = '- [ ] Ensure students return safety glasses & grab assigned ones. [3]\n- [ ] Verify all builds are on GitHub. [3]'
    expect(missingItems(answer, sectionItems(new Map([[3, note]]), words))).toEqual([{ n: 3, text: 'Thursday focus on power tool training' }])
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
    expect(body.sources).toEqual([{ n: 1, noteId: 'asknote000001', title: 'Monday plan', find: 'Team A sorts the T8 bins' }])
    expect(prompts[0]).toContain('T8 bins')
    expect(prompts[0]).not.toContain('milk') // unrelated note left out
  })

  it('leaves the weekly digests out (they only repeat other notes)', async () => {
    await addNote('asknote000003', ['Week in review – Oct 1 to Oct 7', 'Team A sorted the T8 bins this week'])
    app.sync.hocuspocus.flushPendingStores()
    await new Promise((r) => setTimeout(r, 300))
    const res = await fetch(`${base}/api/ai/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is team A doing with the T8 bins?' }),
    })
    expect(res.status).toBe(200)
    expect(prompts.at(-1)).toContain('T8 bins with all the parts')
    expect(prompts.at(-1)).not.toContain('sorted the T8 bins this week')
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

describe('what’s due', () => {
  it('sorts dated to-dos into overdue and coming up, without asking the AI', async () => {
    const DAY = 86_400_000
    const md = (t: number) => {
      const d = new Date(t)
      return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`
    }
    await addNote('asknote000005', ['Errands', `Eat an Apple by ${md(Date.now() - 30 * DAY)}`, `Fill out paperwork by ${md(Date.now() + 15 * DAY)}`, 'Buy milk'])
    prompts.length = 0
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    const ask = async (question: string) => {
      const job = (await api('POST', '/api/jobs', { kind: 'ask', input: { question, tzOffset: new Date().getTimezoneOffset() } })).job
      return (await api('GET', `/api/jobs/${job.id}/wait`)).job
    }
    const past = await ask('what are past due things?')
    expect(past.result.answer).toContain('**Overdue**')
    expect(past.result.answer).toMatch(/Eat an Apple .*30 days ago/)
    expect(past.result.answer).not.toContain('Fill out paperwork')
    expect(past.result.sources.map((s: { noteId: string }) => s.noteId)).toEqual(['asknote000005'])
    const all = await ask('what do I have due?')
    expect(all.result.answer).toMatch(/\*\*Coming up\*\*\n- \[ \] Fill out paperwork .*in 15 days/)
    expect(all.result.answer).not.toContain('Buy milk')
    expect(prompts).toHaveLength(0) // no AI needed
  })
})

describe('follow-up questions', () => {
  it('sends the conversation and reads the notes the earlier answer used', async () => {
    prompts.length = 0
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    const history = [{ question: 'What is team A doing with the bins?', answer: 'Team A sorts the T8 bins on Monday [1].', sources: ['asknote000001'] }]
    const job = (await api('POST', '/api/jobs', { kind: 'ask', input: { question: 'and when is that happening?', history } })).job
    const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
    expect(done.status).toBe('done')
    expect(prompts[0]).toContain('Earlier in this conversation')
    expect(prompts[0]).toContain('Q: What is team A doing with the bins?')
    expect(prompts[0]).toContain('Follow-up question: and when is that happening?')
    expect(prompts[0]).toContain('T8 bins with all the parts') // the earlier answer's note
    expect(done.result.sources.map((s: { noteId: string }) => s.noteId)).toContain('asknote000001')
  })
})

describe('folder names in questions', () => {
  it('reads the notes in a folder the question names first, and says which folder each is in', async () => {
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      createFolder(ws, { id: 'folderfrc0000001', name: 'FRC' })
      createFolder(ws, { id: 'folderpits000001', name: 'Pit crew', parentId: 'folderfrc0000001' })
    })
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'asknote000006', title: 'Breaker checks', folderId: 'folderpits000001' }))
    await app.sync.change(noteDocName('asknote000006'), (doc) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('Check the main breaker before every match')])
      getContent(doc).insert(0, [p])
    })
    app.sync.hocuspocus.flushPendingStores()
    await new Promise((r) => setTimeout(r, 300))
    prompts.length = 0
    const res = await fetch(`${base}/api/ai/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: "what's in my FRC notes?" }),
    })
    expect(res.status).toBe(200)
    // the note in FRC › Pit crew comes first, with its folder
    expect(prompts[0]).toMatch(/=== \[1\] "Breaker checks" \(in folder FRC › Pit crew,/)
  })
})

describe('ask about this note', () => {
  it('reads only the note asked about, even when others match better', async () => {
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    prompts.length = 0
    const job = (await api('POST', '/api/jobs', { kind: 'ask', input: { question: 'What is team A doing with the bins?', notes: ['asknote000002'] } })).job
    const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
    expect(done.status).toBe('done')
    expect(prompts[0]).toContain('milk')
    expect(prompts[0]).not.toContain('T8 bins')
  })
})

describe('long notes (a manual)', () => {
  it('reads and cites the section about the question – and a rule asked for by its number', async () => {
    // a manual page: many sections, the answer deep inside
    const filler = (n: number) => Array.from({ length: 12 }, (_, i) => `Section ${n} paragraph ${i}: the robot and the field and the alliance and the match.`).join('\n\n')
    const lines = [
      'Game rules',
      '# Game rules',
      '## 6.1 Safety',
      filler(1),
      '## 6.2 Robot size',
      'Robots must fit within a 120 cm frame perimeter and be no taller than 152 cm at the start of the match.',
      filler(2),
      '## 6.3 Fouls',
      'G301 Robots may not damage the field. Violation: major foul.',
      'G302 Robots may not extend more than 48 cm beyond their frame perimeter. Violation: minor foul.',
      filler(3),
      '## 6.4 Scoring',
      'A coral on level 4 is worth 5 points. See G302 for extension limits.',
      filler(4),
    ]
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'manualnote00001', title: 'Game rules' }))
    await app.sync.change(noteDocName('manualnote00001'), (doc) => {
      getContent(doc).insert(
        0,
        lines.flatMap((t) => t.split('\n\n')).map((t) => {
          const h = /^(#+) (.*)$/.exec(t)
          const el = new Y.XmlElement(h ? 'heading' : 'paragraph')
          if (h) el.setAttribute('level', String(h[1].length) as unknown as string)
          el.insert(0, [new Y.XmlText(h ? h[2] : t)])
          return el
        }),
      )
    })
    app.sync.hocuspocus.flushPendingStores()
    await new Promise((r) => setTimeout(r, 300))
    const ask = async (question: string) => {
      prompts.length = 0
      const res = await fetch(`${base}/api/ai/ask`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      return { body: await res.json(), prompt: prompts[0] }
    }
    const height = await ask('How tall can the robot be?')
    expect(height.prompt).toContain('no taller than 152 cm')
    expect(height.prompt).toContain('"Game rules" › 6.2 Robot size')
    // not the whole page: the other sections' filler stays out
    expect(height.prompt).not.toContain('Section 4 paragraph 11')

    const rule = await ask('is g302 a minor or major foul?')
    expect(rule.prompt).toContain('G302 Robots may not extend more than 48 cm')
    // the rule's own section comes first (cited as [1])
    expect(rule.prompt).toMatch(/=== \[1\] "Game rules" › 6\.3 Fouls/)
  })

  it('keeps each conversation about a note – with its follow-ups – and its sources point at the line with the answer', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
    const wait = (id: string) => fetch(`${base}/api/jobs/${id}/wait`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
    const first = (await post({ kind: 'ask', input: { question: 'is g302 a minor or major foul?', notes: ['manualnote00001'] } })).job
    const done = (await wait(first.id)).job
    expect(done.status).toBe('done')
    // the source opens the note at the rule itself
    expect(done.result.sources[0].find).toMatch(/^G302 Robots may not extend/)
    const second = (await post({ kind: 'ask', input: { question: 'and G301?', notes: ['manualnote00001'], thread: first.id, history: [{ question: 'is g302 a minor or major foul?', answer: done.result.answer }] } })).job
    await wait(second.id)
    const { conversations } = await fetch(`${base}/api/ask/history?noteId=manualnote00001`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(first.id)
    expect(conversations[0].turns.map((t: { question: string }) => t.question)).toEqual(['is g302 a minor or major foul?', 'and G301?'])
    // not mixed with questions about everything
    const all = await fetch(`${base}/api/ask/history`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
    expect(all.conversations.some((c: { id: string }) => c.id === first.id)).toBe(false)
    // and it can be deleted
    await fetch(`${base}/api/ask/history/${first.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } })
    expect((await fetch(`${base}/api/ask/history?noteId=manualnote00001`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())).conversations).toEqual([])
  })
})

describe('where a source opens', () => {
  it('lands on the line with the answer, not the note’s title', () => {
    const md = '# Install the server\n\nFirst copy the files.\n\nTo install it, run npm ci then start the service.'
    expect(findIn(md, ['how', 'install', 'it'])).toBe('To install it, run npm ci')
    // the title when it’s the only line about it
    expect(findIn('# Install the server\n\nCopy the files.', ['install'])).toBe('Install the server')
  })
})
