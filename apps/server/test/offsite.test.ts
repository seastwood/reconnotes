import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { WORKSPACE_DOC, createNote, getContent, noteDocName } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { runBackup } from '../src/backup'
import { decrypt, decryptPath, encrypt, signV4 } from '../src/offsite'
import { readZip } from '../src/zip'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let dir: string
let fakeS3: http.Server
const puts: { method: string; url: string; auth: string; size: number }[] = []

const api = async (method: string, p: string, body?: unknown) =>
  (await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()

beforeAll(async () => {
  fakeS3 = http.createServer(async (req, res) => {
    let size = 0
    for await (const c of req) size += (c as Buffer).length
    puts.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ''), size })
    res.writeHead(req.headers.authorization?.includes('Credential=GOODKEY/') ? 200 : 403, { 'Content-Type': 'application/xml' })
    res.end(req.headers.authorization?.includes('Credential=GOODKEY/') ? '' : '<Error><Code>InvalidAccessKeyId</Code><Message>The key is not valid.</Message></Error>')
  })
  await new Promise<void>((r) => fakeS3.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-offsite-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'noteoffsite000001', title: 'Plans' }))
  await app.sync.change(noteDocName('noteoffsite000001'), (doc) => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText('Plans')])
    getContent(doc).insert(0, [p])
  })
  // an attachment
  fs.mkdirSync(path.join(app.store.blobDir, 'aa'), { recursive: true })
  fs.writeFileSync(path.join(app.store.blobDir, 'aa', 'blob0000000000aa'), 'picture bytes')
})

afterAll(async () => {
  await app.close()
  fakeS3.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('offsite backups', () => {
  it('signs S3 requests the way AWS documents (Signature Version 4)', () => {
    // AWS's own example: GET /test.txt from examplebucket, 24 May 2013
    const auth = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    })
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('encrypts so only the passphrase opens it', () => {
    const salt = Buffer.alloc(16, 7)
    const box = encrypt(Buffer.from('secret notes'), 'correct horse', salt)
    expect(box.includes(Buffer.from('secret notes'))).toBe(false)
    expect(decrypt(box, 'correct horse').toString()).toBe('secret notes')
    expect(() => decrypt(box, 'wrong')).toThrow(/wrong passphrase/)
  })

  it('copies each backup to another folder, attachments once, keeping the last few', async () => {
    const out = path.join(dir, 'nas')
    fs.mkdirSync(out)
    await api('PUT', '/api/offsite', { kind: 'folder', folder: out, keep: 2 })
    const first = path.basename(await runBackup(app.config, app.store, app.sync, { waitOffsite: true }))
    expect(fs.existsSync(path.join(out, first, 'reconnotes.db'))).toBe(true)
    expect(readZip(fs.readFileSync(path.join(out, first, 'markdown.zip'))).map((e) => e.name)).toContain('Plans.md')
    expect(fs.readFileSync(path.join(out, 'blobs', 'blob0000000000aa'), 'utf8')).toBe('picture bytes')
    const status = (await api('GET', '/api/offsite')).status
    expect(status.ok).toBe(true)
    expect(status.message).toMatch(/1 new attachment/)
    // again: the attachment isn't copied again; with keep 2, the oldest of three goes
    await new Promise((r) => setTimeout(r, 5))
    await runBackup(app.config, app.store, app.sync, { waitOffsite: true })
    expect((await api('GET', '/api/offsite')).status.message).toMatch(/0 new attachments/)
    await new Promise((r) => setTimeout(r, 5))
    await runBackup(app.config, app.store, app.sync, { waitOffsite: true })
    const copies = fs.readdirSync(out).filter((d) => /^\d{4}-/.test(d))
    expect(copies).toHaveLength(2)
    expect(copies).not.toContain(first)
  })

  it('encrypts the offsite copy with a passphrase, and decrypts it again', async () => {
    const out = path.join(dir, 'usb')
    fs.mkdirSync(out)
    const view = await api('PUT', '/api/offsite', { kind: 'folder', folder: out, passphrase: 'correct horse' })
    expect(view.passphrase).toBe('') // never sent back
    expect(view.hasPassphrase).toBe(true)
    const stamp = path.basename(await runBackup(app.config, app.store, app.sync, { waitOffsite: true }))
    expect(fs.existsSync(path.join(out, stamp, 'reconnotes.db'))).toBe(false)
    expect(fs.existsSync(path.join(out, stamp, 'reconnotes.db.enc'))).toBe(true)
    expect(fs.existsSync(path.join(out, 'blobs', 'blob0000000000aa.enc'))).toBe(true)
    expect(decryptPath(out, 'correct horse')).toBeGreaterThanOrEqual(3)
    expect(fs.readFileSync(path.join(out, 'blobs', 'blob0000000000aa'), 'utf8')).toBe('picture bytes')
    expect(readZip(fs.readFileSync(path.join(out, stamp, 'markdown.zip'))).map((e) => e.name)).toContain('Plans.md')
    await api('PUT', '/api/offsite', { clearPassphrase: true })
  })

  it('uploads to S3-compatible storage, signed, in the bucket and prefix', async () => {
    const endpoint = `http://127.0.0.1:${(fakeS3.address() as AddressInfo).port}`
    // a wrong key: the test says why
    const bad = await api('POST', '/api/offsite/test', { kind: 's3', s3: { endpoint, bucket: 'notes', accessKeyId: 'BADKEY', secretAccessKey: 'x' } })
    expect(bad).toEqual({ ok: false, error: 'storage said 403 InvalidAccessKeyId: The key is not valid.' })
    await api('PUT', '/api/offsite', { kind: 's3', s3: { endpoint, region: 'auto', bucket: 'notes', prefix: 'home/', accessKeyId: 'GOODKEY', secretAccessKey: 'shh' } })
    expect((await api('GET', '/api/offsite')).s3.secretAccessKey).toBe('')
    puts.length = 0
    const r = await api('POST', '/api/offsite/run')
    expect(r.message).toMatch(/Copied/)
    expect(r.ok).toBe(true)
    const urls = puts.filter((p) => p.method === 'PUT').map((p) => p.url)
    expect(urls.some((u) => /^\/notes\/home\/\d{4}-[^/]+\/reconnotes\.db$/.test(u))).toBe(true)
    expect(urls).toContain('/notes/home/blobs/blob0000000000aa')
    expect(puts[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=GOODKEY\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
  })
})
