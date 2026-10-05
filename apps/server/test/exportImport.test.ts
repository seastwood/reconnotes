import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createFolder, createNote, extractNote, getContent, getNotes, getStrokes, listFolders, noteDocName, readNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { readZip, writeZip } from '../src/zip'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-export-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const auth = { Authorization: `Bearer ${TOKEN}` }
const notes = () => [...getNotes(app.sync.getDoc(WORKSPACE_DOC)!).values()].map(readNote)
const byTitle = (t: string) => notes().find((n) => n.title === t && !n.trashedAt)!
const textOf = (id: string) => extractNote(app.sync.getDoc(noteDocName(id))!).text

describe('export and import', () => {
  it('exports every note as Markdown with its pictures and drawings', async () => {
    const png = fs.readFileSync(path.join(__dirname, '../../web/public/icon-180.png'))
    await fetch(`${base}/api/attachments/exportpic0001`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png', 'X-File-Name': 'robot.png' }, body: new Uint8Array(png) })
    let folder = ''
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      folder = createFolder(ws, { name: 'Robotics' })
      createNote(ws, { id: 'exportnote01', folderId: folder, title: 'Build log' })
    })
    await app.sync.change(noteDocName('exportnote01'), (doc) => {
      const p = (t: string) => {
        const e = new Y.XmlElement('paragraph')
        e.insert(0, [new Y.XmlText(t)])
        return e
      }
      const img = new Y.XmlElement('image')
      img.setAttribute('attachmentId', 'exportpic0001')
      const drawing = new Y.XmlElement('drawing')
      drawing.setAttribute('drawingId', 'exportdraw01')
      getContent(doc).insert(0, [p('Build log'), p('Arm works'), img, drawing])
      getStrokes(doc, 'exportdraw01').push([{ id: 's1', tool: 'pen', color: '#000', size: 3, pts: [10, 10, 0.5, 200, 120, 0.5] }])
    })
    const res = await fetch(`${base}/api/export`, { headers: auth })
    expect(res.headers.get('content-type')).toBe('application/zip')
    const entries = readZip(Buffer.from(await res.arrayBuffer()))
    const names = entries.map((e) => e.name)
    expect(names).toContain('ReconNotes/Robotics/Build log.md')
    expect(names.some((n) => /^ReconNotes\/_files\/exportpi-robot\.png$/.test(n))).toBe(true)
    expect(names).toContain('ReconNotes/_drawings/exportdraw01.png')
    const md = entries.find((e) => e.name === 'ReconNotes/Robotics/Build log.md')!.data().toString()
    expect(md).toContain('![](../_files/exportpi-robot.png)')
    expect(md).toContain('![Drawing](../_drawings/exportdraw01.png)')
  })

  it('imports a zip of Markdown with folders, pictures, tasks and links', async () => {
    const png = fs.readFileSync(path.join(__dirname, '../../web/public/icon-180.png'))
    const zip = writeZip([
      { name: 'Vault/Projects/Arm.md', data: Buffer.from('# Arm\n\nSee [[Parts]] and **torque** specs.\n\n- [x] cut tubing\n- [ ] drill holes\n\n![photo](../img/arm%20photo.png)\n\n| Part | Qty |\n| --- | --- |\n| Bolt | 4 |\n') },
      { name: 'Vault/Parts.md', data: Buffer.from('Bumpers and bins') },
      { name: 'Vault/img/arm photo.png', data: png },
      { name: 'Vault/Projects/budget.pdf', data: Buffer.from('%PDF-1.4 fake') },
    ])
    const res = await fetch(`${base}/api/import`, { method: 'POST', headers: { ...auth, 'X-File-Name': 'vault.zip' }, body: new Uint8Array(zip) })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.notes).toBe(2)

    const arm = byTitle('Arm')
    const parts = byTitle('Parts')
    expect(listFolders(app.sync.getDoc(WORKSPACE_DOC)!).find((f) => f.id === arm.folderId)?.name).toBe('Projects')
    expect(parts.folderId).toBeNull()
    expect(arm.links).toEqual([parts.id])
    expect(textOf(parts.id)).toBe('Parts\nBumpers and bins') // file name became the title
    const xml = getContent(app.sync.getDoc(noteDocName(arm.id))!).toString()
    expect(xml).toContain('<taskitem checked="true">')
    expect(xml).toContain('<bold>torque</bold>')
    expect(xml).toMatch(/<image alt="photo" attachmentId="[a-z0-9]+">/)
    expect(xml).toContain('<table>')
    // the PDF nobody linked to: a file note in the same folder
    const pdf = byTitle('budget.pdf')
    expect(pdf.file?.mime).toBe('application/pdf')
    expect(pdf.folderId).toBe(arm.folderId)
  })

  it('imports a single Markdown file into a folder', async () => {
    let folder = ''
    await app.sync.change(WORKSPACE_DOC, (ws) => void (folder = createFolder(ws, { name: 'Inbox' })))
    const res = await fetch(`${base}/api/import?folderId=${folder}`, {
      method: 'POST',
      headers: { ...auth, 'X-File-Name': encodeURIComponent('Meeting notes.md') },
      body: '## Agenda\n\n1. Robot\n2. Budget\n',
    })
    expect(res.status).toBe(200)
    const n = byTitle('Meeting notes')
    expect(n.folderId).toBe(folder)
    expect(textOf(n.id)).toBe('Meeting notes\nAgenda\nRobot\nBudget')
  })
})
