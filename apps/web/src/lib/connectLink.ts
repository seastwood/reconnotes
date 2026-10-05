import { settings } from './settings'

/**
 * Setup links: one tap connects a new device to the server with its own key.
 *
 *   https://notes.example.com/#connect=<data>   (opens the web app)
 *   reconnotes://connect?data=<data>             (opens the iOS app)
 *
 * <data> is base64url JSON { u: server address, t: device key }.
 */

const encode = (u: string, t: string) => btoa(JSON.stringify({ u, t })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function setupLinks(serverUrl: string, token: string): { web: string; app: string } {
  const data = encode(serverUrl.replace(/\/$/, ''), token)
  return { web: `${serverUrl.replace(/\/$/, '')}/#connect=${data}`, app: `reconnotes://connect?data=${data}` }
}

export function parseConnectData(data: string): { u: string; t: string } | null {
  try {
    const json = JSON.parse(atob(data.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json?.u === 'string' && typeof json?.t === 'string' && /^https?:\/\//.test(json.u) ? json : null
  } catch {
    return null
  }
}

/** Connect to the server in a setup link, after asking. Returns whether it did. */
export function applyConnectData(data: string): boolean {
  const c = parseConnectData(data)
  if (!c) return false
  const s = settings.get()
  if (s.serverUrl === c.u && s.token === c.t) return true
  const replacing = s.serverUrl && s.token ? `\n\nThis replaces the connection to ${s.serverUrl}.` : ''
  if (!confirm(`Connect this device to your ReconNotes server at ${c.u}?${replacing}`)) return false
  settings.set({ serverUrl: c.u, token: c.t })
  return true
}

/** The web app was opened from a setup link (#connect=…). */
export function handleConnectHash() {
  const m = /^#connect=([A-Za-z0-9_-]+)$/.exec(location.hash)
  if (!m) return
  history.replaceState(null, '', location.pathname + location.search)
  applyConnectData(m[1])
}

/** A name for this device, as a starting point. */
export function guessDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  return 'Browser'
}
