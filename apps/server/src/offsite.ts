import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Store } from './store'
import { log } from './log'
import { writeZip } from './zip'

/**
 * Offsite backups
 * ===============
 *
 * After each backup, a copy goes somewhere else, so a dead disk (or a fire)
 * doesn't take your notes with it:
 *
 *   folder – another disk: a NAS share or USB drive mounted on the server
 *   s3     – any S3-compatible storage: Backblaze B2, Wasabi, Cloudflare R2,
 *            MinIO, AWS S3…
 *
 * Layout (the same for both):
 *
 *   <prefix>/<backup time>/reconnotes.db      the database (restore = copy back)
 *   <prefix>/<backup time>/markdown.zip       every note as Markdown
 *   <prefix>/<backup time>/manifest.json
 *   <prefix>/blobs/<id>                       attachments, each uploaded once
 *
 * With a passphrase, every file but the manifest is encrypted (AES-256-GCM,
 * key from scrypt) and ends in ".enc" – decrypt with
 * `reconnotes-server decrypt <file or folder>` (RECON_BACKUP_PASSPHRASE).
 * The last `keep` copies are kept; older ones are deleted.
 */

export interface OffsiteSettings {
  kind: 'off' | 'folder' | 's3'
  folder: string
  s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string }
  /** '' = not encrypted */
  passphrase: string
  keep: number
}

export interface OffsiteStatus {
  at: number
  ok: boolean
  message: string
  backup?: string
}

export const OFFSITE_DEFAULTS: OffsiteSettings = {
  kind: 'off',
  folder: '',
  s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'reconnotes', accessKeyId: '', secretAccessKey: '' },
  passphrase: '',
  keep: 14,
}

export function offsiteSettings(store: Store): OffsiteSettings {
  const s = store.getSetting<Partial<OffsiteSettings>>('offsite') ?? {}
  return { ...OFFSITE_DEFAULTS, ...s, s3: { ...OFFSITE_DEFAULTS.s3, ...(s.s3 ?? {}) } }
}

// ---------------------------------------------------------------------------
// Encryption

const MAGIC = Buffer.from('RNENC1')
const keys = new Map<string, Buffer>()
const keyFor = (passphrase: string, salt: Buffer) => {
  const k = `${salt.toString('hex')}|${passphrase}`
  let key = keys.get(k)
  if (!key) {
    key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    keys.set(k, key)
  }
  return key
}

/** RNENC1 | salt (16) | iv (12) | tag (16) | ciphertext */
export function encrypt(data: Buffer, passphrase: string, salt: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(passphrase, salt), iv)
  const body = Buffer.concat([c.update(data), c.final()])
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body])
}

export function decrypt(data: Buffer, passphrase: string): Buffer {
  if (!data.subarray(0, 6).equals(MAGIC)) throw new Error('not a ReconNotes encrypted file')
  const salt = data.subarray(6, 22)
  const iv = data.subarray(22, 34)
  const tag = data.subarray(34, 50)
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(passphrase, salt), iv)
  d.setAuthTag(tag)
  try {
    return Buffer.concat([d.update(data.subarray(50)), d.final()])
  } catch {
    throw new Error('wrong passphrase (or the file is damaged)')
  }
}

// ---------------------------------------------------------------------------
// S3 (Signature Version 4, no SDK)

const sha256 = (d: Buffer | string) => crypto.createHash('sha256').update(d).digest('hex')
const hmac = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest()
/** RFC 3986 encoding, as S3 wants it (keeps "/" between key parts) */
const encodePath = (p: string) =>
  p
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')

/** The Authorization header for a request (AWS Signature Version 4). */
export function signV4(r: {
  method: string
  host: string
  path: string
  query?: string
  headers: Record<string, string>
  payloadHash: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  amzDate: string
}): string {
  const service = r.service ?? 's3'
  const all: Record<string, string> = { host: r.host, ...Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])) }
  const names = Object.keys(all).sort()
  const canonical = [r.method, r.path, r.query ?? '', names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), r.payloadHash].join('\n')
  const day = r.amzDate.slice(0, 8)
  const scope = `${day}/${r.region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', r.amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${r.secretAccessKey}`, day), r.region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
}

async function s3(c: OffsiteSettings['s3'], method: 'PUT' | 'DELETE' | 'HEAD', key: string, body?: Buffer): Promise<Response> {
  const base = new URL(c.endpoint.includes('://') ? c.endpoint : `https://${c.endpoint}`)
  // AWS itself wants the bucket in the host name; the others take it in the path
  const virtual = /amazonaws\.com$/i.test(base.hostname)
  const host = virtual ? `${c.bucket}.${base.host}` : base.host
  const p = encodePath(`${base.pathname.replace(/\/$/, '')}${virtual ? '' : `/${c.bucket}`}/${key}`)
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = sha256(body ?? '')
  const headers: Record<string, string> = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const authorization = signV4({ method, host, path: p, headers, payloadHash, region: c.region || 'us-east-1', accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, amzDate })
  const res = await fetch(`${base.protocol}//${host}${p}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!res.ok && !(method === 'DELETE' && res.status === 404) && !(method === 'HEAD' && res.status === 404)) {
    const text = await res.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
    throw new Error(`storage said ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`)
  }
  return res
}

// ---------------------------------------------------------------------------
// Destinations

interface Target {
  /** the same destination (so attachments already there aren't sent again) */
  id: string
  put(key: string, data: Buffer): Promise<void>
  remove(key: string): Promise<void>
}

function target(s: OffsiteSettings): Target {
  const prefix = (s.kind === 's3' ? s.s3.prefix : '').replace(/^\/+|\/+$/g, '')
  const full = (key: string) => (prefix ? `${prefix}/${key}` : key)
  if (s.kind === 'folder') {
    const root = path.resolve(s.folder)
    if (!s.folder.trim() || !fs.existsSync(root)) throw new Error(`The folder ${s.folder || '(none)'} doesn't exist on the server – is the drive mounted?`)
    return {
      id: `folder:${root}`,
      async put(key, data) {
        const f = path.join(root, key)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(`${f}.tmp`, data)
        fs.renameSync(`${f}.tmp`, f)
      },
      async remove(key) {
        fs.rmSync(path.join(root, key), { force: true })
        // an empty backup folder goes too
        const dir = path.dirname(path.join(root, key))
        if (dir !== root && fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
      },
    }
  }
  if (s.kind === 's3') {
    const c = s.s3
    if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKey) throw new Error('Fill in the endpoint, bucket and both keys.')
    return {
      id: `s3:${c.endpoint}|${c.bucket}|${prefix}`,
      put: async (key, data) => void (await s3(c, 'PUT', full(key), data)),
      remove: async (key) => void (await s3(c, 'DELETE', full(key))),
    }
  }
  throw new Error('Offsite copies are off.')
}

