import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'

const TOKEN = 'test-token-0123456789abcdef'
let app: App
let base: string
let wsUrl: string
let dir: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-devices-'))
  app = createApp(loadConfig({ RECON_TOKEN: TOKEN, RECON_DATA_DIR: dir }), { backups: false })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  const port = (app.server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/sync`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const call = async (token: string, method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

const waitFor = (cond: () => boolean, ms = 5000) =>
  new Promise<void>((resolve, reject) => {
    const start = Date.now()
    const tick = () => (cond() ? resolve() : Date.now() - start > ms ? reject(new Error('timed out')) : setTimeout(tick, 20))
    tick()
  })

describe('device keys', () => {
  it('gives a device its own key, and switching it off disconnects it', async () => {
    const made = await call(TOKEN, 'POST', '/api/devices', { name: "Seth's iPhone" })
    expect(made.status).toBe(201)
    const key: string = made.body.token
    expect(key).toMatch(/^rn_/)

    const check = await call(key, 'GET', '/api/auth/check')
    expect(check.body.caller).toEqual({ kind: 'device', id: made.body.device.id })
    expect((await call(TOKEN, 'GET', '/api/auth/check')).body.caller).toEqual({ kind: 'main' })

    // the phone syncs with its own key
    const socket = new HocuspocusProviderWebsocket({ url: wsUrl })
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: 'workspace', document: doc, token: key })
    provider.attach()
    await waitFor(() => provider.isSynced)

    const list = await call(TOKEN, 'GET', '/api/devices')
    expect(list.body.devices[0]).toMatchObject({ name: "Seth's iPhone", revokedAt: null })
    expect(list.body.devices[0].lastSeen).toBeGreaterThan(0)

    // lost phone: switch it off from another device
    let closed = false
    provider.on('close', () => (closed = true))
    const revoked = await call(TOKEN, 'POST', `/api/devices/${made.body.device.id}/revoke`)
    expect(revoked.body.devices[0].revokedAt).toBeGreaterThan(0)
    await waitFor(() => closed)
    expect((await call(key, 'GET', '/api/auth/check')).status).toBe(401)
    provider.destroy()
    socket.destroy()

    // the main key keeps working, and the revoked device can then be removed
    expect((await call(TOKEN, 'DELETE', `/api/devices/${made.body.device.id}`)).body.devices).toEqual([])
  })

  it('keeps device keys across restarts (only hashes are stored)', async () => {
    const { token } = (await call(TOKEN, 'POST', '/api/devices', { name: 'iPad' })).body
    const raw = fs.readFileSync(path.join(dir, 'reconnotes.db'))
    expect(raw.includes(Buffer.from(token))).toBe(false)
    const again = new (await import('../src/devices')).Devices(app.store, TOKEN)
    expect(again.check(token)?.kind).toBe('device')
  })
})
