import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, getStrokes, noteDocName, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-shares-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const auth = { Authorization: `Bearer ${TOKEN}` }

describe('share links', () => {
  it('shows one note to anyone with the link, safely, until sharing stops', async () => {
    const png = fs.readFileSync(path.join(__dirname, '../../web/public/icon-180.png'))
    await fetch(`${base}/api/attachments/sharepic00001`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png' }, body: new Uint8Array(png) })
    await fetch(`${base}/api/attachments/otherpic0001`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png' }, body: new Uint8Array(png) })
    await app.sync.change(WORKSPACE_DOC, (ws) => createNote(ws, { id: 'sharenote001', title: 'Trip plan' }))
    await app.sync.change(noteDocName('sharenote001'), (doc) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('Bring <script>alert(1)</script> snacks')])
      const img = new Y.XmlElement('image')
      img.setAttribute('attachmentId', 'sharepic00001')
      const d = new Y.XmlElement('drawing')
      d.setAttribute('drawingId', 'sharedraw001')
      getContent(doc).insert(0, [p, img, d])
      getStrokes(doc, 'sharedraw001').push([{ id: 's1', tool: 'pen', color: '#ff0000', size: 3, pts: [10, 10, 0.5, 300, 100, 0.5] }])
    })

    expect((await (await fetch(`${base}/api/notes/sharenote001/share`, { headers: auth })).json()).shared).toBe(false)
    const made = await (await fetch(`${base}/api/notes/sharenote001/share`, { method: 'POST', headers: auth })).json()
    expect(made.path).toMatch(/^\/s\/[A-Za-z0-9_-]{20,}$/)
    // sharing again gives the same link
    expect((await (await fetch(`${base}/api/notes/sharenote001/share`, { method: 'POST', headers: auth })).json()).path).toBe(made.path)

    const page = await fetch(base + made.path) // no key
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('Bring &lt;script&gt;alert(1)&lt;/script&gt; snacks')
    expect(html).not.toContain('<script>')
    expect(html).toContain(`${made.path}/a/sharepic00001`)

    expect((await fetch(`${base}${made.path}/a/sharepic00001`)).status).toBe(200)
    expect((await fetch(`${base}${made.path}/a/otherpic0001`)).status).toBe(404) // not in this note
    const svg = await fetch(`${base}${made.path}/d/sharedraw001.svg`)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(await svg.text()).toContain('fill="#ff0000"')

    // deleting the note hides it; stopping the share ends the link
    await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, 'sharenote001', { trashedAt: Date.now() }))
    expect((await fetch(base + made.path)).status).toBe(404)
    await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, 'sharenote001', { trashedAt: null }))
    expect((await fetch(base + made.path)).status).toBe(200)
    await fetch(`${base}/api/notes/sharenote001/share`, { method: 'DELETE', headers: auth })
    expect((await fetch(base + made.path)).status).toBe(404)
    expect((await fetch(`${base}${made.path}/a/sharepic00001`)).status).toBe(404)
  })
})
