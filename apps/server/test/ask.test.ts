import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createFolder, createNote, updateFolder, getContent, getNotes, noteDocName } from '@reconnotes/core'
import { annotateDates, findDates, timeRange } from '../src/timeRange'
import { setAskRefs } from '../src/askHistory'
import { findReferences, setIgnoredRef } from '../src/references'
import { unwrapLink } from '../src/webImport'
import { markdownToNodes } from '../src/importNotes'
import { updateNote } from '@reconnotes/core'
import { askNotes, figuresIn, noteContext, namesIn, reciteByFigures, unciteAbsence, autoCite, citeByNumber, citeFinds, labelRefs, markInference, onlyRules, pointedRules, recite, reciteByWords, sectionItems } from '../src/ask'
import { findIn, keyLines, scoreSections, splitSections } from '../src/sections'
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
    if (prompt.includes('Question: Can a robot have a cutout in its bumper?'))
      return res.end(JSON.stringify({ choices: [{ message: { content: 'A robot cannot have a cutout in its bumper [1].' } }] }))
    // the jersey question: answered only when the uniforms section was read
    if (prompt.includes('Question: What colour is the jersey?'))
      return res.end(JSON.stringify({ choices: [{ message: { content: /everyone wears blue/.test(prompt) ? `Blue [${/\[(\d+)\][^\n]*\n[^=]*everyone wears blue/.exec(prompt)?.[1] ?? 1}].` : 'The notes do not contain that.' } }] }))
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
    // not a word that starts like a month, nor a section number's end
    expect(annotateDates('## 3.7 AprilTag Distribution', now, TZ)).toBe('## 3.7 AprilTag Distribution')
    expect(annotateDates('Marching band on 12 Marchington Rd', now, TZ)).toBe('Marching band on 12 Marchington Rd')
    expect(annotateDates('due Sept. 5 or 4 May', now, TZ)).toBe('due Sept. 5 [Sat 5 Sep 2026, 32 days ago] or 4 May [Mon 4 May 2026, 156 days ago]')
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
  it('a question naming someone reads the notes that mention them – not a meeting that only shares "wanted" and "do"', async () => {
    await addNote('sydneynote0001', ['Sydney’s chores that I need to do', 'Water Lawn', 'Walk dogs', 'Feed Stache every morning'])
    await addNote('meetingnote001', [
      'Meeting – Thu, Oct 8',
      'I wanted to throw that out to you guys before we do it on Monday. Do you want to talk about splitting the scrum? What do you want me to do with the lieutenants?',
    ])
    app.sync.hocuspocus.flushPendingStores()
    await new Promise((r) => setTimeout(r, 300))
    prompts.length = 0
    const res = await fetch(`${base}/api/ai/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'what was it Sydney wanted me to do?' }),
    })
    expect(res.status).toBe(200)
    expect(prompts[0]).toContain('Walk dogs')
    expect(prompts[0]).not.toContain('splitting the scrum')
  })
  it('a follow-up that names nobody keeps to whoever the conversation is about', async () => {
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what do you want to do first with these?', null, {}, {}, [
      { question: 'what was it Sydney wanted me to do?', answer: '- Walk dogs [1]', sources: ['sydneynote0001'] },
    ])
    expect(prompts[0]).toContain('Walk dogs')
    expect(prompts[0]).not.toContain('splitting the scrum')
  })
  it('"Anything": the AI’s own answer – no notes read, nothing cited, kept in the chat marked as such', async () => {
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    prompts.length = 0
    const job = (await api('POST', '/api/jobs', { kind: 'ask', input: { question: 'Make me a chili recipe for Sydney', mode: 'general', folders: [] } })).job
    const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
    expect(done.status).toBe('done')
    expect(done.result.general).toBe(true)
    expect(done.result.sources).toEqual([])
    expect(prompts[0]).toContain('Request: Make me a chili recipe')
    expect(prompts[0]).not.toContain('Walk dogs') // Sydney's notes aren't read
    const kept = (await api('GET', '/api/ask/history')).conversations.find((c: { id: string }) => c.id === job.id)
    expect(kept.turns[0].general).toBe(true)
  })
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

describe('names in a question', () => {
  it('are its capitalised words but the first – not "I", nor shouting', () => {
    expect(namesIn('what was it Sydney wanted me to do?')).toEqual(['sydney'])
    expect(namesIn('What did I tell Jesse about the FRC robot?')).toEqual(['jesse'])
    expect(namesIn('What did Sydney’s mom say?')).toEqual(['sydney'])
  })
})

describe('what the notes don’t say', () => {
  it('isn’t cited to them', () => {
    expect(unciteAbsence('- Walk dogs [2]\n\nNo explicit prioritization rules are stated in the notes [1][2], so this order reflects urgency.')).toBe(
      '- Walk dogs [2]\n\nNo explicit prioritization rules are stated in the notes, so this order reflects urgency.',
    )
    expect(unciteAbsence('The notes don’t mention a deadline [3].')).toBe('The notes don’t mention a deadline.')
    // what they do say keeps its citation
    expect(unciteAbsence('Winterize the chicken coop by Monday [2].')).toBe('Winterize the chicken coop by Monday [2].')
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
    // every chat, in brief, for the chats browser: what it's about, its first question, how many
    const { chats } = await fetch(`${base}/api/ask/chats`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
    expect(chats.find((c: { id: string }) => c.id === first.id)).toMatchObject({ scope: 'note:manualnote00001', question: 'is g302 a minor or major foul?', questions: 2 })
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

describe('a manual says it in other words', () => {
  it('finds "no taller than" for "max height"', () => {
    const md = [
      '# Game manual',
      '## 3 ARENA',
      'The arena wall height is 12 in. A maximum of 3 cookies fit in each goal.',
      '## 4 MATCH PLAY',
      'During the match, each robot may score a maximum of 10 points per cycle.',
      '## 5 ROBOT RULES',
      'R3 Robots must fit within an 18 in. sizing box at the start and be no taller than 24 in. once expanded.',
    ].join('\n')
    const best = scoreSections(splitSections('m', 'Game manual', md), ['max', 'height', 'robot'], []).sort((a, b) => b.score - a.score)[0]
    expect(best.text).toContain('R3 Robots')
  })

  it('looks further in the note when the first sections don’t have the answer', async () => {
    const lines = ['Team handbook']
    for (let i = 1; i <= 14; i++) lines.push(`Section ${i}`, `The jersey number rule ${i}: ` + 'numbers are assigned at check-in and must be visible from the side. '.repeat(20))
    lines.push('Uniforms', 'At events everyone wears blue. ' + 'Bring a spare set for the second day of the event. '.repeat(26))
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'handbook000001', title: 'Team handbook' }))
    await app.sync.change(noteDocName('handbook000001'), (doc) => {
      getContent(doc).insert(
        0,
        lines.map((t, i) => {
          const heading = i === 0 || /^Section \d+$|^Uniforms$/.test(t)
          const p = new Y.XmlElement(heading ? 'heading' : 'paragraph')
          if (heading) p.setAttribute('level', i === 0 ? '1' : '2')
          p.insert(0, [new Y.XmlText(t)])
          return p
        }),
      )
    })
    const res = await askNotes(app.store, app.sync, app.ai, 'What colour is the jersey?', null, {}, { notes: ['handbook000001'] })
    expect(res.answer).toMatch(/^Blue/)
    // the first look didn't have it
    expect(prompts.filter((p) => p.includes('Question: What colour is the jersey?'))).toHaveLength(2)
    expect(res.sources[0].section).toBe('Uniforms')
  })
})

describe('each citation opens where its sentence came from', () => {
  it('three facts from one section: three places', () => {
    const section = [
      '### 7.2 GENERAL ROBOT DESIGN',
      'R01. The ROBOT must start a MATCH inside the STARTING VOLUME of 36” long x 36” wide x 40” tall and not extend beyond the ROBOT VOLUME of 36” long x 36” wide x 60” tall during a MATCH.',
      'R02. The ROBOT weight must not exceed the weight of 125 lbs.',
      'Battery and bumpers do not count towards the 125 lbs limit.',
      'R03. The ROBOT must be designed to not exceed a speed of 10.5 feet per second.',
      'R04. The ROBOT should be developed by Students. ROBOTS should be designed, built, and programmed by Students.',
    ].join('\n\n')
    const answer = [
      '- The ROBOT must start inside a STARTING VOLUME of 36” long x 36” wide x 40” tall [7].',
      '- The maximum height is 60 inches: it must not extend beyond 36” x 36” x 60” tall during a MATCH [7].',
      '- The ROBOT must not exceed a speed of 10.5 feet per second [7][2].',
    ].join('\n')
    const cites = citeFinds(answer, new Map([[7, section], [2, 'Something else entirely.']]))
    expect(cites.map((c) => c.n)).toEqual([7, 7, 7, 2])
    expect(cites[0].find).toMatch(/^R01\. The ROBOT must start/)
    expect(cites[1].find).toMatch(/^R01\./)
    expect(cites[2].find).toMatch(/^R03\. The ROBOT must be/)
    expect(cites[3].find).toBeUndefined()
    // cited mid-sentence, with the evidence after it (and the wrong rule number)
    const mid = citeFinds(
      '- The maximum height of the robot is constrained to be within 60 inches based on rule R04 from section [7] "Minnetrials Manual 10-6-26" › 7 ROBOT CONSTRUCTION RULES › 7.2 GENERAL ROBOT DESIGN, which states that the ROBOT must not extend beyond a volume of 36” long x 36” wide x 60” tall during a MATCH.\n- The ROBOT weight must not exceed 125 lbs [7].',
      new Map([[7, section]]),
    )
    expect(mid[0].find).toMatch(/^R01\./)
    expect(mid[1].find).toMatch(/^R02\./)
  })
})

describe('answers that cite badly', () => {
  const sources = [
    { n: 1, noteId: 'm', title: 'Manual', section: '7 ROBOT CONSTRUCTION RULES › 7.2 GENERAL ROBOT DESIGN' },
    { n: 2, noteId: 'm', title: 'Manual', section: '4 MATCH PLAY › 4.6 RULE VIOLATIONS' },
  ]
  it('a section cited by name gets its number; one not read is dropped with what pointed at it', () => {
    expect(citeByNumber('Max is 60 inches as per the rules outlined in [4 MATCH PLAY › 4.7 DRIVE TEAM] and [3 ARENA › 3.2.6 ROBOT STARTING LINES].', sources)).toBe('Max is 60 inches.')
    expect(citeByNumber('It starts at 40” tall (see [7.2 GENERAL ROBOT DESIGN]).', sources)).toBe('It starts at 40” tall (see [1]).')
    // checkboxes and links stay
    expect(citeByNumber('- [ ] Check it\n- [x] Done [the site](https://x.y)', sources)).toBe('- [ ] Check it\n- [x] Done [the site](https://x.y)')
  })
  it('a fact without a citation is cited to where it came from', () => {
    const texts = new Map([
      [1, 'R01. The ROBOT must start inside 36” long x 36” wide x 40” tall and not extend beyond 36” long x 36” wide x 60” tall during a MATCH.'],
      [2, '| +10 Pts | - ROBOT crossing the CENTER LINE - Being taller than 60-inches - Two (2) ROBOTS in the ZONE |'],
    ])
    expect(autoCite('The robot may be no more than 60 inches tall during a MATCH.', texts)).toBe('The robot may be no more than 60 inches tall during a MATCH [1].')
    expect(autoCite('Hello there.', texts)).toBe('Hello there.')
    // in a table cell's list: that item
    expect(citeFinds('Being taller than 60-inches is a penalty [2].', texts)[0].find).toBe('Being taller than 60-inches')
  })
})

describe('the AI gets the line that answers it, and cites it', () => {
  const texts = new Map([
    [1, 'Each ROBOT that completely leaves their ALLIANCE STARTING LINE scores 5 pts.\n\nThe ROBOT may enter the ZONE at the start.'],
    [2, 'R01. The ROBOT must start a MATCH inside the STARTING VOLUME of 36” long x 36” wide x 40” tall and not extend beyond the ROBOT VOLUME of 36” long x 36” wide x 60” tall during a MATCH.\n\nR02. The ROBOT weight must not exceed 125 lbs.'],
  ])
  it('the line most about the question comes first', () => {
    expect(keyLines(texts, ['maximum', 'height', 'robot'])[0]).toEqual({ n: 2, line: expect.stringMatching(/^R01\. The ROBOT must start/) })
  })
  it('a citation to a source that doesn’t say it moves to the one that does', () => {
    expect(recite('The maximum height of the robot is 60 inches tall [1].', texts)).toBe('The maximum height of the robot is 60 inches tall [2].')
    // one that does say it stays
    expect(recite('Leaving the STARTING LINE scores 5 pts [1].', texts)).toBe('Leaving the STARTING LINE scores 5 pts [1].')
  })
  it('a short list item cited to a note that doesn’t have it moves to the one that does (a meeting transcript cited for a chores list)', () => {
    const notes = new Map([
      [1, '## Notes\n🎙️ So I think we should ask the build team to split, and do the scrum in two groups. Do we need the lawn mower in the shop?'],
      [2, '# Sydney’s chores that I had no idea she did that I need to do\n- Feed Stache (cat) every morning\n- Water Lawn\n- Walk dogs\n\nHouse projects:\n- Recess Fridge plug'],
    ])
    expect(reciteByWords('- Water Lawn [1]\n- Walk dogs [1]\n- Recess Fridge plug [1]\n- Feed Stache (cat) every morning [2]', notes)).toBe(
      '- Water Lawn [2]\n- Walk dogs [2]\n- Recess Fridge plug [2]\n- Feed Stache (cat) every morning [2]',
    )
    // the answer's own summing up, cited to the transcript: to the chores note it describes
    expect(reciteByWords('These were listed as Sydney’s chores I need to do [1].', notes)).toBe('These were listed as Sydney’s chores I need to do [2].')
    // cited right: left alone – both say it, the one cited stays
    expect(reciteByWords('- Split the scrum into two groups [1]', notes)).toBe('- Split the scrum into two groups [1]')
  })
})

describe('what the answer left out', () => {
  it('the line most about the question, when the answer missed it, is added with its link', async () => {
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'rulesnote00001', title: 'Robot rules' }))
    await app.sync.change(noteDocName('rulesnote00001'), (doc) => {
      getContent(doc).insert(
        0,
        [
          'Robot rules',
          'Penalties: being taller than 60-inches is a 10 point penalty.',
          'R01. The ROBOT must start inside a STARTING VOLUME 40” tall and not extend beyond 60” tall during a MATCH.',
        ].map((t) => {
          const p = new Y.XmlElement('paragraph')
          p.insert(0, [new Y.XmlText(t)])
          return p
        }),
      )
    })
    const r = await askNotes(app.store, app.sync, app.ai, 'What is the maximum height of the robot?', null, {}, { notes: ['rulesnote00001'] })
    // the stand-in AI answers about T8 bins; what the note says about it is added
    expect(r.answer).toMatch(/From the note:\n- R01\. The ROBOT must start inside/)
    // and the penalty for the same 60” limit
    expect(r.answer).toMatch(/- Penalties: being taller than 60-inches is a 10 point penalty\. \[1\]/)
    expect(r.read).toHaveLength(1)
  })
})

describe('a table cell beside the line that answers it', () => {
  it('says what its row is under the column’s heading: a penalty, not points scored', () => {
    const texts = new Map([
      [1, 'R01. The ROBOT must start a MATCH inside the STARTING VOLUME of 36” long x 36” wide x 40” tall and not extend beyond the ROBOT VOLUME of 36” long x 36” wide x 60” tall during a MATCH.'],
      [2, 'Table 4-2: Rule Violation Summary Chart\n\n| PENALTY | Example Violations |\n| --- | --- |\n| +5 Pts | - Pinning longer than 3 seconds |\n| +10 Pts | - Possession of too many GAME PIECES - Being taller than 60-inches - Two (2) ROBOTS trapping |'],
    ])
    const lines = keyLines(texts, ['max', 'height', 'robot'], [], 4, 0.9).map((l) => l.line)
    expect(lines).toContain('PENALTY: +10 Pts – Being taller than 60-inches')
  })
})

describe('the big picture', () => {
  it('gives the note’s outline, follows “see section …”, and defines the terms the key lines use', async () => {
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    const filler = (t: string) => `${t} `.repeat(60)
    await mk(
      'bigpicmain0001',
      'Cookie Chaos manual',
      [
        '# 1 INTRODUCTION', filler('The program trains students.'),
        '# 4 MATCH PLAY', '## 4.6 RULE VIOLATIONS', '| PENALTY | Example Violations |', '| --- | --- |', '| +10 Pts | - Illegal contact in protected ZONES (see section 6.1.7 ZONE SPECIFIC RESTRICTIONS) - Being taller than 60-inches |',
        '# 6 RULES', '## 6.1 CONDUCT', filler('Be gracious.'), '### 6.1.7 ZONE SPECIFIC RESTRICTIONS', 'G21. A ROBOT may not contact an opponent inside its SAFE ZONE.',
        '# 7 ROBOT CONSTRUCTION RULES', '## 7.2 GENERAL ROBOT DESIGN', 'R01. The ROBOT must start inside the STARTING VOLUME and not extend beyond the ROBOT VOLUME of 36” x 36” x 60” tall during a MATCH.',
        '# A Appendix', '## A.1 DEFINITIONS', '- STARTING VOLUME: the space a ROBOT must fit inside at the start of a MATCH, 36” x 36” x 40” tall.', '- SAFE ZONE – the taped area in front of each ALLIANCE’s station.',
      ].join('\n\n'),
    )
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the max height of the robot?', null, {}, { notes: ['bigpicmain0001'] })
    const p = prompts.at(-1)!
    // the outline, the parts read marked
    expect(p).toMatch(/How "Cookie Chaos manual" is laid out[^\n]*\n- 1 INTRODUCTION\n- 4 MATCH PLAY: 4.6 RULE VIOLATIONS ★/)
    expect(p).toMatch(/- 7 ROBOT CONSTRUCTION RULES ★: 7.2 GENERAL ROBOT DESIGN ★/)
    expect(p).toContain('- A Appendix: A.1 DEFINITIONS')
    // what the penalty line points to
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the penalty for illegal contact in protected zones?', null, {}, { notes: ['bigpicmain0001'] })
    expect(prompts.at(-1)).toContain('G21. A ROBOT may not contact an opponent inside its SAFE ZONE.')
  })
  it('defines a term from the glossary of a manual the note refers to', async () => {
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk('glossmain00001', 'Trials manual', 'R01. The ROBOT must fit in its ROBOT VOLUME of 36” x 36” x 60” tall during a MATCH.\n\nR12. BUMPERS are required, built as described in the “A. Padding” section of R402.')
    await mk(
      'glossfrc000001',
      '2025 FRC Game Manual',
      ['# 8 ROBOT Construction Rules', 'R402 *BUMPER construction. BUMPERS must consist of the following:', 'Padding – foam.', '# 12 Glossary', '| Term | Definition |', '| --- | --- |', '| ROBOT VOLUME | the space a ROBOT may occupy: its STARTING VOLUME, and what it may extend into during a MATCH |', '| MATCH | a 2 minute 40 second period of play |'].join('\n\n'),
    )
    setAskRefs(app.store, 'glossmain00001', ['glossfrc000001'])
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the max height of the robot?', null, {}, { notes: ['glossmain00001'] })
    const p = prompts.at(-1)!
    expect(p).toContain('Terms these lines use, as your notes define them:')
    expect(p).toContain('- ROBOT VOLUME: ROBOT VOLUME – the space a ROBOT may occupy')
    expect(p).toContain('(in "2025 FRC Game Manual")')
  })
})

describe('a citation where the sentence names its section', () => {
  it('goes to that section', () => {
    const texts = new Map([
      [3, '| +10 Pts | - Being taller than 60-inches |'],
      [6, '| Revision | Description | Date |\n| 1.0.0 | Initial Game Release | TBD |'],
    ])
    const sources = [
      { n: 3, noteId: 'm', title: 'Manual', section: '4 MATCH PLAY › 4.6 RULE VIOLATIONS' },
      { n: 6, noteId: 'm', title: 'Manual', section: 'Revisions' },
    ]
    expect(recite('A robot over this limit would be penalized under Rule 4.6 RULE VIOLATIONS [6].', texts, sources)).toBe('A robot over this limit would be penalized under Rule 4.6 RULE VIOLATIONS [3].')
  })
})

describe('the bumper rules', () => {
  const texts = new Map([
    [1, 'R401 BUMPERS all around. ROBOTS are required to use BUMPERS to protect the entire ROBOT PERIMETER. Gaps of less than 1 ¼ in. (31 mm) between adjacent segments are permitted as long as all corners are filled per R406.'],
    [2, 'R403 BUMPER extension limit. BUMPERS must not extend more than 4 in. (101 mm) from the ROBOT PERIMETER.'],
  ])
  it('"cutout" finds the rule about gaps', () => {
    expect(keyLines(texts, ['robot', 'cutout', 'bumper'])[0].n).toBe(1)
  })
  it('"4 in. (~101 mm)" isn’t the end of a sentence', () => {
    expect(autoCite('BUMPERS must not extend more than 4 in. (~101 mm) from the ROBOT PERIMETER.', texts)).toBe(
      'BUMPERS must not extend more than 4 in. (~101 mm) from the ROBOT PERIMETER [2].',
    )
  })
})

describe('the AI reasoning past the notes', () => {
  it('"would violate" too', () => {
    expect(markInference('Therefore, any cut-out would violate these rules as it would create a gap [5].')).toBe(
      "*(Not stated in the note – the AI's inference:)* Therefore, any cut-out would violate these rules as it would create a gap.",
    )
  })
  it('is marked as its inference, without a citation', () => {
    const answer =
      '- R406 specifies how corners must be filled [3].\nGiven these points, it can be inferred that cutouts would not be allowed under FRC rules [3]. The emphasis on filling gaps suggests that any openings are prohibited.'
    expect(markInference(answer)).toBe(
      "- R406 specifies how corners must be filled [3].\n*(Not stated in the note – the AI's inference:)* Given these points, it can be inferred that cutouts would not be allowed under FRC rules. *(Not stated in the note – the AI's inference:)* The emphasis on filling gaps suggests that any openings are prohibited.",
    )
  })
})

describe('a "no" against a rule that allows it', () => {
  it('is flagged', async () => {
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'bumpernote0001', title: 'Bumper rules' }))
    await app.sync.change(noteDocName('bumpernote0001'), (doc) => {
      getContent(doc).insert(
        0,
        ['Bumper rules', 'R401 BUMPERS all around. ROBOTS are required to use BUMPERS to protect the entire ROBOT PERIMETER. Gaps of less than 1 ¼ in. (31 mm) between adjacent segments are permitted as long as all corners are filled per R406.'].map((t) => {
          const p = new Y.XmlElement('paragraph')
          p.insert(0, [new Y.XmlText(t)])
          return p
        }),
      )
    })
    const r = await askNotes(app.store, app.sync, app.ai, 'Can a robot have a cutout in its bumper?', null, {}, { notes: ['bumpernote0001'] })
    expect(r.answer).toMatch(/\*\*Check this:\*\* the answer says no, but the note’s most relevant line allows some of it \(“Gaps of less than 1 ¼ in\. \(31 mm\) between adjacent segments are permitted/)
  })
})

describe('a note that refers to another (its manual)', () => {
  it('reads the rules it mentions from the note it refers to', async () => {
    const mk = async (id: string, lines: string[]) => {
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
    await mk('cookiemanual01', ['Cookie Chaos manual', 'R12. BUMPERS are required, and shall be constructed as described in the "A. Padding" section of R402 from the FRC 2025 Game Manual. Gaps in the bumpers are permissible.'])
    const frc = ['FRC 2025 Game Manual', ...Array.from({ length: 40 }, (_, i) => `R${300 + i} Some other rule about wiring number ${i}. ` + 'Wires must be colored and labelled. '.repeat(8))]
    frc.push('R402 BUMPER construction. A. Padding – A minimum of 2 1/4 in. depth of foam padding, at least 4 1/2 in. tall.')
    await mk('frcmanual2025a', frc)
    // without the reference: only its own note
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'How must bumpers be constructed?', null, {}, { notes: ['cookiemanual01'] })
    expect(prompts.at(-1)).not.toContain('2 1/4 in. depth of foam')
    // with it: R402's definition comes along
    setAskRefs(app.store, 'cookiemanual01', ['frcmanual2025a'])
    prompts.length = 0
    const r = await askNotes(app.store, app.sync, app.ai, 'How must bumpers be constructed?', null, {}, { notes: ['cookiemanual01'] })
    expect(prompts.at(-1)).toContain('R402 BUMPER construction. A. Padding – A minimum of 2 1/4 in. depth of foam')
    expect(r.read).toContain('FRC 2025 Game Manual')
    // the AI is told which is the main document, and the referenced one's sections say so
    expect(prompts.at(-1)).toContain('"Cookie Chaos manual" is the main document')
    expect(prompts.at(-1)).toMatch(/REFERENCED DOCUMENT \(applies only where "Cookie Chaos manual" points to it – it uses only “A. Padding” of R402 from it\) – "FRC 2025 Game Manual"/)
    // and only that: none of its other rules
    expect(prompts.at(-1)).not.toContain('Some other rule about wiring')
    // and what R12 points to comes right after it in the lines most about the question
    const key = prompts.at(-1)!.split('The lines of the notes above most about the question')[1]
    expect(key).toMatch(/R12\. BUMPERS are required[^\n]*\n\[\d+\] \(R402 in "FRC 2025 Game Manual", which that rule points to\) R402 BUMPER construction\. A\. Padding/)
  })
  it('a manual split into chapters: the rule pointed to is read from the chapter that has it, not the one chosen', async () => {
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk('splitmain00001', 'Cookie Chaos rules', 'R12. BUMPERS are required, and shall be constructed as described in the “A. Padding” section of R402 from the FRC 2025 Game Manual.')
    await mk('splitcontents1', '2025GameManual – Contents', '- 7 Robot Construction\n- 8 Inspection')
    await mk('splitchapter71', '7 Robot Construction', 'R301 Wires must be labelled.\n\nR402 *BUMPERS must be constructed as follows:\n\nA. Padding: pool noodles of 2 1/2 in. diameter.\n\nB. Backing: 3/4 in. plywood.')
    await mk('splitchapter81', '8 Inspection', 'R501 Every robot is inspected before it plays.')
    app.store.setSetting('webImports', {
      split1: { id: 'split1', url: 'https://pdf.reconnotes/2025GameManual.pdf', follow: false, maxPages: 1, splitPdf: true, folderId: null, contentsNoteId: 'splitcontents1', at: 0, pages: {
        a: { noteId: 'splitchapter71', hash: '', at: 0, importedOn: '', title: '7 Robot Construction' },
        b: { noteId: 'splitchapter81', hash: '', at: 0, importedOn: '', title: '8 Inspection' },
      } },
    })
    // the contents note chosen as the manual
    setAskRefs(app.store, 'splitmain00001', ['splitcontents1'])
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the A. Padding section of R402?', null, {}, { notes: ['splitmain00001'] })
    expect(prompts.at(-1)).toContain('pool noodles of 2 1/2 in. diameter')
    // only the part pointed to, and nothing from the chapters it doesn't point to
    expect(prompts.at(-1)).not.toContain('3/4 in. plywood')
    expect(prompts.at(-1)).not.toContain('Wires must be labelled')
    expect(prompts.at(-1)).not.toContain('Every robot is inspected')
    // "Anything" asked in the note's chat is given the same
    const about = noteContext(app.store, app.sync, 'splitmain00001', 'what is the A. Padding section of R402?')
    expect(about).toContain('R12. BUMPERS are required')
    expect(about).toContain('R402 in "7 Robot Construction"')
    expect(about).toContain('pool noodles of 2 1/2 in. diameter')
    expect(about).not.toContain('3/4 in. plywood')
    app.store.setSetting('webImports', {})
  })
  it('a reference in a folder left out of search is still read – the manual as a PDF gives it, letters lost', async () => {
    const folder = 'nosearchfold01'
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      createFolder(ws, { id: folder, name: 'Game Manuals' })
      updateFolder(ws, folder, { noSearch: true })
    })
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title, folderId: folder }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk('nosearchmain01', 'MinneTrials 2026 Manual - Cookie Chaos', 'R12. BUMPERS are required, and shall be constructed as described in the “A. Padding” section of R402 from the FRC 2025 Game Manual. The lower edge of the bumpers should be no more than 2.5” above the ground.')
    await mk(
      'nosearchfrc001',
      '2025 FRC Game Manual',
      [
        'Figure 8-3 BUMPER coverage requirements',
        'R402 *BUMPER construction. BUMPERS must consist of the following:',
        'Padding – A minimum of 2 ¼ in. (~58 mm) depth of foam padding, at least 4 ½ in. (~114 mm) tall.',
        'Backing – 3/4 in. thick plywood.',
        'Cover – a durable rugged fabric.',
        'R403 *BUMPERS must not be wider than the robot.',
      ].join('\n\n'),
    )
    setAskRefs(app.store, 'nosearchmain01', ['nosearchfrc001'])
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the A. Padding section of R402?', null, {}, { notes: ['nosearchmain01'] })
    expect(prompts.at(-1)).toContain('A minimum of 2 ¼ in. (~58 mm) depth of foam padding')
    // only the padding part: not the backing or cover, nor the next rule
    expect(prompts.at(-1)).not.toContain('3/4 in. thick plywood')
    expect(prompts.at(-1)).not.toContain('not be wider than the robot')
    expect(noteContext(app.store, app.sync, 'nosearchmain01', 'what is the A. Padding section of R402?')).toContain('depth of foam padding')
  })
  it('a rule that runs on from one piece of a long section into the next is read whole', async () => {
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk('piecesmain0001', 'Cookie Chaos manual', 'R12. BUMPERS are required, and shall be constructed as described in the “A. Padding” section of R402 from the FRC 2025 Game Manual.')
    const intro = 'R401 *BUMPERS must protect all outside corners of the FRAME PERIMETER. ' + 'Each BUMPER segment covers the frame. '.repeat(42)
    const md = ['## 8.4 BUMPER Rules', intro, 'R402 *BUMPER construction. BUMPERS must consist of the following:', 'Padding – A minimum of 2 ¼ in. (~58 mm) depth of foam padding, at least 4 ½ in. (~114 mm) tall.', 'Backing – 3/4 in. thick plywood.', 'R403 *BUMPERS must not be wider than the robot.'].join('\n\n')
    await mk('piecesfrc00001', '2025 FRC Game Manual', md)
    // the rule's first line ends one piece of the section, its parts start the next
    const pieces = splitSections('piecesfrc00001', '2025 FRC Game Manual', md)
    expect(pieces.length).toBe(2)
    expect(pieces[0].text).toMatch(/consist of the following:$/)
    setAskRefs(app.store, 'piecesmain0001', ['piecesfrc00001'])
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the A. Padding section of R402?', null, {}, { notes: ['piecesmain0001'] })
    const key = prompts.at(-1)!.split('The lines of the notes above most about the question')[1]
    expect(key).toMatch(/\(R402 in "2025 FRC Game Manual", which that rule points to\) R402 \*BUMPER construction\. BUMPERS must consist of the following: Padding – A minimum of 2 ¼ in\./)
    expect(prompts.at(-1)).not.toContain('3/4 in. thick plywood')
  })
  it('a follow-up quotes the lines about itself, not the last question’s; a rule cut down twice says so once', async () => {
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk(
      'followupmain01',
      'Cookie Chaos rules',
      ['R05. ROBOTS must not be taller than 60 in. during a MATCH.', 'R06. At the start of a MATCH a ROBOT must fit within 36 in. x 36 in. x 40 in. tall.', 'R12. BUMPERS are required, and shall be constructed as described in the “A. Padding” section of R402 from the FRC 2025 Game Manual. Gaps in the bumpers and frame perimeter are permissible.', ...Array.from({ length: 8 }, (_, i) => `G${10 + i}. Teams must be polite in situation ${i}. ` + 'Be kind to others. '.repeat(10))].join('\n\n'),
    )
    await mk('followupfrc001', '2025 FRC Game Manual', 'R402 *BUMPER construction. BUMPERS must consist of the following:\n\nPadding – A minimum of 2 ¼ in. depth of foam. Section 8 ROBOT Construction Rules (R) V11 84 of 164 More padding words here.\n\nBacking – plywood.')
    setAskRefs(app.store, 'followupmain01', ['followupfrc001'])
    const r = await askNotes(app.store, app.sync, app.ai, 'what is the max allowed height of the robot?', null, {}, { notes: ['followupmain01'] }, [
      { question: 'what is the A. Padding section of R402?', answer: 'A minimum of 2 ¼ in. of foam [2].', sources: ['followupmain01', 'followupfrc001'] },
    ])
    expect(r.answer).not.toContain('R12. BUMPERS are required')
    expect(r.answer).not.toContain('R402 *BUMPER construction')
    // asked about R402 itself: its padding, the note on it once, no page footer
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'what is the A. Padding section of R402?', null, {}, { notes: ['followupmain01'] })
    const key = prompts.at(-1)!.split('The lines of the notes above most about the question')[1]
    expect(key).toContain('A minimum of 2 ¼ in. depth of foam')
    expect(key).not.toContain('84 of 164')
    expect(key.match(/Only “A\. Padding” of R402 applies here/g)?.length).toBe(1)
    // a question about bumpers, not about R402's padding: R12 answers it, R402 isn't put beside it
    prompts.length = 0
    const gaps = await askNotes(app.store, app.sync, app.ai, 'can the bumper perimeter have gaps in it?', null, {}, { notes: ['followupmain01'] })
    expect(prompts.at(-1)!.split('The lines of the notes above most about the question')[1]).toContain('Gaps in the bumpers and frame perimeter are permissible')
    expect(prompts.at(-1)!.split('The lines of the notes above most about the question')[1]).not.toContain('(R402 in')
    expect(gaps.answer).not.toContain('R402 *BUMPER construction')
    // …and one about padding materials still gets it
    prompts.length = 0
    await askNotes(app.store, app.sync, app.ai, 'how deep must the bumper padding be?', null, {}, { notes: ['followupmain01'] })
    expect(prompts.at(-1)!.split('The lines of the notes above most about the question')[1]).toContain('(R402 in')
  })
  it('a figure cited to a note that doesn’t give it is cited to the one that does', () => {
    expect(figuresIn('A minimum of 2 ¼ in. (~58 mm) depth, at least 4 ½ in. tall, per R402 [3]')).toEqual([2.25, 58, 4.5])
    expect(figuresIn('2 1/4 in. and 2.25 inches, rule G301, 1 or 2 robots')).toEqual([2.25, 2.25])
    // every way a fraction is written
    expect(figuresIn('2¼, 2-1/4, 2,25 and 2⁄4 more')).toEqual([2.25, 2.25, 2.25, 0.5])
    expect(figuresIn('⅝ in. bolts, 3/4 in. plywood, 1 ⅞ in. tube, 10 ⅜ in. wide')).toEqual([0.625, 0.75, 1.875, 10.375])
    // not dates, nor thousands
    expect(figuresIn('due 10/22, weighs 1,500 lb.')).toEqual([1500])
    const texts = new Map([
      [1, 'R12. BUMPERS are required … The lower edge of the bumpers should be no more than 2.5” above the ground. Gaps in the bumpers are permissible.'],
      [12, 'R402 *BUMPER construction. Padding – A minimum of 2 ¼ in. (~58 mm) depth of foam padding, at least 4 ½ in. (~114 mm) tall.'],
    ])
    expect(reciteByFigures('BUMPERS must include padding of depth (≥2.25 inches) and height (≥4.5 inches) [1], but gaps in their perimeter are allowed [1].', texts)).toBe(
      'BUMPERS must include padding of depth (≥2.25 inches) and height (≥4.5 inches) [12], but gaps in their perimeter are allowed [1].',
    )
    // the cited note gives it: stays
    expect(reciteByFigures('The lower edge must be at most 2.5 in. above the ground [1].', texts)).toBe('The lower edge must be at most 2.5 in. above the ground [1].')
  })
  it('a sentence from the referenced note only is labelled with it', () => {
    const noteOf = (n: number) => (n === 1 ? 'main' : 'frc')
    const title = (id: string) => (id === 'frc' ? '2025 FRC Game Manual' : null)
    expect(labelRefs('Gaps are permissible [1]. Gaps under 1¼ in. are allowed [3].', noteOf, title)).toBe(
      'Gaps are permissible [1]. *(2025 FRC Game Manual)* Gaps under 1¼ in. are allowed [3].',
    )
  })
})

describe('what a note refers to', () => {
  it('finds the manual it links to and the rules it uses, and says what is missing', async () => {
    const mk = async (id: string, title: string, md: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk(
      'refsmain000001',
      'Trials Manual',
      'R01. The robot must fit in a 36 in. cube.\n\nR12. BUMPERS shall be constructed as in R402 of the [FRC 2025 Game Manual](https://firstfrc.blob.core.windows.net/frc2025/Manual/2025GameManual.pdf), and padding per R499. Drive with a NEO550 motor.',
    )
    await mk('refsfrc0000001', '2025 FRC Game Manual', 'R401 BUMPERS all around.\n\nR402 BUMPER construction. Padding at least 2 1/4 in.')
    // the manual was uploaded from a device: the same PDF
    await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, 'refsfrc0000001', { source: 'https://pdf.reconnotes/2025GameManual.pdf' }))
    const r = findReferences(app.store, app.sync, 'refsmain000001')
    expect(r.documents.map((d) => [d.name, d.found.map((f) => f.noteId)])).toEqual([['FRC 2025 Game Manual', ['refsfrc0000001']]])
    expect(r.suggestions[0]).toEqual({ noteId: 'refsfrc0000001', title: '2025 FRC Game Manual', reasons: ['linked as “FRC 2025 Game Manual”', 'defines R402'], find: 'FRC 2025 Game Manual' })
    // a rule no note has; not a motor's model number
    expect(r.missingRules).toEqual(['R499'])
    expect(r.missing).toEqual([])
    // chosen: no longer suggested
    setAskRefs(app.store, 'refsmain000001', ['refsfrc0000001'])
    expect(findReferences(app.store, app.sync, 'refsmain000001').suggestions).toEqual([])
    // and where the note points to it, to go there
    expect(findReferences(app.store, app.sync, 'refsmain000001').mentions.refsfrc0000001).toBe('FRC 2025 Game Manual')
    // a part number isn't a rule: the game manual doesn't refer to the trials manual for "R01"
    await app.sync.change(noteDocName('refsfrc0000001'), (doc) =>
      void getContent(doc).insert(getContent(doc).length, markdownToNodes('Examples include Norgren regulator P/N R01-100-RNEA and Rev R0062.', { attach: () => null, noteFor: () => null })),
    )
    const back = findReferences(app.store, app.sync, 'refsfrc0000001')
    expect(back.suggestions.map((sg) => sg.noteId)).not.toContain('refsmain000001')
    expect(back.missingRules).toEqual([])
  })

  it('looks through a Google redirect, and does not suggest the note itself', async () => {
    expect(unwrapLink('https://www.google.com/url?q=https://www.chiefdelphi.com/uploads/short-url/abc.pdf&sa=D&ust=1')).toBe('https://www.chiefdelphi.com/uploads/short-url/abc.pdf')
    expect(unwrapLink('https://example.com/url?q=https://x.org')).toBe('https://example.com/url?q=https://x.org')
    const mk = async (id: string, title: string, md: string, source?: string) => {
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title }))
      if (source) await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, id, { source }))
      await app.sync.change(noteDocName(id), (doc) => void getContent(doc).insert(0, markdownToNodes(md, { attach: () => null, noteFor: () => null })))
    }
    await mk(
      'redirmain00001',
      'Cookie Manual 10-6-26',
      'MinneTrials\n\nCookie Chaos 2026 GAME MANUAL\n\nSee the [PARCEL PANIC Rules](https://www.google.com/url?q=https://www.chiefdelphi.com/uploads/short-url/g2T.pdf&sa=D) and the 2026 MinneTrials Game Manual.',
      'https://docs.google.com/document/d/e/XYZ/pub',
    )
    // a copy of the same document, and a note named like its own cover
    await mk('redircopy00001', 'MinneTrials 2026 Manual - Cookie Chaos', 'same', 'https://docs.google.com/document/d/e/XYZ/pub?pli=1')
    await mk('redirnamed0001', '2026 MinneTrials Game Manual', 'other')
    const r = findReferences(app.store, app.sync, 'redirmain00001')
    expect(r.missing.map((d) => d.url)).toEqual(['https://www.chiefdelphi.com/uploads/short-url/g2T.pdf'])
    expect(r.suggestions.map((s) => s.noteId)).not.toContain('redircopy00001')
    expect(r.suggestions.map((s) => s.noteId)).not.toContain('redirnamed0001')

    // ignored: set aside, and back
    setIgnoredRef(app.store, 'redirmain00001', 'doc:chiefdelphi.com/uploads/short-url/g2t.pdf', true)
    const off = findReferences(app.store, app.sync, 'redirmain00001')
    expect(off.missing).toEqual([])
    expect(off.ignored).toEqual([{ key: 'doc:chiefdelphi.com/uploads/short-url/g2t.pdf', kind: 'document', name: 'PARCEL PANIC Rules', detail: 'https://www.chiefdelphi.com/uploads/short-url/g2T.pdf', find: 'PARCEL PANIC Rules' }])
    setIgnoredRef(app.store, 'redirmain00001', 'doc:chiefdelphi.com/uploads/short-url/g2t.pdf', false)
    expect(findReferences(app.store, app.sync, 'redirmain00001').missing.length).toBe(1)
  })

  it('does not list the page the note was imported from', async () => {
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'selfsrc0000001', title: 'Rules' }))
    await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, 'selfsrc0000001', { source: 'https://example.org/rules/manual.pdf' }))
    await app.sync.change(noteDocName('selfsrc0000001'), (doc) =>
      void getContent(doc).insert(0, markdownToNodes('*From [example.org/rules/manual.pdf](https://example.org/rules/manual.pdf) · imported 2026-10-09*\n\nR1. Be kind.', { attach: () => null, noteFor: () => null })),
    )
    expect(findReferences(app.store, app.sync, 'selfsrc0000001').missing).toEqual([])
  })
})

describe('a manual that takes part of another one', () => {
  const R12 =
    'R12. BUMPERS are required, and shall be constructed as described in the “A. Padding” section of R402 from the FRC 2025 Game Manual. The padding may be attached via tape, zip ties, fabric or other durable, flexible material. The lower edge of the bumpers should be no more than 2.5” above the ground. BUMPERS are considered to be part of the robot volume. The BUMPERS are intended to cover as much of the outer extremities of your robot as possible to limit damage; gaps in the bumpers and frame perimeter are permissible.'
  const FRC = [
    'R401 *Use BUMPERS to protect all outside corners. Gaps between BUMPER segments must be less than 1¼ in.',
    '',
    'R402 *BUMPER construction. BUMPERS must be constructed as follows:',
    '',
    'A. Padding: a stacked pair of pool noodles, each at least 2½ in. (~64 mm) in diameter.',
    '',
    'B. Backing: ¾ in. thick plywood.',
    '',
    'D. Fastening: hook-and-loop tape and cable ties may not be used.',
    '',
    'R403 *BUMPERS must be removable.',
  ].join('\n')

  it('reads only the part it points to', () => {
    const pointed = pointedRules(R12, [FRC])
    expect([...pointed]).toEqual([['R402', 'A. Padding']])
    const only = onlyRules(FRC, pointed)
    expect(only).toContain('R402 *BUMPER construction.')
    expect(only).toContain('A. Padding: a stacked pair of pool noodles')
    for (const t of ['R401', 'Backing', 'cable ties', 'R403']) expect(only).not.toContain(t)
    expect(only).toContain('Only “A. Padding” of R402 applies here')
  })

  it('finds the part by its name when the PDF lost its letter ("• Padding – …")', () => {
    const frc = [
      'R402 *BUMPER construction. BUMPERS must consist of the following:',
      '',
      '- Padding – A minimum of 2 ¼ in. (~58 mm) depth of foam padding, of one of the following:',
      '- Pool noodles (hollow or solid) or backer rod',
      '- Foam floor tiles',
      '',
      'Multiple types of foam may be used within a single BUMPER.',
      '',
      '- Backing – A backer at least 4 ½ in. (~115 mm) tall.',
      '- Fastening System – hook-and-loop tape and cable ties may not be used.',
    ].join('\n')
    const only = onlyRules(frc, pointedRules(R12, [frc]))
    for (const t of ['Padding – A minimum of 2 ¼ in.', 'Pool noodles', 'Foam floor tiles', 'Multiple types of foam']) expect(only).toContain(t)
    for (const t of ['Backing', 'cable ties']) expect(only).not.toContain(t)
    // a citation goes to the rule's own words – never to Ask's note on what applies (it isn't in the note)
    const find = citeFinds('Padding must be foam of 2 ¼ in. depth, as only “A. Padding” of R402 applies here [1].', new Map([[1, only]]))[0].find
    expect(find).toBe('Padding – A minimum of 2')
  })

  it('the rule about the thing asked is the key line, whole – with its exceptions', () => {
    const texts = new Map([
      [1, `${R12}\n\nR01. The ROBOT must start a MATCH inside the STARTING VOLUME of 36” long x 36” wide x 40” tall. BUMPERS are included as part of this volume.`],
      [2, 'G15. Be careful around the COUNTER. ROBOTS may not touch any part of the COUNTER, excluding the BUMPER KICK.\n\nG19. A ROBOT may not use a COMPONENT outside its ROBOT PERIMETER (except its BUMPERS) to initiate contact.'],
    ])
    const key = keyLines(texts, ['kind', 'bumpers', 'robot', 'need'], [], 4, 0.9)
    expect(key[0]).toEqual({ n: 1, line: R12 })
    // its sentences aren't repeated on their own
    expect(key.filter((k) => k.line.startsWith('The lower edge'))).toEqual([])
  })

  it('leaves out bits of a sentence as "also in your notes"', () => {
    const md = [
      'G19. A ROBOT may not use a COMPONENT outside its ROBOT PERIMETER (except its BUMPERS) to initiate contact.',
      '',
      '- This isn’t combat robotics. ROBOT may not damage an opponent ROBOT in either of the following ways:',
      '- deliberately.',
      '- regardless of intent, by initiating contact inside an opponent’s ROBOT PERIMETER.',
    ].join('\n')
    const items = sectionItems(new Map([[1, md]]), ['bumpers', 'robot'])
    expect(items.map((i) => i.text)).toEqual(['This isn’t combat robotics. ROBOT may not damage an opponent ROBOT in either of the following ways:'])
  })
})
