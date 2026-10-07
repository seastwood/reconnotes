import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createFolder, createNote, getContent, noteDocName, updateFolder } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
const F = { open: 'folderopen000001', secret: 'foldersecret0001', inner: 'foldersecretin01', quiet: 'folderquiet00001' }

async function addNote(id: string, folderId: string | null, text: string) {
  await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: text, folderId }))
  await app.sync.change(noteDocName(id), (doc) => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(`${text} pineapple`)])
    getContent(doc).insert(0, [p])
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-folders-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  await app.sync.change(WORKSPACE_DOC, (ws) => {
    createFolder(ws, { id: F.open, name: 'Work' })
    createFolder(ws, { id: F.secret, name: 'Private' })
    createFolder(ws, { id: F.inner, name: 'Diary', parentId: F.secret })
    createFolder(ws, { id: F.quiet, name: 'Archive' })
    updateFolder(ws, F.secret, { lock: { salt: '00', hash: 'ff', iter: 1 } })
    updateFolder(ws, F.quiet, { noSearch: true })
  })
  await addNote('noteopen00000001', F.open, 'Work plan')
  await addNote('notesecret000001', F.secret, 'Private plan')
  await addNote('noteinner0000001', F.inner, 'Diary entry')
  await addNote('notequiet0000001', F.quiet, 'Old plan')
  await addNote('noteloose0000001', null, 'Loose plan')
  app.sync.hocuspocus.flushPendingStores()
  await new Promise((r) => setTimeout(r, 400))
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const search = async (params: string) => {
  const res = await fetch(`${base}/api/search?q=pineapple${params}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  return ((await res.json()).hits as { noteId: string }[]).map((h) => h.noteId).sort()
}

describe('folders: locked, left out of search, searched on purpose', () => {
  it('leaves out locked folders (and their subfolders) and folders left out of search', async () => {
    expect(await search('')).toEqual(['noteloose0000001', 'noteopen00000001'])
  })
  it('includes a locked folder once it’s unlocked on the asking device', async () => {
    expect(await search(`&unlocked=${F.secret}`)).toEqual(['noteinner0000001', 'noteloose0000001', 'noteopen00000001', 'notesecret000001'])
  })
  it('searches only the chosen folders – even one left out of search', async () => {
    expect(await search(`&folders=${F.quiet}`)).toEqual(['notequiet0000001'])
    expect(await search(`&folders=${F.quiet},none`)).toEqual(['noteloose0000001', 'notequiet0000001'])
    // a locked one still needs unlocking
    expect(await search(`&folders=${F.secret}`)).toEqual([])
    expect(await search(`&folders=${F.secret}&unlocked=${F.secret}`)).toEqual(['noteinner0000001', 'notesecret000001'])
  })
})