/** Write and delete a small file, to check the settings work. */
export async function testOffsite(s: OffsiteSettings): Promise<void> {
  const t = target(s)
  const key = `.reconnotes-test-${Date.now()}`
  await t.put(key, Buffer.from('ReconNotes can write here.'))
  await t.remove(key)
}

/** Copy one local backup (a directory written by runBackup) offsite. */
export async function copyOffsite(store: Store, backupDir: string, blobDir: string): Promise<OffsiteStatus> {
  const s = offsiteSettings(store)
  if (s.kind === 'off') return { at: Date.now(), ok: true, message: 'off' }
  const stamp = path.basename(backupDir)
  const started = Date.now()
  let status: OffsiteStatus
  try {
    const t = target(s)
    // one salt per destination: the key is worked out once per run
    let salt = store.getSetting<string>('offsiteSalt')
    if (!salt) store.setSetting('offsiteSalt', (salt = crypto.randomBytes(16).toString('hex')))
    const enc = (d: Buffer) => (s.passphrase ? encrypt(d, s.passphrase, Buffer.from(salt!, 'hex')) : d)
    const ext = s.passphrase ? '.enc' : ''

    // the database and the Markdown copy
    await t.put(`${stamp}/reconnotes.db${ext}`, enc(fs.readFileSync(path.join(backupDir, 'reconnotes.db'))))
    const mdDir = path.join(backupDir, 'markdown')
    const files: { name: string; data: Buffer; modified?: Date }[] = []
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) walk(f)
        else files.push({ name: path.relative(mdDir, f).split(path.sep).join('/'), data: fs.readFileSync(f), modified: fs.statSync(f).mtime })
      }
    }
    walk(mdDir)
    await t.put(`${stamp}/markdown.zip${ext}`, enc(writeZip(files)))

    // attachments not sent to this destination yet
    store.db.exec('CREATE TABLE IF NOT EXISTS offsite_blobs (target TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (target, id))')
    const sent = new Set((store.db.prepare('SELECT id FROM offsite_blobs WHERE target = ?').all(t.id + ext) as { id: string }[]).map((r) => r.id))
    const mark = store.db.prepare('INSERT OR IGNORE INTO offsite_blobs (target, id) VALUES (?, ?)')
    let blobs = 0
    const walkBlobs = async (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) await walkBlobs(f)
        else if (!e.name.endsWith('.tmp') && !sent.has(e.name)) {
          await t.put(`blobs/${e.name}${ext}`, enc(fs.readFileSync(f)))
          mark.run(t.id + ext, e.name)
          blobs++
        }
      }
    }
    await walkBlobs(blobDir)
    await t.put(`${stamp}/manifest.json`, Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), encrypted: Boolean(s.passphrase), newAttachments: blobs }, null, 2)))

    // keep the last `keep` copies at this destination
    const key = `offsiteCopies:${t.id}`
    const copies = [...new Set([...(store.getSetting<string[]>(key) ?? []), stamp])].sort()
    const drop = copies.slice(0, Math.max(0, copies.length - Math.max(1, s.keep)))
    // (encrypted or not: the passphrase may have changed since)
    for (const old of drop) for (const f of ['reconnotes.db', 'markdown.zip', 'reconnotes.db.enc', 'markdown.zip.enc', 'manifest.json']) await t.remove(`${old}/${f}`).catch(() => {})
    store.setSetting(key, copies.slice(drop.length))
    status = { at: Date.now(), ok: true, backup: stamp, message: `Copied to ${s.kind === 's3' ? s.s3.bucket : s.folder} in ${Math.round((Date.now() - started) / 1000)} s (${blobs} new attachment${blobs === 1 ? '' : 's'})${s.passphrase ? ', encrypted' : ''}.` }
    log.info(`offsite backup: ${status.message}`)
  } catch (err) {
    status = { at: Date.now(), ok: false, backup: stamp, message: (err as Error).message }
    log.warn(`offsite backup failed: ${status.message}`)
  }
  store.setSetting('offsiteStatus', status)
  return status
}

/** `reconnotes-server decrypt <file or folder>`: every .enc file next to itself, decrypted. */
export function decryptPath(target: string, passphrase: string): number {
  const st = fs.statSync(target)
  if (st.isDirectory()) return fs.readdirSync(target).reduce((n, f) => n + decryptPath(path.join(target, f), passphrase), 0)
  if (!target.endsWith('.enc')) return 0
  fs.writeFileSync(target.slice(0, -4), decrypt(fs.readFileSync(target), passphrase))
  return 1
}
