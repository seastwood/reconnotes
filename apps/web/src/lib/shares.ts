import { api } from './api'
import { isSyncConfigured } from './settings'
import { Store, useStore } from './store'

/**
 * What's shared with others: links to notes and folders, each folder's for one person (with a
 * passcode or not), served on the server's share port. Shared folders are marked in the sidebar.
 */
export interface ShareLink {
  id: string
  kind: 'note' | 'folder'
  noteId: string
  folderId: string | null
  /** who it's for */
  name: string
  hasPasscode: boolean
  createdAt: number
  lastSeenAt: number | null
  url: string
}

interface SharesState {
  shares: ShareLink[]
  /** the address links are given with */
  address: string
  /** the share port (0: none – links use the server's own address) */
  port: number
  /** set in the app (or on the server), not worked out */
  addressSet: boolean
  loaded: boolean
}

export const sharesStore = new Store<SharesState>({ shares: [], address: '', port: 0, addressSet: false, loaded: false })
export const useShares = <S,>(select: (s: SharesState) => S) => useStore(sharesStore, select)

export async function refreshShares(): Promise<void> {
  if (!isSyncConfigured()) return
  try {
    const r = await api<Omit<SharesState, 'loaded'>>('GET', '/api/shares')
    sharesStore.set({ ...r, loaded: true })
  } catch {
    /* offline: as it was */
  }
}

export async function shareFolder(folderId: string, name: string, passcode: string | null): Promise<ShareLink> {
  const link = await api<ShareLink>('POST', `/api/folders/${folderId}/shares`, { name, passcode })
  await refreshShares()
  return link
}

export async function updateShare(id: string, patch: { name?: string; passcode?: string | null }): Promise<void> {
  await api('PATCH', `/api/shares/${id}`, patch)
  await refreshShares()
}

export async function stopShare(id: string): Promise<void> {
  await api('DELETE', `/api/shares/${id}`)
  await refreshShares()
}

export async function setShareAddress(address: string): Promise<void> {
  await api('PUT', '/api/share-address', { address })
  await refreshShares()
}

/** "opened 3 h ago" */
export function lastOpened(ts: number | null): string {
  if (!ts) return 'not opened yet'
  const min = Math.round((Date.now() - ts) / 60_000)
  if (min < 2) return 'opened just now'
  if (min < 60) return `opened ${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `opened ${h} h ago`
  return `opened ${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    prompt('Copy the link:', text)
  }
}
