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
import { dueDateIn } from '../src/timeRange'
import { groundMeetingNotes, meetingNotesText } from '../src/meetingNotes'

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
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }))
    if (req.url === '/api/ps' || req.url === '/api/tags') return res.end('{"models":[]}')
    if (!body) return res.end('{}')
    const j = JSON.parse(body)
    prompts.push(j.messages?.[0]?.content ?? '')
    const content = '## Summary\n- Doug orders the parts; the gym needs booking\n\n## Action items\n- [ ] Doug – order the parts by Friday\n- [ ] Book the gym'
    res.end(JSON.stringify({ message: { role: 'assistant', content }, done_reason: 'stop', eval_count: 5 }))
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-meeting-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  app.ai.agents.save({ name: 'Local', kind: 'ollama', baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}`, model: 'qwen2.5:7b', vision: false })
})

afterAll(async () => {
  await app.close()
  llm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('due dates from how they were said', () => {
  // Wednesday 7 October 2026, noon UTC
  const now = Date.UTC(2026, 9, 7, 12)
  it('understands weekdays, tomorrow, next week, end of month and written dates', () => {
    expect(dueDateIn('order the parts by Friday', now)).toBe('2026-10-09')
    expect(dueDateIn('call back tomorrow', now)).toBe('2026-10-08')
    expect(dueDateIn('send it next week', now)).toBe('2026-10-12')
    expect(dueDateIn('by the end of the month', now)).toBe('2026-10-31')
    expect(dueDateIn('paperwork by 10/22/26', now)).toBe('2026-10-22')
    expect(dueDateIn('on Wednesday', now)).toBe('2026-10-14') // today is Wednesday: the next one
    expect(dueDateIn('book the gym', now)).toBeNull()
  })
})

describe('meeting notes', () => {
  it('writes a summary and action items, with due dates where a day was said', async () => {
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'notemeeting00001', title: 'Meeting' }))
    await app.sync.change(noteDocName('notemeeting00001'), (doc) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('Attendees: Doug, Sophie')])
      getContent(doc).insert(0, [p])
    })
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    const job = (await api('POST', '/api/jobs', { kind: 'meeting', noteId: 'notemeeting00001', input: { attachmentId: 'nonexistent00001', transcript: 'Doug will order the parts by Friday. We need to book the gym.' } })).job
    const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
    expect(done.status).toBe('done')
    expect(prompts[0]).toContain('Doug will order the parts by Friday')
    // no speech-to-text on the server: the phone's reading, and the job says so
    expect(done.agent).toMatch(/^Apple speech recognition \(on the phone\) \+ /)
    expect(prompts[0]).toContain('Attendees: Doug, Sophie')
    const doc = app.sync.getDoc(noteDocName('notemeeting00001'))!
    const xml = getContent(doc).toString()
    expect(xml).toContain('Doug orders the parts; the gym needs booking')
    expect(xml).toMatch(/<taskitem[^>]*><paragraph>Doug – order the parts by Friday <duedate date="\d{4}-\d{2}-\d{2}"/)
    // no day said: no due date
    expect(xml).toMatch(/Book the gym<\/paragraph>/)
  })
})

describe('meeting notes stay with what was said', () => {
  it('leaves out invented people, projects and dates, and the echoed prompt', () => {
    // a 9-second recording, and what a small model made of it
    const transcript = 'Did you find new mortgages? Oh, I forgot you needed that.'
    const made = `## Summary
- Review progress on project X by next week.
- Schedule a team meeting for October 15th to discuss ongoing issues and solutions.
- Update financial reports by Friday.

## Decisions

## Action items
- [ ] John – review project status report (by Wednesday)
- [ ] Jane – schedule the team meeting for Oct 15th (next week)

Notes taken during the meeting:
Attendees:
John, Jane, Mike`
    const out = groundMeetingNotes(made, transcript, '')
    expect(out).not.toMatch(/John|Jane|Mike|project X|October|financial/)
    expect(out).toContain('## Summary\n- “Did you find new mortgages? Oh, I forgot you needed that.”')
    expect(out).toContain('## Action items\nNo action items.')
    expect(out).not.toContain('## Decisions')
  })

  it('keeps what was said, in other words', () => {
    const transcript = 'Doug will order the motor controllers by Friday. Sophie said the gym booking is done, so we keep Thursday practice.'
    const made = `## Summary
- Doug is ordering the motor controllers
- The gym is booked; Thursday practice stays

## Decisions
- Keep Thursday practice

## Action items
- [ ] Doug – order the motor controllers by Friday`
    expect(groundMeetingNotes(made, transcript, '')).toBe(made)
  })

  it('doesn\'t count the meeting template as notes', () => {
    expect(meetingNotesText('# Meeting – Wed, Oct 7 at 7:32 PM\n\nAttendees:\n\n## Notes\n')).toBe('')
    expect(meetingNotesText('# Meeting – Wed\n\nAttendees: Doug\n\n## Notes\nParts list')).toContain('Attendees: Doug')
  })
})

describe('a long meeting, heard by the server', () => {
  // ~25 minutes of talk: 3,500 words
  const sentence = (i: number) => `Topic ${i} was about the fence and the gate, and we agreed on item ${i}.`
  const long = Array.from({ length: 250 }, (_, i) => sentence(i + 1)).join(' ')

  it('is read in parts, cut between sentences, nothing lost', async () => {
    const { meetingParts } = await import('../src/ai')
    const parts = meetingParts(long, 7000)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts.slice(0, -1)) expect(p).toMatch(/\.$/)
    expect(parts.join(' ')).toBe(long)
  })

  it('writes notes on each part, then puts them together – and Whisper is used over the phone’s own reading', async () => {
    // a Whisper server: says what it heard, and what words it was told to expect
    let hint = ''
    const unloaded: string[] = []
    const whisper = http.createServer(async (req, res) => {
      // Speaches: lets go of the model once it's done, so the notes model gets the whole GPU
      if (req.method === 'DELETE') return unloaded.push(req.url!), res.end('{}')
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: unloaded.length ? [] : ['faster-whisper-large-v3-turbo'] }))
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = Buffer.concat(chunks).toString('latin1')
      hint = /name="prompt"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: long }))
    })
    await new Promise<void>((r) => whisper.listen(0, '127.0.0.1', () => r()))
    try {
      app.ai.agents.save({ name: 'Whisper', kind: 'openai', baseUrl: `http://127.0.0.1:${(whisper.address() as AddressInfo).port}/v1`, model: 'faster-whisper-large-v3-turbo', vision: false })
      app.ai.vocabulary!.setWords(['Doug', 'MinneTrials'])
      app.store.putAttachment({ id: 'meetingaudio0001', mime: 'audio/mp4', name: 'Recording.m4a', size: 4, created_at: Date.now() }, Buffer.from('fake'), 'skipped')
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'notemeeting00002', title: 'Long meeting' }))
      await app.sync.change(noteDocName('notemeeting00002'), (doc) => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText('Attendees: Doug')])
        const rec = new Y.XmlElement('audio')
        rec.setAttribute('attachmentId', 'meetingaudio0001')
        getContent(doc).insert(0, [p, rec])
      })
      prompts.length = 0
      const api = (m: string, p: string, b?: unknown) =>
        fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
      // "In memory" counts the speech-to-text model too – it shares the GPU
      expect((await api('GET', '/api/ai/health?fresh=1')).speech).toEqual([{ agent: 'Whisper', model: 'faster-whisper-large-v3-turbo' }])
      const job = (await api('POST', '/api/jobs', { kind: 'meeting', noteId: 'notemeeting00002', input: { attachmentId: 'meetingaudio0001', transcript: 'Locates try to keep up with the gas.' } })).job
      const done = (await api('GET', `/api/jobs/${job.id}/wait`)).job
      expect(done.error ?? done.status).toBe('done')
      // Whisper's reading, with your words as a hint – not the phone's
      expect(hint).toBe('Doug, MinneTrials.')
      expect(unloaded).toContain('/api/ps/faster-whisper-large-v3-turbo')
      expect(prompts.join('\n')).not.toContain('Locates try to keep up')
      // each part read, then all of them put together – the last minutes included
      const partPrompts = prompts.filter((p) => /This is part \d+ of \d+ of a meeting/.test(p))
      expect(partPrompts.length).toBeGreaterThanOrEqual(2)
      expect(partPrompts.at(-1)).toContain('Topic 250 was about')
      const final = prompts.at(-1)!
      expect(final).toContain('<parts>')
      expect(Number(/about (\d+) minutes/.exec(final)?.[1])).toBeGreaterThanOrEqual(20)
      // the job says who heard it
      expect(done.agent).toMatch(/^Whisper \+ /)
      // the recording is searchable by Whisper's reading
      expect(app.store.getAttachment('meetingaudio0001')?.text).toContain('Topic 250')
      // and the note knows who transcribed it (shown under the recording)
      const { getTranscripts } = await import('@reconnotes/core')
      await new Promise((r) => setTimeout(r, 50))
      expect(getTranscripts(app.sync.getDoc(noteDocName('notemeeting00002'))!).get('by:att:meetingaudio0001')).toBe('Whisper')

      // redone later, without the phone's reading – but the saved transcript is the phone's: Whisper hears it again
      const { APPLE_SPEECH, setTranscribedBy } = await import('../src/attachments')
      app.store.setAttachmentText('meetingaudio0001', 'Locates try to keep up with the gas.', 'done')
      setTranscribedBy(app.store, 'meetingaudio0001', APPLE_SPEECH)
      hint = ''
      const redo = (await api('POST', '/api/jobs', { kind: 'meeting', noteId: 'notemeeting00002', input: { attachmentId: 'meetingaudio0001' } })).job
      const again = (await api('GET', `/api/jobs/${redo.id}/wait`)).job
      expect(again.error ?? again.status).toBe('done')
      expect(again.agent).toMatch(/^Whisper \+ /)
      expect(hint).toBe('Doug, MinneTrials.')
      expect(app.store.getAttachment('meetingaudio0001')?.text).toContain('Topic 250')
    } finally {
      whisper.close()
    }
  })
})

