import crypto from 'node:crypto'
import type { Store } from './store'
import { safeEqual } from './sync'

/**
 * Device keys
 * ===========
 *
 * Besides the server's main key (RECON_TOKEN), each device can have a key
 * of its own. A lost or sold device is then switched off on its own –
 * revoking its key disconnects it at once – and the other devices carry on.
 * Only a hash of each key is stored.
 */

export interface DeviceRow {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
  revokedAt: number | null
}

export type Caller = { kind: 'main' } | { kind: 'device'; id: string }

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

export class Devices {
  /** token hash → device id, for live devices */
  private byHash = new Map<string, string>()
  private seen = new Map<string, number>()

  constructor(
    private store: Store,
    private mainToken: string,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        revoked_at INTEGER
      );
    `)
    this.reload()
  }

  private reload() {
    this.byHash.clear()
    const rows = this.store.db.prepare('SELECT id, token_hash FROM devices WHERE revoked_at IS NULL').all() as { id: string; token_hash: string }[]
    for (const r of rows) this.byHash.set(r.token_hash, r.id)
  }

  /** Who is calling with this token (null: nobody we know). */
  check(token: string): Caller | null {
    if (!token) return null
    if (safeEqual(token, this.mainToken)) return { kind: 'main' }
    const id = this.byHash.get(hash(token))
    if (!id) return null
    // remember when each device was last here (at most once a minute)
    const now = Date.now()
    if ((this.seen.get(id) ?? 0) < now - 60_000) {
      this.seen.set(id, now)
      this.store.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, id)
    }
    return { kind: 'device', id }
  }

  list(): DeviceRow[] {
    return (
      this.store.db
        .prepare('SELECT id, name, created_at, last_seen, revoked_at FROM devices ORDER BY revoked_at IS NOT NULL, created_at DESC')
        .all() as { id: string; name: string; created_at: number; last_seen: number | null; revoked_at: number | null }[]
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen, revokedAt: r.revoked_at }))
  }

  /** A new device key. The key itself is returned only now. */
  add(name: string): { device: DeviceRow; token: string } {
    const id = crypto.randomBytes(9).toString('hex')
    const token = `rn_${crypto.randomBytes(24).toString('base64url')}`
    const clean = name.trim().slice(0, 60) || 'Device'
    const now = Date.now()
    this.store.db
      .prepare('INSERT INTO devices (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
      .run(id, clean, hash(token), now, null)
    this.byHash.set(hash(token), id)
    return { device: { id, name: clean, createdAt: now, lastSeen: null, revokedAt: null }, token }
  }

  rename(id: string, name: string): boolean {
    return this.store.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.trim().slice(0, 60) || 'Device', id).changes > 0
  }

  revoke(id: string): boolean {
    const changed = this.store.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id).changes > 0
    this.reload()
    return changed
  }

  /** Forget a revoked device altogether. */
  remove(id: string): boolean {
    const removed = this.store.db.prepare('DELETE FROM devices WHERE id = ? AND revoked_at IS NOT NULL').run(id).changes > 0
    this.reload()
    return removed
  }
}
