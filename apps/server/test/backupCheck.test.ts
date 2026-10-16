import fs from 'node:fs'
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-check-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
const api = async (method: string, p: string) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}` } })
  return res.json()
}

describe('checking a backup restores', () => {
  it('says so when there is no backup', async () => {
    const { check } = await api('POST', '/api/backups/check')
    expect(check.ok).toBe(false)
    expect(check.problems[0]).toMatch(/no backups/)
  })
  it('reads a fresh backup back – every note, and keeps the result', async () => {
    let id = ''
    await app.sync.change(WORKSPACE_DOC, (ws) => void (id = createNote(ws, { title: 'Kept' })))
    await app.sync.change(noteDocName(id), (d) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('Kept')])
      getContent(d).insert(0, [p])
    })
    // (making a backup checks it too: the first in a month)
    const { backup } = await api('POST', '/api/backups')
    const listed = await api('GET', '/api/backups')
    expect(listed.check.problems).toEqual([])
    expect(listed.check).toMatchObject({ backup, ok: true })
    expect(listed.check.notes).toBeGreaterThan(0)
    expect(listed.check.readable).toBe(listed.check.notes)
  })
  it('finds a damaged one', async () => {
    const { backups } = await api('GET', '/api/backups')
    const db = path.join(app.config.backupDir, backups[0], 'reconnotes.db')
    const bytes = fs.readFileSync(db)
    bytes.fill(0x41, 2000, bytes.length)
    fs.writeFileSync(db, bytes)
    const { check } = await api('POST', '/api/backups/check')
    expect(check.ok).toBe(false)
    expect(check.problems.length).toBeGreaterThan(0)
  })
})
