import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { setupHttps } from '../src/tls'

const TOKEN = 'test-token-0123456789abcdef'
let dir: string
let app: App
let ca: Buffer

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-tls-'))
  const config = loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' })
  setupHttps(config, ['10.8.0.1', '127.0.0.1', 'notes.home'])
  ca = fs.readFileSync(path.join(dir, 'tls', 'ca.crt'))
  app = createApp(config, { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  await new Promise<void>((r) => app.secure!.listen(0, '127.0.0.1', () => r()))
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const get = (p: string, opts: https.RequestOptions = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: (app.secure!.address() as AddressInfo).port, path: p, ca, ...opts }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })

describe('https on a private address', () => {
  it('makes a certificate for the WireGuard address that Apple devices accept', () => {
    const cert = new X509Certificate(fs.readFileSync(path.join(dir, 'tls', 'server.crt')))
    expect(cert.subjectAltName).toContain('IP Address:10.8.0.1')
    expect(cert.subjectAltName).toContain('DNS:notes.home')
    expect(cert.verify(new X509Certificate(ca).publicKey)).toBe(true)
    const days = (Date.parse(cert.validTo) - Date.now()) / 86_400_000
    expect(days).toBeLessThanOrEqual(826) // Apple's limit
    expect(fs.statSync(path.join(dir, 'tls', 'ca.key')).mode & 0o077).toBe(0) // only the server can read the keys
  })

  it('serves the app and the API over https, trusted through the private CA', async () => {
    expect((await get('/api/health')).status).toBe(200)
    const r = await get('/api/jobs', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(r.status).toBe(200)
    // without the CA it isn't trusted
    await expect(get('/api/health', { ca: undefined })).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i)
  })

  it('syncs over wss://', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${(app.secure!.address() as AddressInfo).port}/sync`, { ca })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    ws.close()
  })

  it('offers the CA certificate to install, over plain http too', async () => {
    const res = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/ca.crt`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-x509-ca-cert')
    expect(Buffer.from(await res.arrayBuffer()).equals(ca)).toBe(true)
  })

  it('renews or adds an address with the same CA, so devices keep trusting it', () => {
    const r = setupHttps(app.config, ['10.8.0.1', '192.168.1.20'])
    expect(r.newCa).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'tls', 'ca.crt')).equals(ca)).toBe(true)
    expect(new X509Certificate(fs.readFileSync(r.cert)).subjectAltName).toContain('IP Address:192.168.1.20')
    expect(() => setupHttps(app.config, ['not a name!'])).toThrow(/isn't an IP address/)
  })
})