describe('Transcribe on a recording', () => {
  it('replaces the recording’s own transcript – with the server’s speech-to-text, else the phone’s – and says who made it', async () => {
    let asked = ''
    const whisper = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') return res.end('{}')
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      asked = Buffer.concat(chunks).toString('latin1')
      // with word times, as Speaches / OpenAI give them for verbose_json
      const words = ['We', 'need', 'to', 'figure', 'out', 'plans', 'for', 'tomorrow.'].map((word, i) => ({ word: ` ${word}`, start: i * 0.4, end: i * 0.4 + 0.35 }))
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: 'We need to figure out plans for tomorrow.', words }))
    })
    await new Promise<void>((r) => whisper.listen(0, '127.0.0.1', () => r()))
    const { getTranscripts } = await import('@reconnotes/core')
    const { APPLE_SPEECH } = await import('../src/attachments')
    const api = (m: string, p: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json())
    const run = async (input: Record<string, unknown>) => (await api('GET', `/api/jobs/${(await api('POST', '/api/jobs', { kind: 'transcribe', noteId: 'transcribe0000001', input })).job.id}/wait`)).job
    try {
      // only this speech-to-text agent
      for (const a of app.ai.agents.chain('audio')) app.ai.agents.remove(a.id)
      const w = app.ai.agents.save({ name: 'Whisper turbo', kind: 'openai', baseUrl: `http://127.0.0.1:${(whisper.address() as AddressInfo).port}/v1`, model: 'faster-whisper-large-v3-turbo', vision: false })
      app.store.putAttachment({ id: 'transcribeaudio01', mime: 'audio/mp4', name: 'Recording.m4a', size: 4, created_at: Date.now() }, Buffer.from('fake'), 'skipped')
      app.store.setAttachmentText('transcribeaudio01', 'Testing, needing a mode, self-sack.', 'done')
      await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'transcribe0000001', title: 'Recording' }))
      await app.sync.change(noteDocName('transcribe0000001'), (doc) => {
        const rec = new Y.XmlElement('audio')
        rec.setAttribute('attachmentId', 'transcribeaudio01')
        getContent(doc).insert(0, [rec])
      })
      const done = await run({ attachmentId: 'transcribeaudio01' })
      expect(done.error ?? done.status).toBe('done')
      expect(done.agent).toMatch(/^Whisper turbo/)
      await new Promise((r) => setTimeout(r, 50))
      const tr = () => getTranscripts(app.sync.getDoc(noteDocName('transcribe0000001'))!)
      // the recording's transcript is replaced – nothing written into the note
      expect(tr().get('att:transcribeaudio01')).toBe('We need to figure out plans for tomorrow.')
      expect(tr().get('by:att:transcribeaudio01')).toBe('Whisper turbo')
      // with each word's time, to follow along as it plays
      expect(asked).toMatch(/name="response_format"\r\n\r\nverbose_json/)
      expect(asked).toMatch(/name="timestamp_granularities\[\]"\r\n\r\nword/)
      const { parseWordTimes } = await import('@reconnotes/core')
      const times = parseWordTimes(tr().get('timing:att:transcribeaudio01'))!
      expect(times.map((w) => w.word)).toEqual(['We', 'need', 'to', 'figure', 'out', 'plans', 'for', 'tomorrow.'])
      expect(times[7].start).toBeCloseTo(2.8)
      expect(getContent(app.sync.getDoc(noteDocName('transcribe0000001'))!).toString()).not.toContain('plans for tomorrow')

      // no speech-to-text on the server: the phone is asked, and its reading kept with the recording
      app.ai.agents.remove(w.id)
      const ask = await run({ attachmentId: 'transcribeaudio01' })
      expect(ask.result.needsDevice).toBe(true)
      const sent = await run({ attachmentId: 'transcribeaudio01', transcript: 'Testing meeting mode.' })
      void sent
      expect(sent.agent).toBe(APPLE_SPEECH)
      for (let i = 0; i < 40 && tr().get('att:transcribeaudio01') !== 'Testing meeting mode.'; i++) await new Promise((r) => setTimeout(r, 50))
      expect(tr().get('att:transcribeaudio01')).toBe('Testing meeting mode.')
      expect(tr().get('by:att:transcribeaudio01')).toBe(APPLE_SPEECH)
      // Apple's reading has no word times: Whisper's are gone with its words
      expect(tr().get('timing:att:transcribeaudio01')).toBeUndefined()

      // Apple's reading with its word times (from the phone): kept, to follow along – no server speech-to-text needed
      const withTimes = await run({
        attachmentId: 'transcribeaudio01',
        transcript: 'Testing meeting mode.',
        words: [{ word: 'Testing', start: 0.1, end: 0.6 }, { word: 'meeting', start: 0.7, end: 1.1 }, { word: 'mode.', start: 1.2, end: 1.5 }],
      })
      expect(withTimes.error ?? withTimes.status).toBe('done')
      for (let i = 0; i < 40 && !tr().get('timing:att:transcribeaudio01'); i++) await new Promise((r) => setTimeout(r, 50))
      expect(parseWordTimes(tr().get('timing:att:transcribeaudio01'))!.map((w) => w.start)).toEqual([0.1, 0.7, 1.2])
    } finally {
      whisper.close()
    }
  })
})
