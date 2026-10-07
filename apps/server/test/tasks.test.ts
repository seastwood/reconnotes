import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, extractTasks, getContent, getNotes, noteDocName, readNote, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { lastSlot } from '../src/digest'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }
}

const isoIn = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function item(text: string, checked: boolean, due?: string, repeat?: string) {
  const li = new Y.XmlElement('taskItem')
  li.setAttribute('checked', checked as unknown as string)
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  if (due) {
    const d = new Y.XmlElement('dueDate')
    d.setAttribute('id', `due${Math.random().toString(36).slice(2, 10)}`)
    d.setAttribute('date', due)
    if (repeat) d.setAttribute('repeat', repeat)
    p.push([d])
  }
  li.insert(0, [p])
  return li
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-tasks-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const id = 'notetasks00000001'
  await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: 'Shop, plan' }))
  await app.sync.change(noteDocName(id), (doc) => {
    const list = new Y.XmlElement('taskList')
    list.insert(0, [item('Fix the gate', false, isoIn(-2)), item('Water plants', false, isoIn(1), 'weekly'), item('Buy milk', false), item('Paid rent', true)])
    getContent(doc).insert(0, [list])
  })
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('tasks', () => {
  it('lists every open to-do across notes, and ticks one', async () => {
    const open = (await api('GET', '/api/tasks')).body.tasks as { noteId: string; i: number; text: string; due?: string; title: string }[]
    expect(open.map((t) => t.text)).toEqual(['Fix the gate', 'Water plants', 'Buy milk'])
    expect(open[0].title).toBe('Shop, plan')
    expect((await api('GET', '/api/tasks?state=done')).body.tasks.map((t: { text: string }) => t.text)).toEqual(['Paid rent'])
    // changed since: refused
    expect((await api('POST', '/api/tasks/done', { noteId: open[2].noteId, i: 2, text: 'Buy bread' })).status).toBe(409)
    expect((await api('POST', '/api/tasks/done', { noteId: open[2].noteId, i: 2, text: 'Buy milk' })).status).toBe(200)
    expect((await api('GET', '/api/tasks')).body.tasks.map((t: { text: string }) => t.text)).toEqual(['Fix the gate', 'Water plants'])
  })

  it('moves a repeating one to its next date instead of ticking it', async () => {
    const before = (await api('GET', '/api/tasks')).body.tasks.find((t: { text: string }) => t.text === 'Water plants')
    expect((await api('POST', '/api/tasks/done', { noteId: before.noteId, i: before.i, text: 'Water plants' })).status).toBe(200)
    const doc = app.sync.getDoc(noteDocName(before.noteId))!
    const after = extractTasks(doc).find((t) => t.text === 'Water plants')!
    expect(after.done).toBe(false)
    expect(after.due! > before.due).toBe(true)
  })
})

describe('calendar feed', () => {
  it('is a secret address with the dated to-dos as all-day events', async () => {
    const { url } = (await api('GET', '/api/calendar')).body as { url: string }
    const feedPath = new URL(url).pathname
    expect((await fetch(`${base}/calendar/wrongwrongwrongwrongwrong.ics`)).status).toBe(404)
    const res = await fetch(base + feedPath) // no key: the address is the secret
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/calendar')
    const ics = await res.text()
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain(`DTSTART;VALUE=DATE:${isoIn(-2).replace(/-/g, '')}`)
    expect(ics).toContain('SUMMARY:Fix the gate')
    expect(ics).toContain('RRULE:FREQ=WEEKLY')
    expect(ics).toContain('From “Shop\\, plan”') // commas escaped
    expect(ics).not.toContain('Buy milk') // no date (and done)
    // a new address: the old one stops working
    const { url: fresh } = (await api('POST', '/api/calendar/reset')).body as { url: string }
    expect(fresh).not.toBe(url)
    expect((await fetch(base + feedPath)).status).toBe(404)
  })
})

describe('weekly digest', () => {
  it('runs at the chosen day and hour in the person’s time zone', () => {
    // Sunday 18:00 in UTC-6 (tzOffset 360) = Monday 00:00 UTC
    const s = { enabled: true, day: 0, hour: 18, tzOffset: 360 }
    const wedNoonUtc = Date.UTC(2026, 9, 7, 12)
    expect(new Date(lastSlot(s, wedNoonUtc)).toISOString()).toBe('2026-10-05T00:00:00.000Z')
    // just before the slot: the week before
    expect(new Date(lastSlot(s, Date.UTC(2026, 9, 11, 23, 59))).toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(new Date(lastSlot(s, Date.UTC(2026, 9, 12, 0, 1))).toISOString()).toBe('2026-10-12T00:00:00.000Z')
  })

  it('writes a note about the week, with links and what is overdue and coming up', async () => {
    // a note edited this week
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      const m = getNotes(ws).get('notetasks00000001')!
      updateNote(ws, 'notetasks00000001', { updatedAt: Date.now() })
      expect(readNote(m).title).toBe('Shop, plan')
    })
    const { body } = await api('POST', '/api/digest/run', { tzOffset: new Date().getTimezoneOffset() })
    const done = (await api('GET', `/api/jobs/${body.job.id}/wait`)).body.job
    expect(done.status).toBe('done')
    const noteId = done.result.noteId as string
    const md = app.sync.getDoc(noteDocName(noteId))!
    const text = getContent(md).toString()
    expect(text).toContain('Notes this week (1)')
    expect(text).toMatch(/notelink[^>]*shop, plan|noteLink[^>]*Shop, plan/i)
    expect(text).toContain('Overdue (1)')
    expect(text).toContain('Fix the gate')
    // the settings: on, at a time
    const s = (await api('PUT', '/api/digest', { enabled: true, day: 1, hour: 8, tzOffset: 300 })).body
    expect(s).toMatchObject({ enabled: true, day: 1, hour: 8, tzOffset: 300 })
    expect(s.lastRun).toBeGreaterThan(0) // no digest for a time already past
  })
})
