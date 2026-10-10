import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createFolder, createNote, getContent, getStrokes, noteDocName, updateFolder, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
/** the share port (shared things only) */
let sharePort: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-shares-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  await new Promise<void>((r) => app.shareServer.listen(0, '127.0.0.1', () => r()))
  sharePort = `http://127.0.0.1:${(app.shareServer.address() as AddressInfo).port}`
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

describe('a shared folder', () => {
  const para = (t: string) => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(t)])
    return p
  }
  const json = (method: string, url: string, body?: unknown) =>
    fetch(base + url, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))

  it('shows everything in it – subfolders, notes, pictures – on the share port, and nothing else', async () => {
    const png = fs.readFileSync(path.join(__dirname, '../../web/public/icon-180.png'))
    for (const a of ['soupphoto001', 'secretpic001']) await fetch(`${base}/api/attachments/${a}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png' }, body: new Uint8Array(png) })
    await app.sync.change(WORKSPACE_DOC, (ws) => {
      createFolder(ws, { id: 'recipes00001', name: 'Recipes' })
      createFolder(ws, { id: 'soups0000001', name: 'Soups', parentId: 'recipes00001' })
      createFolder(ws, { id: 'locked000001', name: 'Private', parentId: 'recipes00001' })
      updateFolder(ws, 'locked000001', { lock: { salt: 'aa', hash: 'bb', iter: 1 } })
      createFolder(ws, { id: 'mine00000001', name: 'Mine' })
      createNote(ws, { id: 'chili0000001', title: 'Chili', folderId: 'recipes00001' })
      createNote(ws, { id: 'soup00000001', title: 'Tomato soup', folderId: 'soups0000001' })
      createNote(ws, { id: 'hidden000001', title: 'Hidden', folderId: 'locked000001' })
      createNote(ws, { id: 'diary0000001', title: 'Diary', folderId: 'mine00000001' })
    })
    await app.sync.change(noteDocName('chili0000001'), (doc) => {
      const p = para('Serve with ')
      const toSoup = new Y.XmlElement('noteLink')
      toSoup.setAttribute('noteId', 'soup00000001')
      toSoup.setAttribute('title', 'Tomato soup')
      const toDiary = new Y.XmlElement('noteLink')
      toDiary.setAttribute('noteId', 'diary0000001')
      toDiary.setAttribute('title', 'Diary')
      p.insert(1, [toSoup, new Y.XmlText(' or '), toDiary])
      getContent(doc).insert(0, [para('Chili'), p])
    })
    await app.sync.change(noteDocName('soup00000001'), (doc) => {
      const img = new Y.XmlElement('image')
      img.setAttribute('attachmentId', 'soupphoto001')
      getContent(doc).insert(0, [para('Tomato soup'), img])
    })
    await app.sync.change(noteDocName('diary0000001'), (doc) => {
      const img = new Y.XmlElement('image')
      img.setAttribute('attachmentId', 'secretpic001')
      getContent(doc).insert(0, [para('Diary'), img])
    })
    await app.sync.change(noteDocName('hidden000001'), (doc) => void getContent(doc).insert(0, [para('Hidden')]))

    // a folder with a password can't be shared
    expect((await json('POST', '/api/folders/locked000001/shares', { name: 'Sydney' })).status).toBe(409)
    const made = await json('POST', '/api/folders/recipes00001/shares', { name: 'Sydney' })
    expect(made.status).toBe(200)
    expect(made.body).toMatchObject({ kind: 'folder', name: 'Sydney', folderId: 'recipes00001', hasPasscode: false })
    expect(made.body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:8790/s/${made.body.id}$`))
    const link = `${sharePort}/s/${made.body.id}`

    const top = await (await fetch(link)).text()
    expect(top).toContain('Recipes')
    expect(top).toContain('Soups')
    expect(top).toContain('Chili')
    expect(top).not.toContain('Private') // a folder with a password stays out
    expect(top).not.toContain('Diary')
    expect(top).not.toContain('<script')

    const sub = await (await fetch(`${link}/f/soups0000001`)).text()
    expect(sub).toContain('Tomato soup')
    expect(sub).toContain(`/s/${made.body.id}`) // the way back up
    expect((await fetch(`${link}/f/locked000001`)).status).toBe(404)
    expect((await fetch(`${link}/f/mine00000001`)).status).toBe(404)

    const chili = await (await fetch(`${link}/n/chili0000001`)).text()
    expect(chili).toContain(`<a href="/s/${made.body.id}/n/soup00000001">Tomato soup</a>`) // shared too: followed
    expect(chili).toContain('<span class="link">Diary</span>') // not shared: just its name
    expect((await fetch(`${link}/n/soup00000001/a/soupphoto001`)).status).toBe(200)
    expect((await fetch(`${link}/n/soup00000001/a/secretpic001`)).status).toBe(404)
    expect((await fetch(`${link}/n/diary0000001`)).status).toBe(404)
    expect((await fetch(`${link}/n/diary0000001/a/secretpic001`)).status).toBe(404)
    expect((await fetch(`${link}/n/hidden000001`)).status).toBe(404)

    // the share port has nothing else: no app, no API (not even with the key), no other notes' links
    for (const p of ['/', '/api/health', '/api/notes', '/index.html', '/sync', '/ca.crt']) expect((await fetch(sharePort + p, { headers: auth })).status).toBe(404)
    expect((await fetch(`${sharePort}/api/folders/recipes00001/shares`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(404)

    // listed, with when it was last opened
    const list = await json('GET', '/api/shares')
    expect(list.body.shares.find((r: { id: string }) => r.id === made.body.id).lastSeenAt).toBeGreaterThan(0)

    // a note moved out of the folder isn't shared any more
    await app.sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, 'chili0000001', { folderId: 'mine00000001' }))
    expect((await fetch(`${link}/n/chili0000001`)).status).toBe(404)

    // stopped: gone
    await json('DELETE', `/api/shares/${made.body.id}`)
    expect((await fetch(link)).status).toBe(404)
    expect((await fetch(`${link}/n/soup00000001/a/soupphoto001`)).status).toBe(404)
  })

  it('a passcode: asked once on each device, and a new one asks again', async () => {
    const made = await json('POST', '/api/folders/soups0000001/shares', { name: 'Sydney', passcode: 'tea-time' })
    expect(made.body.hasPasscode).toBe(true)
    const link = `${sharePort}/s/${made.body.id}`
    const ask = await fetch(link)
    expect(await ask.text()).toContain('Enter the passcode')
    // its form may be sent here (only here: other pages allow no forms)
    expect(ask.headers.get('content-security-policy')).toContain("form-action 'self'")
    expect((await fetch(`${link}`, { headers: {} }).then((r) => r.headers.get('content-security-policy')))).not.toContain("form-action 'none'")
    expect((await fetch(`${link}/n/soup00000001`).then((r) => r.text()))).not.toContain('Tomato soup')
    expect((await fetch(`${link}/n/soup00000001/a/soupphoto001`)).status).toBe(404)

    const unlock = (passcode: string) =>
      fetch(`${link}/unlock`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passcode }) })
    expect((await unlock('wrong')).status).toBe(401)
    const ok = await unlock('tea-time')
    expect(ok.status).toBe(303)
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]
    expect(ok.headers.get('set-cookie')).toContain('HttpOnly')
    expect(await (await fetch(link, { headers: { cookie } })).text()).toContain('Tomato soup')
    expect((await fetch(`${link}/n/soup00000001/a/soupphoto001`, { headers: { cookie } })).status).toBe(200)

    // a new passcode: asked again
    await json('PATCH', `/api/shares/${made.body.id}`, { passcode: 'new-one' })
    expect(await (await fetch(link, { headers: { cookie } })).text()).toContain('Enter the passcode')
    // none: open to the link
    await json('PATCH', `/api/shares/${made.body.id}`, { passcode: null })
    expect(await (await fetch(link)).text()).toContain('Tomato soup')
    expect((await json('PATCH', `/api/shares/${made.body.id}`, { passcode: 'ab' })).status).toBe(400)
  })

  it('too many wrong passcodes: a pause', async () => {
    const made = await json('POST', '/api/folders/soups0000001/shares', { name: 'Someone', passcode: 'right-one' })
    const link = `${sharePort}/s/${made.body.id}`
    const unlock = (passcode: string) => fetch(`${link}/unlock`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passcode }) })
    for (let i = 0; i < 6; i++) expect((await unlock(`nope${i}`)).status).toBe(401)
    expect((await unlock('right-one')).status).toBe(429)
  })

  it('links use the address set in the app', async () => {
    expect((await json('PUT', '/api/share-address', { address: 'not an address' })).status).toBe(400)
    await json('PUT', '/api/share-address', { address: 'https://notes-sydney.example.com/' })
    const made = await json('POST', '/api/folders/soups0000001/shares', { name: 'Sydney' })
    expect(made.body.url).toBe(`https://notes-sydney.example.com/s/${made.body.id}`)
    await json('PUT', '/api/share-address', { address: '' })
  })
})
