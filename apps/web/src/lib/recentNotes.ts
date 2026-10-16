import { Store, safeLocalGet, safeLocalSet, useStore } from './store'

/**
 * The notes you opened last (on this device), newest first – offered in ⌘K and under the search
 * box before you type.
 */
const KEY = 'reconnotes.recentNotes'
const MAX = 12

const recent = new Store<{ ids: string[] }>({ ids: safeLocalGet<string[]>(KEY, []) })

export function noteOpened(id: string | null) {
  if (!id) return
  const ids = [id, ...recent.get().ids.filter((x) => x !== id)].slice(0, MAX)
  if (ids.join() === recent.get().ids.join()) return
  recent.set({ ids })
  safeLocalSet(KEY, ids)
}

export const useRecentNotes = () => useStore(recent, (s) => s.ids)

export const recentNoteIds = () => recent.get().ids
/** Call `fn` whenever the recent notes change. */
export const onRecentNotes = (fn: () => void) => recent.subscribe(fn)
