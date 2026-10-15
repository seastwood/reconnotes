/**
 * Where each note was scrolled to, so switching between notes doesn't lose your place. Kept on this
 * device (it's about this screen's size), across restarts of the app; the most recent 300 notes.
 */
const KEY = 'reconnotes.scroll'
const MAX = 300

let places: Map<string, number> | null = null
function load(): Map<string, number> {
  if (places) return places
  places = new Map()
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as [string, number][]
    if (Array.isArray(raw)) for (const [id, y] of raw) if (typeof id === 'string' && Number.isFinite(y)) places.set(id, y)
  } catch {
    /* nothing remembered */
  }
  return places
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify([...load()].slice(-MAX)))
    } catch {
      /* storage full or off: remembered until the app closes */
    }
  }, 500)
}

/** How far down this note was (px), or 0. */
export const scrollPlace = (noteId: string): number => load().get(noteId) ?? 0

/** Remember how far down this note is (the most recent last, so the oldest are dropped first). */
export function rememberScroll(noteId: string, y: number) {
  const m = load()
  m.delete(noteId)
  if (y > 0) m.set(noteId, Math.round(y))
  persist()
}
