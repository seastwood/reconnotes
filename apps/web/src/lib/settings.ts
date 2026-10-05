import { Store, safeLocalGet, safeLocalSet, useStore } from './store'

export type PencilInTextMode = 'draw' | 'scribble'
export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  /** base URL of the self-hosted server, e.g. https://notes.example.com */
  serverUrl: string
  token: string
  /** let fingers draw too (otherwise only Apple Pencil / mouse draws) */
  fingerDrawing: boolean
  /** what the Apple Pencil does when it touches typed text */
  pencilInText: PencilInTextMode
  theme: Theme
  /** iOS app: recognise handwriting with Apple's on-device recognizer */
  deviceOcr: boolean
  /** …and then polish it with the server's clean-up agents when online */
  deviceOcrCleanup: boolean
  /** iOS app: quietly recognise drawings for search (never changes the note) */
  backgroundOcr: boolean
  /** settings format version, for one-off migrations */
  version?: number
}

const KEY = 'reconnotes.settings'

function isPhone(): boolean {
  if (typeof matchMedia === 'undefined' || typeof screen === 'undefined') return false
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600
}

function defaults(): Settings {
  // When the web app is served by the ReconNotes server itself, sync with it.
  const sameOrigin =
    typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && !import.meta.env.DEV ? location.origin : ''
  return {
    serverUrl: sameOrigin,
    token: '',
    // phones have no Pencil: draw with a finger there; on iPad/computer fingers scroll
    fingerDrawing: isPhone(),
    pencilInText: 'scribble',
    theme: 'system',
    deviceOcr: true,
    deviceOcrCleanup: false,
    backgroundOcr: true,
  }
}

const SETTINGS_VERSION = 2

function load(): Settings {
  const s = safeLocalGet(KEY, defaults())
  // v2: Scribble became the default for Pencil writing on typed text
  // (handwriting there becomes text; drawings stay ink).
  if ((s.version ?? 1) < 2) s.pencilInText = 'scribble'
  s.version = SETTINGS_VERSION
  return s
}

export const settings = new Store<Settings>(load())
safeLocalSet(KEY, settings.get())
settings.subscribe(() => safeLocalSet(KEY, settings.get()))

export const useSettings = <S,>(select: (s: Settings) => S) => useStore(settings, select)

export const isSyncConfigured = () => {
  const s = settings.get()
  return Boolean(s.serverUrl && s.token)
}

export function apiUrl(path: string): string {
  return settings.get().serverUrl.replace(/\/$/, '') + path
}

export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${settings.get().token}` }
}

export function syncUrl(): string {
  return settings.get().serverUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/sync'
}
