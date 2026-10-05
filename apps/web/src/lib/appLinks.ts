import { Capacitor, registerPlugin } from '@capacitor/core'
import { Store } from './store'
import { applyConnectData } from './connectLink'

/**
 * Quick capture links
 * ===================
 *
 *   reconnotes://new[?text=…]  a new note (with that text)
 *   reconnotes://record        a new note, recording straight away
 *   reconnotes://scan          a new note, scanning straight away
 *   reconnotes://open?note=ID  open a note
 *   reconnotes://search?q=…    search
 *   reconnotes://connect?data= connect to a server (setup link)
 *
 * They come from the Home Screen / Lock Screen widget and Siri / Shortcuts
 * in the iOS app, and as #new, #record, #scan from the web app's own
 * home-screen shortcuts.
 */

export type LinkAction =
  | { kind: 'new'; text?: string; then?: 'record' | 'scan' }
  | { kind: 'open'; noteId: string }
  | { kind: 'search'; query: string }

interface AppLinksPlugin {
  take(): Promise<{ urls: string[] }>
  openExternal(options: { url: string }): Promise<void>
}
const AppLinks = registerPlugin<AppLinksPlugin>('AppLinks')

/** Links that may be opened from a note (never javascript: and the like). */
export function openableUrl(href: string): string | null {
  const h = href.trim()
  if (/^(https?|mailto|tel|sms|maps|facetime):/i.test(h)) return h
  if (/^www\./i.test(h)) return `https://${h}`
  return null
}

/** Open a link from a note: Safari (or the right app) in the iOS app, a new tab on the web. */
export function openExternal(href: string) {
  const url = openableUrl(href)
  if (!url) return
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AppLinks')) {
    void AppLinks.openExternal({ url }).catch(() => window.open(url, '_blank', 'noopener'))
  } else window.open(url, '_blank', 'noopener,noreferrer')
}

/** What a link asks for (null: not one of ours). */
export function parseLink(raw: string): LinkAction | 'connected' | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'reconnotes:') return null
  // reconnotes://new → host "new"; reconnotes:new → pathname "new"
  const what = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase()
  const p = url.searchParams
  switch (what) {
    case 'new':
      return { kind: 'new', text: p.get('text') ?? undefined }
    case 'record':
      return { kind: 'new', then: 'record' }
    case 'scan':
      return { kind: 'new', then: 'scan' }
    case 'open':
      return p.get('note') ? { kind: 'open', noteId: p.get('note')! } : null
    case 'search':
      return { kind: 'search', query: p.get('q') ?? '' }
    case 'connect':
      return p.get('data') && applyConnectData(p.get('data')!) ? 'connected' : null
    default:
      return null
  }
}

/** Something to do in a note once it's open (record / scan), set by a link. */
export const quickAction = new Store<{ noteId: string | null; action: 'record' | 'scan' | null }>({ noteId: null, action: null })

export function takeQuickAction(noteId: string, action: 'record' | 'scan'): boolean {
  const q = quickAction.get()
  if (q.noteId !== noteId || q.action !== action) return false
  quickAction.set({ noteId: null, action: null })
  return true
}

/** Hand every link (now and later) to `handle`. */
export function startAppLinks(handle: (a: LinkAction) => void) {
  const run = (raw: string) => {
    const a = parseLink(raw)
    if (a && a !== 'connected') handle(a)
  }
  // web app: home-screen shortcuts open /#new, /#record, /#scan
  const fromHash = () => {
    const m = /^#(new|record|scan)$/.exec(location.hash)
    if (!m) return
    history.replaceState(null, '', location.pathname + location.search)
    run(`reconnotes://${m[1]}`)
  }
  fromHash()
  window.addEventListener('hashchange', fromHash)
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AppLinks')) return
  const take = () => void AppLinks.take().then(({ urls }) => urls.forEach(run)).catch(() => undefined)
  take()
  window.addEventListener('reconnotes:app-link', take)
}
