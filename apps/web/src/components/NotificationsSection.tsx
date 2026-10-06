import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Loader2, Send } from 'lucide-react'
import { api } from '../lib/api'
import { isSyncConfigured, settings, useSettings } from '../lib/settings'
import { setServerPush } from '../lib/jobs'
import { askNotificationPermission, notificationsSupported } from '../lib/notify'
import { disablePush, enablePush, pushSupported } from '../lib/push'

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
      <PushSection />
      {notificationsSupported() && !(native && pushSupported()) && (
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

interface PushView {
  keyId: string
  teamId: string
  bundleId: string
  hasKey: boolean
  ready: boolean
  devices: { name: string; createdAt: number; mine: boolean }[]
}

/**
 * Notifications like any other app's: the server sends them straight through
 * Apple (no other service). Needs an APNs key from your Apple developer account,
 * entered once (from any device), then switched on in the app on each iPhone / iPad.
 */
function PushSection() {
  const on = useSettings((s) => Boolean(s.pushNotifications))
  const [v, setV] = useState<PushView | null>(null)
  const [form, setForm] = useState({ keyId: '', teamId: '', bundleId: '', key: '' })
  const [setup, setSetup] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const app = pushSupported()

  useEffect(() => {
    if (!isSyncConfigured()) return
    void api<PushView>('GET', '/api/push')
      .then((r) => {
        setV(r)
        setForm({ keyId: r.keyId, teamId: r.teamId, bundleId: r.bundleId, key: '' })
      })
      .catch(() => {})
  }, [])
  if (!v) return null

  const run = async (what: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(what)
    setMsg(null)
    try {
      await f()
      if (ok) setMsg(ok)
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  const refresh = async () => setV(await api<PushView>('GET', '/api/push'))
  const saveKey = () =>
    run(
      'save',
      async () => {
        const r = await api<PushView>('PUT', '/api/push', { ...form, key: form.key || undefined })
        setV(r)
        setForm({ ...form, key: '' })
        if (r.ready) setSetup(false)
      },
      'Saved.',
    )

  return (
    <div className="push-section">
      <h4>Notifications on {app ? 'this device' : 'your iPhone and iPad'}</h4>
      <p className="hint">Straight from your server through Apple – they arrive like any other app’s, even with the app closed. No other service needed.</p>

      {app && v.ready && (
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            disabled={Boolean(busy)}
            onChange={(e) =>
              void run(
                'toggle',
                async () => {
                  if (e.target.checked) await enablePush()
                  else await disablePush()
                  await refresh()
                },
                e.target.checked ? '✓ This device will get a notification when a job it started finishes.' : undefined,
              )
            }
          />
          Notify me when a job I started here finishes or fails
        </label>
      )}
      {app && v.ready && on && (
        <div className="row">
          <button disabled={Boolean(busy)} onClick={() => void run('test', () => api('POST', '/api/push/test'), '✓ Sent – it should appear in a few seconds.')}>
            {busy === 'test' ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Send a test
          </button>
        </div>
      )}
      {!app && v.ready && (
        <p className="hint">
          Ready. Turn notifications on in the ReconNotes app on each iPhone / iPad (Settings › Notifications).
          {v.devices.length > 0 && ` Registered: ${v.devices.map((d) => d.name).join(', ')}.`}
        </p>
      )}

      {(!v.ready || setup) && (
        <div className="push-setup">
          <p className="hint">
            {v.ready ? 'Change the Apple key:' : 'One-time setup (needs a paid Apple Developer account, which the app also needs to receive notifications):'}
          </p>
          <ol className="hint">
            <li>developer.apple.com › Certificates, IDs &amp; Profiles › Keys › ＋, tick “Apple Push Notifications service (APNs)”, and download the .p8 file.</li>
            <li>Enter its Key ID, your Team ID (top right of the developer site) and paste the .p8 file’s contents below.</li>
            <li>On the Mac, switch push on for the app once: <code>npm run ios:enable-push -w @reconnotes/web</code>, then build and run from Xcode.</li>
          </ol>
          <label>
            Key ID
            <input value={form.keyId} placeholder="e.g. 2X9R4HXF34" autoCapitalize="characters" onChange={(e) => setForm({ ...form, keyId: e.target.value })} />
          </label>
          <label>
            Team ID
            <input value={form.teamId} placeholder="e.g. 9Q3XYZ1234" autoCapitalize="characters" onChange={(e) => setForm({ ...form, teamId: e.target.value })} />
          </label>
          <label>
            App bundle id
            <input value={form.bundleId} placeholder="com.reconnotes.app" autoCapitalize="off" onChange={(e) => setForm({ ...form, bundleId: e.target.value })} />
          </label>
          <label>
            APNs key (.p8)
            <textarea
              rows={4}
              value={form.key}
              placeholder={v.hasKey ? 'Saved – paste to replace' : '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <div className="row">
            <button disabled={Boolean(busy) || !form.keyId || !form.teamId || (!form.key && !v.hasKey)} onClick={() => void saveKey()}>
              {busy === 'save' ? <Loader2 size={15} className="spin" /> : null} Save
            </button>
            {v.ready && (
              <button className="text" onClick={() => setSetup(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {v.ready && !setup && (
        <button className="text" onClick={() => setSetup(true)}>
          Change the Apple key…
        </button>
      )}
      {msg && <p className="hint">{msg}</p>}
      <h4>Other ways</h4>
    </div>
  )
}
