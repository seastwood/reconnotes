import crypto from 'node:crypto'
import http2 from 'node:http2'
import type { Store } from './store'
import { log } from './log'

/**
 * Push notifications to the iPhone / iPad app
 * ===========================================
 *
 * Straight from this server to Apple's push service (APNs) – no other service
 * in between. Apple requires a key for that: in your Apple Developer account,
 * Certificates, IDs & Profiles › Keys › + › "Apple Push Notifications
 * service (APNs)". You get a .p8 file, its Key ID, and your Team ID; enter
 * them in the app (Settings › Notifications) and they're kept here.
 *
 * Each installed app registers its device token with this server. Builds run
 * from Xcode use Apple's sandbox, TestFlight / App Store builds production:
 * a token is tried on the one it was last accepted by (production first).
 */

export interface ApnsConfig {
  keyId: string
  teamId: string
  /** the app's bundle id (the push "topic") */
  bundleId: string
  /** the .p8 key (PEM) */
  key: string
}

export interface PushDevice {
  token: string
  /** which device (key) registered it: notifications go to the device that asked */
  deviceId: string
  name: string
  env: 'production' | 'sandbox' | null
  createdAt: number
}

export interface PushMessage {
  title: string
  body: string
  /** extra data for the app (e.g. noteId to open when tapped) */
  data?: Record<string, string>
}

const KEY = 'apns'
const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' } as const

export class Apns {
  private jwt: { token: string; at: number } | null = null
  private sessions = new Map<string, http2.ClientHttp2Session>()

