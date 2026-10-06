import crypto from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../src/store'
import { Apns } from '../src/apns'
import { Notifier } from '../src/notify'
import type { Job } from '../src/jobs'

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

interface Got {
  env: string
  path: string
  headers: http2.IncomingHttpHeaders
  body: Record<string, unknown>
}
const got: Got[] = []
/** tokens each fake Apple server knows */
const known: Record<string, Set<string>> = { production: new Set(), sandbox: new Set() }
const gone = new Set<string>()

function fakeApple(env: string) {
  const server = http2.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const token = String(req.headers[':path']).split('/').pop()!
      got.push({ env, path: String(req.headers[':path']), headers: req.headers, body: JSON.parse(raw) })
      // the signed bearer token must verify with the key's public half
      const [h, p, sig] = String(req.headers.authorization).replace('bearer ', '').split('.')
      const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))
      if (!ok) return res.writeHead(403).end(JSON.stringify({ reason: 'InvalidProviderToken' }))
      if (gone.has(token)) return res.writeHead(410).end(JSON.stringify({ reason: 'Unregistered' }))
      if (!known[env].has(token)) return res.writeHead(400).end(JSON.stringify({ reason: 'BadDeviceToken' }))
      res.writeHead(200).end()
    })
  })
  return server
}

let dir: string
let store: Store
let apns: Apns
const servers = [fakeApple('production'), fakeApple('sandbox')]

beforeAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const url = (s: http2.Http2Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-apns-'))
  store = new Store(dir)
  apns = new Apns(store, { production: url(servers[0]), sandbox: url(servers[1]) })
})

afterAll(() => {
  store.close()
  for (const s of servers) s.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

describe('push notifications through Apple', () => {
  it('checks the key and never shows it', () => {
    expect(() => apns.save({ keyId: 'abc', teamId: 'team', key: 'not a key' })).toThrow(/APNs key/)
    apns.save({ keyId: 'abc123', teamId: 'team42', bundleId: 'com.reconnotes.app', key: PEM })
    const v = apns.view()
    expect(v).toMatchObject({ keyId: 'ABC123', teamId: 'TEAM42', hasKey: true, ready: true })
    expect(JSON.stringify(v)).not.toContain('PRIVATE KEY')
  })

  it('sends a signed notification, and finds a sandbox (Xcode build) token', async () => {
    known.sandbox.add(TOKEN_A)
    apns.register(TOKEN_A, 'main', 'iPhone')
    const sent = await apns.send({ title: 'Hi', body: 'There', data: { noteId: 'n1' } })
    expect(sent).toBe(1)
    // production first, then sandbox, which knows it
    expect(got.map((g) => g.env)).toEqual(['production', 'sandbox'])
    const last = got.at(-1)!
    expect(last.path).toBe(`/3/device/${TOKEN_A}`)
    expect(last.headers['apns-topic']).toBe('com.reconnotes.app')
    expect(last.headers['apns-push-type']).toBe('alert')
    expect(last.body).toEqual({ aps: { alert: { title: 'Hi', body: 'There' }, sound: 'default' }, noteId: 'n1' })
    // remembered: the next one goes straight to the sandbox
    got.length = 0
    await apns.send({ title: 'Again', body: '' })
    expect(got.map((g) => g.env)).toEqual(['sandbox'])
  })

  it('forgets a device Apple says is gone', async () => {
    gone.add(TOKEN_A)
    expect(await apns.send({ title: 'x', body: 'y' })).toBe(0)
    expect(apns.devices()).toHaveLength(0)
  })

  it('a finished job notifies the device that asked for it', async () => {
    known.production.add(TOKEN_B)
    known.production.add(TOKEN_A.replace(/a/g, 'c'))
    apns.register(TOKEN_B, 'dev-ipad', 'Seth’s iPad')
    apns.register(TOKEN_A.replace(/a/g, 'c'), 'dev-phone', 'Seth’s iPhone')
    const notifier = new Notifier(store, apns)
    got.length = 0
    const job = {
      id: 'job1',
      kind: 'ask',
      title: 'What did I need to order?',
      noteId: null,
      status: 'done',
      origin: 'user',
      device: 'Seth’s iPad',
      createdAt: Date.now() - 5000,
      startedAt: Date.now() - 4000,
      finishedAt: Date.now(),
      input: { question: 'What did I need to order?' },
      result: { answer: 'Glasses' },
    } as unknown as Job
    notifier.jobFinished(job, 'Ask your notes')
    await new Promise((r) => setTimeout(r, 300))
    expect(got).toHaveLength(1)
    expect(got[0].path).toBe(`/3/device/${TOKEN_B}`)
    expect(got[0].body).toMatchObject({ aps: { alert: { title: 'Your notes have an answer' } }, question: 'What did I need to order?', jobId: 'job1' })

    // not while that device is open (it shows the result itself)
    got.length = 0
    notifier.seen('Seth’s iPad')
    notifier.jobFinished({ ...job, id: 'job2' }, 'Ask your notes')
    await new Promise((r) => setTimeout(r, 300))
    expect(got).toHaveLength(0)
  })
})
