import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, deleteNoteForever, extractNote, getContent, getNotes, noteDocName, readNote, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-restore-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

function setText(doc: Y.Doc, ...lines: string[]) {
  const c = getContent(doc)
  if (c.length) c.delete(0, c.length)
  c.insert(0, lines.map((t) => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(t)])
    return p
  }))
}

const text = (id: string) => extractNote(app.sync.getDoc(noteDocName(id))!).text
const meta = (id: string) => {
  const m = getNotes(app.sync.getDoc(WORKSPACE_DOC)!).get(id)
  return m ? readNote(m) : null
}

describe('restoring from a backup', () => {
  it('lists what changed and restores one note or the whole library', async () => {
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      createNote(ws, { id: 'restorenote01', title: 'Plan' })
      createNote(ws, { id: 'restorenote02', title: 'Parts' })
    })
    await app.sync.change(noteDocName('restorenote01'), (d) => setText(d, 'Plan', 'build the arm'))
    await app.sync.change(noteDocName('restorenote02'), (d) => setText(d, 'Parts', 'bumpers'))
    const made = await api('POST', '/api/backups')
    expect(made.status).toBe(201)
    const name = made.body.backup

    // afterwards: one note edited, one deleted for good, one new note
    await app.sync.change(noteDocName('restorenote01'), (d) => setText(d, 'Plan', 'oops, all gone'))
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      deleteNoteForever(ws, 'restorenote02')
      createNote(ws, { id: 'restorenote03', title: 'Newer' })
    })

    const list = await api('GET', '/api/backups')
    expect(list.body.details[0]).toMatchObject({ name, notes: 2 })
    const notes = await api('GET', `/api/backups/${name}/notes`)
    expect(Object.fromEntries(notes.body.notes.map((n: { id: string; status: string }) => [n.id, n.status]))).toEqual({
      restorenote01: 'changed',
      restorenote02: 'deleted',
    })

    // just one note
    const one = await api('POST', `/api/backups/${name}/restore`, { noteIds: ['restorenote01'] })
    expect(one.body.restored).toBe(1)
    expect(text('restorenote01')).toBe('Plan\nbuild the arm')
    expect(meta('restorenote02')).toBeNull()
    // its state before restoring is kept in its history
    expect(app.store.listVersions(noteDocName('restorenote01'))[0].label).toBe('Before restoring a backup')

    // everything
    await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, 'restorenote01', { title: 'Plan' }))
    const all = await api('POST', `/api/backups/${name}/restore`, { all: true })
    expect(all.body).toEqual({ restored: 1, trashed: 1 })
    expect(text('restorenote02')).toBe('Parts\nbumpers')
    expect(meta('restorenote02')?.trashedAt).toBeNull()
    expect(meta('restorenote03')?.trashedAt).not.toBeNull() // newer note: in Recently Deleted
  })

  it('refuses unknown backups', async () => {
    expect((await api('GET', '/api/backups/2020-01-01T00-00-00-000Z/notes')).status).toBe(404)
  })
})
