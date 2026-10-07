import { Store, safeLocalGet, safeLocalSet, useStore } from './store'

/**
 * Which folders search (and "Ask your notes") look in: none chosen = everywhere
 * (except folders left out of search and locked ones). Choosing a folder
 * searches it and its subfolders – even one left out of search.
 * 'none' = notes that aren't in a folder.
 */
const KEY = 'reconnotes.searchFolders'
export const searchScope = new Store<{ folders: string[] }>({ folders: safeLocalGet<string[]>(KEY, []) })
export const useSearchScope = () => useStore(searchScope, (s) => s.folders)
export function setSearchFolders(folders: string[]) {
  searchScope.set({ folders })
  safeLocalSet(KEY, folders)
}
export function toggleSearchFolder(id: string) {
  const cur = searchScope.get().folders
  setSearchFolders(cur.includes(id) ? cur.filter((f) => f !== id) : [...cur, id])
}