  constructor(
    private store: Store,
    /** Apple's servers (tests use their own) */
    private hosts: Record<'production' | 'sandbox', string> = HOSTS,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        token TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        name TEXT NOT NULL,
        env TEXT,
        created_at INTEGER NOT NULL
      );
    `)
  }

  config(): ApnsConfig | null {
    const c = this.store.getSetting<ApnsConfig>(KEY)
    return c?.keyId && c.teamId && c.bundleId && c.key ? c : null
  }

  /** What the app sees (never the key itself). */
  view(deviceId?: string) {
    const c = this.store.getSetting<Partial<ApnsConfig>>(KEY) ?? {}
    return {
      keyId: c.keyId ?? '',
      teamId: c.teamId ?? '',
      bundleId: c.bundleId ?? 'com.reconnotes.app',
      hasKey: Boolean(c.key),
      ready: Boolean(this.config()),
      devices: this.devices().map((d) => ({ name: d.name, createdAt: d.createdAt, mine: deviceId !== undefined && d.deviceId === deviceId })),
    }
  }

  save(patch: Partial<ApnsConfig>) {
    const cur = this.store.getSetting<Partial<ApnsConfig>>(KEY) ?? {}
    const key = patch.key?.trim()
    if (key && !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(key)) throw new Error('That doesn’t look like an APNs key: paste the whole .p8 file, including the BEGIN and END lines.')
    if (key) {
      try {
        crypto.createPrivateKey(key)
      } catch {
        throw new Error('That key can’t be read – paste the whole .p8 file.')
      }
    }
    const clean = (v: string | undefined, fallback: string | undefined) => (v !== undefined ? String(v).trim().slice(0, 200) : (fallback ?? ''))
    this.store.setSetting(KEY, {
      keyId: clean(patch.keyId, cur.keyId).toUpperCase(),
      teamId: clean(patch.teamId, cur.teamId).toUpperCase(),
      bundleId: clean(patch.bundleId, cur.bundleId) || 'com.reconnotes.app',
      key: patch.key === '-' ? '' : key || cur.key || '',
    })
    this.jwt = null
  }

  devices(): PushDevice[] {
    return (this.store.db.prepare('SELECT * FROM push_devices ORDER BY created_at').all() as { token: string; device_id: string; name: string; env: PushDevice['env']; created_at: number }[]).map((r) => ({
      token: r.token,
      deviceId: r.device_id,
      name: r.name,
      env: r.env,
      createdAt: r.created_at,
    }))
  }

  register(token: string, deviceId: string, name: string) {
    if (!/^[0-9a-f]{32,200}$/i.test(token)) throw new Error('not a device token')
    this.store.db
      .prepare('INSERT INTO push_devices (token, device_id, name, env, created_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(token) DO UPDATE SET device_id = excluded.device_id, name = excluded.name')
      .run(token.toLowerCase(), deviceId, name.slice(0, 100), Date.now())
  }

  unregister(token: string) {
    this.store.db.prepare('DELETE FROM push_devices WHERE token = ?').run(token.toLowerCase())
  }

  /** The signed token Apple wants (renewed every 50 minutes; Apple refuses ones older than an hour). */
  private bearer(c: ApnsConfig): string {
    if (this.jwt && Date.now() - this.jwt.at < 50 * 60_000) return this.jwt.token
    const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url')
    const head = `${b64({ alg: 'ES256', kid: c.keyId })}.${b64({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) })}`
    const sig = crypto.sign('sha256', Buffer.from(head), { key: c.key, dsaEncoding: 'ieee-p1363' })
    this.jwt = { token: `${head}.${b64(sig)}`, at: Date.now() }
    return this.jwt.token
  }

  private session(host: string): http2.ClientHttp2Session {
    let s = this.sessions.get(host)
    if (!s || s.closed || s.destroyed) {
      s = http2.connect(host)
      s.on('error', () => this.sessions.delete(host))
      s.on('close', () => this.sessions.delete(host))
      // don't keep the server process alive just for this
      s.unref()
      this.sessions.set(host, s)
    }
    return s
  }

  private post(env: 'production' | 'sandbox', c: ApnsConfig, token: string, payload: string): Promise<{ status: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const req = this.session(this.hosts[env]).request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${this.bearer(c)}`,
        'apns-topic': c.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      })
      req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL))
      let status = 0
      let body = ''
      req.on('response', (h) => (status = Number(h[':status'])))
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        let reason = ''
        try {
          reason = body ? ((JSON.parse(body) as { reason?: string }).reason ?? '') : ''
        } catch {
          reason = body.slice(0, 100)
        }
        resolve({ status, reason })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  /** Send to one device; returns false if Apple refused it. */
  async sendTo(d: PushDevice, m: PushMessage): Promise<boolean> {
    const c = this.config()
    if (!c) throw new Error('Push notifications aren’t set up: enter the APNs key in Settings › Notifications.')
    const payload = JSON.stringify({ aps: { alert: { title: m.title, body: m.body }, sound: 'default' }, ...(m.data ?? {}) })
    const order: ('production' | 'sandbox')[] = d.env === 'sandbox' ? ['sandbox', 'production'] : ['production', 'sandbox']
    let last = ''
    for (const env of order) {
      const r = await this.post(env, c, d.token, payload)
      if (r.status === 200) {
        if (d.env !== env) this.store.db.prepare('UPDATE push_devices SET env = ? WHERE token = ?').run(env, d.token)
        return true
      }
      last = `${r.status} ${r.reason}`
      // the token belongs to the other environment: try that one
      if (r.status === 400 && r.reason === 'BadDeviceToken') continue
      if (r.status === 410 || r.reason === 'Unregistered') {
        this.unregister(d.token)
        return false
      }
      if (r.status === 403) {
        this.jwt = null
        throw new Error(`Apple refused the key (${r.reason}) – check the Key ID, Team ID and .p8 key.`)
      }
      if (r.reason === 'TopicDisallowed' || r.reason === 'DeviceTokenNotForTopic') throw new Error(`Apple refused it (${r.reason}) – check the bundle id (${c.bundleId}).`)
      break
    }
    log.warn(`push to ${d.name} failed: ${last}`)
    return false
  }

  /** Send to the devices of `deviceIds` (all devices when null). Returns how many got it. */
  async send(m: PushMessage, deviceIds: string[] | null = null): Promise<number> {
    const targets = this.devices().filter((d) => !deviceIds || deviceIds.includes(d.deviceId))
    let sent = 0
    for (const d of targets) if (await this.sendTo(d, m)) sent++
    return sent
  }
}
