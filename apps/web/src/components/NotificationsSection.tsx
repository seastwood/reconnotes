import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Loader2, Send } from 'lucide-react'
import { api } from '../lib/api'
import { isSyncConfigured, settings, useSettings } from '../lib/settings'
import { setServerPush } from '../lib/jobs'
import { askNotificationPermission, notificationsSupported } from '../lib/notify'

interface ServerNotify {
  kind: 'off' | 'ntfy' | 'homeassistant' | 'webhook'
  url: string
  token: string
  hasToken: boolean
  service: string
  onDone: boolean
  onFailed: boolean
  minSeconds: number
}

const HELP: Record<ServerNotify['kind'], string> = {
  off: '',
  ntfy: 'Install the free ntfy app, subscribe to a topic with a hard-to-guess name, and enter its URL here (e.g. https://ntfy.sh/reconnotes-k3x9q2, or your own ntfy server). Tapping a notification opens the note.',
  homeassistant:
    'Uses the Home Assistant companion app on your phone. Enter Home Assistant’s address, a long-lived access token (your profile › Security), and the notify service for your phone, e.g. mobile_app_seths_iphone.',
  webhook: 'Sends JSON { title, message, link, failed } to this URL (Gotify, n8n, Node-RED…). An optional token is sent as a Bearer token.',
}

/**
 * Settings › Notifications: a notification when a job you started (convert,
 * transcribe, summarise, compile…) finishes or fails.
 */
export function NotificationsSection() {
  const local = useSettings((s) => Boolean(s.jobNotifications))
  const [denied, setDenied] = useState(false)
  const [srv, setSrv] = useState<ServerNotify | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const native = Capacitor.isNativePlatform()

  useEffect(() => {
    if (isSyncConfigured()) void api<ServerNotify>('GET', '/api/notify').then(setSrv).catch(() => {})
  }, [])

  const toggleLocal = async (on: boolean) => {
    if (on && !(await askNotificationPermission())) {
      setDenied(true)
      return
    }
    setDenied(false)
    settings.set({ jobNotifications: on })
  }

  const save = async (patch: Partial<ServerNotify> = {}) => {
    if (!srv) return
    setBusy('save')
    setMessage(null)
    try {
      const next = await api<ServerNotify>('PUT', '/api/notify', { ...srv, ...patch, token })
      setSrv(next)
      setToken('')
      setServerPush(next.kind !== 'off')
      setMessage('Saved.')
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    await save()
    setBusy('test')
    try {
      await api('POST', '/api/notify/test')
      setMessage('✓ Sent a test notification.')
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {notificationsSupported() && (
        <>
          <label className="check">
            <input type="checkbox" checked={local} onChange={(e) => void toggleLocal(e.target.checked)} />
            Notify me when a job I started here finishes or fails while the app is in the background
          </label>
          {denied && <p className="hint">Notifications are blocked. Allow them for ReconNotes in {native ? 'the iPhone’s Settings › Notifications' : 'your browser’s site settings'}, then try again.</p>}
          {native && (
            <p className="hint">
              iOS pauses the app soon after you leave it, so for jobs that finish later (or with the app closed) let your server send the
              notification too – below.
            </p>
          )}
        </>
      )}

      {srv && (
        <div className="notify-server">
          <label>
            Server notifications (even when the app is closed)
            <select value={srv.kind} onChange={(e) => setSrv({ ...srv, kind: e.target.value as ServerNotify['kind'] })}>
              <option value="off">Off</option>
              <option value="ntfy">ntfy app</option>
              <option value="homeassistant">Home Assistant companion app</option>
              <option value="webhook">Webhook</option>
            </select>
          </label>
          {srv.kind !== 'off' && (
            <>
              <p className="hint">{HELP[srv.kind]}</p>
              <label>
                {srv.kind === 'ntfy' ? 'Topic URL' : srv.kind === 'homeassistant' ? 'Home Assistant address' : 'URL'}
                <input
                  type="url"
                  value={srv.url}
                  placeholder={srv.kind === 'ntfy' ? 'https://ntfy.sh/your-secret-topic' : srv.kind === 'homeassistant' ? 'http://homeassistant.local:8123' : 'https://…'}
                  onChange={(e) => setSrv({ ...srv, url: e.target.value })}
                />
              </label>
              {srv.kind === 'homeassistant' && (
                <label>
                  Notify service
                  <input value={srv.service} placeholder="mobile_app_your_phone" onChange={(e) => setSrv({ ...srv, service: e.target.value })} />
                </label>
              )}
              <label>
                {srv.kind === 'homeassistant' ? 'Long-lived access token' : 'Access token (optional)'}
                <input type="password" value={token} placeholder={srv.hasToken ? 'Saved – type to replace' : ''} onChange={(e) => setToken(e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={srv.onDone} onChange={(e) => setSrv({ ...srv, onDone: e.target.checked })} />
                When a job finishes
              </label>
              <label className="check">
                <input type="checkbox" checked={srv.onFailed} onChange={(e) => setSrv({ ...srv, onFailed: e.target.checked })} />
                When a job fails
              </label>
              <label>
                Only for jobs that took at least (seconds)
                <input type="number" min={0} max={3600} value={srv.minSeconds} onChange={(e) => setSrv({ ...srv, minSeconds: Number(e.target.value) })} />
              </label>
              <p className="hint">Nothing is sent while the device that asked is open on screen – it shows the result itself.</p>
            </>
          )}
          <div className="row">
            <button onClick={() => void save()} disabled={Boolean(busy)}>
              {busy === 'save' ? <Loader2 size={15} className="spin" /> : null} Save
            </button>
            {srv.kind !== 'off' && (
              <button onClick={() => void test()} disabled={Boolean(busy) || !srv.url}>
                {busy === 'test' ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Send a test
              </button>
            )}
          </div>
          {message && <p className="hint">{message}</p>}
        </div>
      )}
    </>
  )
}
