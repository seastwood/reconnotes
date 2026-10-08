import { Store, safeLocalGet, safeLocalSet, useStore } from './store'

/**
 * Which folders search (and "Ask your notes") look in: none chosen = everywhere
 * (except folders left out of search and locked ones). Choosing a folder
 * searches it and its subfolders – even one left out of search.
 * 'none' = notes that aren't in a folder.
 */
const KEY = 'reconnotes.searchFolders'
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
export const searchScope = new Store<{ folders: string[] }>({ folders: asList(safeLocalGet<string[]>(KEY, [])) })
export const useSearchScope = () => useStore(searchScope, (s) => s.folders)
export function setSearchFolders(folders: string[]) {
  searchScope.set({ folders: asList(folders) })
  safeLocalSet(KEY, asList(folders))
}
export function toggleSearchFolder(id: string) {
  const cur = searchScope.get().folders
  setSearchFolders(cur.includes(id) ? cur.filter((f) => f !== id) : [...cur, id])
}
