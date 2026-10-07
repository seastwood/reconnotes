import { useSyncExternalStore } from 'react'
import { getSettings, newId } from '@reconnotes/core'
import { Store, safeLocalGet, safeLocalSet, useStore } from './store'
import { workspaceDoc } from './workspace'

/**
 * Recent searches (on this device) and saved searches (synced to all your
 * devices, with the folders they search in).
 */

const RECENT_KEY = 'reconnotes.recentSearches'
const recent = new Store<{ list: string[] }>({ list: safeLocalGet<string[]>(RECENT_KEY, []) })
export const useRecentSearches = () => useStore(recent, (s) => s.list)
export function addRecentSearch(q: string) {
  const t = q.trim()
  if (t.length < 2) return
  const list = [t, ...recent.get().list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8)
  recent.set({ list })
  safeLocalSet(RECENT_KEY, list)
}
export function clearRecentSearches() {
  recent.set({ list: [] })
  safeLocalSet(RECENT_KEY, [])
}

export interface SavedSearch {
  id: string
  query: string
  /** the folders it searches in ([] = everywhere) */
  folders: string[]
}
const settings = () => getSettings(workspaceDoc)
const readSaved = (): SavedSearch[] => (settings().get('savedSearches') as SavedSearch[] | undefined) ?? []
let snapshot = readSaved()
const listeners = new Set<() => void>()
settings().observe(() => {
  const next = readSaved()
  if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
    snapshot = next
    listeners.forEach((l) => l())
  }
})
export function useSavedSearches(): SavedSearch[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  )
}
const sameScope = (a: string[], b: string[]) => [...a].sort().join(',') === [...b].sort().join(',')
export function findSaved(query: string, folders: string[]): SavedSearch | undefined {
  return readSaved().find((s) => s.query.trim().toLowerCase() === query.trim().toLowerCase() && sameScope(s.folders, folders))
}
export function saveSearch(query: string, folders: string[]) {
  if (!query.trim() || findSaved(query, folders)) return
  settings().set('savedSearches', [...readSaved(), { id: newId(), query: query.trim(), folders }])
}
export function removeSavedSearch(id: string) {
  settings().set(
    'savedSearches',
    readSaved().filter((s) => s.id !== id),
  )
}
