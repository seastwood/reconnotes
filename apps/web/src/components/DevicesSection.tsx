import { useEffect, useState } from 'react'
import { Copy, KeyRound, Laptop, Pencil, Plus, Share, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { settings, useSettings } from '../lib/settings'
import { guessDeviceName, setupLinks } from '../lib/connectLink'

interface Device {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
  revokedAt: number | null
}
type Caller = { kind: 'main' } | { kind: 'device'; id: string }

function ago(ts: number | null): string {
  if (!ts) return 'never connected'
  const min = Math.round((Date.now() - ts) / 60_000)
  if (min < 2) return 'active now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Settings › Devices: each device can have its own key, so a lost one can be
 * switched off without changing the others.
 */
export function DevicesSection() {
  const serverUrl = useSettings((s) => s.serverUrl)
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [caller, setCaller] = useState<Caller | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [added, setAdded] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () =>
    api<{ devices: Device[]; caller: Caller }>('GET', '/api/devices')
      .then((r) => {
        setDevices(r.devices)
        setCaller(r.caller)
      })
      .catch((e) => setMessage(`❌ ${(e as Error).message}`))
  useEffect(() => void load(), [])

  const act = async (fn: () => Promise<unknown>) => {
    setMessage(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`)
    }
  }

  /** This device switches from the main key to a key of its own. */
  const ownKey = () => {
    const name = prompt('Name this device', guessDeviceName())
    if (name === null) return
    void act(async () => {
      const r = await api<{ token: string }>('POST', '/api/devices', { name })
      settings.set({ token: r.token })
      setMessage('✅ This device now has its own key.')
    })
  }

  const addDevice = () => {
    const name = prompt('Name the new device (e.g. “Work iPad”)', '')
    if (name === null) return
    void act(async () => {
      const r = await api<{ token: string; device: Device }>('POST', '/api/devices', { name })
      setAdded({ name: r.device.name, token: r.token })
    })
  }

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      prompt('Copy this:', text)
    }
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  const links = added ? setupLinks(serverUrl, added.token) : null
  const live = devices?.filter((d) => !d.revokedAt) ?? []
  const off = devices?.filter((d) => d.revokedAt) ?? []

  return (
    <div className="devices">
      <p className="hint">
        Give each device its own key. If one is lost, switch it off here – it’s disconnected at once and the others keep working.
      </p>
      {caller?.kind === 'main' && (
        <div className="setup-problem">
          <strong>This device uses the server’s main key</strong>
          <div>Give it a key of its own, so you can switch it off on its own later.</div>
          <button className="primary" onClick={ownKey}>
            <KeyRound size={15} /> Give this device its own key
          </button>
        </div>
      )}
      {devices && (
        <ul className="device-list">
          {live.map((d) => (
            <li key={d.id}>
              <Laptop size={16} />
              <span className="device-name">
                {d.name}
                {caller?.kind === 'device' && caller.id === d.id && <span className="this-device">this device</span>}
              </span>
              <span className="muted">{ago(d.lastSeen)}</span>
              <button
                className="icon"
                title="Rename"
                aria-label={`Rename ${d.name}`}
                onClick={() => {
                  const name = prompt('Rename device', d.name)
                  if (name) void act(() => api('PUT', `/api/devices/${d.id}`, { name }))
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                className="danger-text"
                onClick={() => {
                  const self = caller?.kind === 'device' && caller.id === d.id
                  if (!confirm(self ? 'Switch off THIS device? It will stop syncing until you connect it again.' : `Switch off “${d.name}”? It is disconnected at once and can’t sync again.`)) return
                  void act(() => api('POST', `/api/devices/${d.id}/revoke`))
                }}
              >
                Switch off
              </button>
            </li>
          ))}
          {off.map((d) => (
            <li key={d.id} className="revoked">
              <Laptop size={16} />
              <span className="device-name">{d.name}</span>
              <span className="muted">switched off</span>
              <button className="icon" title="Remove from the list" aria-label={`Remove ${d.name}`} onClick={() => void act(() => api('DELETE', `/api/devices/${d.id}`))}>
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button onClick={addDevice}>
          <Plus size={15} /> Add a device
        </button>
      </div>
      {added && links && (
        <div className="device-added">
          <strong>Key for {added.name}</strong>
          <p className="hint">Open one of these links on {added.name} to connect it – or enter the server address and this key in its Settings. The key is only shown now.</p>
          <code className="device-key">{added.token}</code>
          <div className="row">
            <button onClick={() => void copy('app', links.app)}>
              <Copy size={15} /> {copied === 'app' ? 'Copied' : 'Copy app link'}
            </button>
            <button onClick={() => void copy('web', links.web)}>
              <Copy size={15} /> {copied === 'web' ? 'Copied' : 'Copy web link'}
            </button>
            {'share' in navigator && (
              <button onClick={() => void navigator.share({ title: 'Connect to ReconNotes', url: links.app }).catch(() => undefined)}>
                <Share size={15} /> Share
              </button>
            )}
            <button className="text" onClick={() => setAdded(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {message && <p className="status">{message}</p>}
    </div>
  )
}
