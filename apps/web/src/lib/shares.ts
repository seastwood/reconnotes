import { api } from './api'
import { isSyncConfigured } from './settings'
import { Store, useStore } from './store'

/**
 * What's shared with others, served on the server's share port. Each person has one link for good
 * (with a passcode or not); what they see is in pools – sets of folders and notes – and they see
 * everything in every pool they're in. A single note can also have a link of its own, for anyone.
 */
export interface ShareLink {
  id: string
  kind: 'note' | 'folder'
  noteId: string
  folderId: string | null
  name: string
  hasPasscode: boolean
  createdAt: number
  lastSeenAt: number | null
  url: string
}

export interface SharePerson {
  id: string
  name: string
  hasPasscode: boolean
  createdAt: number
  lastSeenAt: number | null
  /** the pools they're in */
  pools: string[]
  url: string
}

export interface SharePool {
  id: string
  name: string
  createdAt: number
  items: { kind: 'folder' | 'note'; id: string }[]
  /** the people in it */
  members: string[]
}

interface SharesState {
  /** single notes' own links */
  shares: ShareLink[]
  people: SharePerson[]
  pools: SharePool[]
  /** the address links are given with */
  address: string
  /** the share port (0: none – links use the server's own address) */
  port: number
  /** set in the app (or on the server), not worked out */
  addressSet: boolean
  loaded: boolean
}

export const sharesStore = new Store<SharesState>({ shares: [], people: [], pools: [], address: '', port: 0, addressSet: false, loaded: false })
export const useShares = <S,>(select: (s: SharesState) => S) => useStore(sharesStore, select)

type Payload = Omit<SharesState, 'loaded'>
const take = (r: Payload) => sharesStore.set({ ...r, loaded: true })

export async function refreshShares(): Promise<void> {
  if (!isSyncConfigured()) return
  try {
    take(await api<Payload>('GET', '/api/shares'))
  } catch {
    /* offline: as it was */
  }
}

export type ShareItem = { kind: 'folder' | 'note'; id: string }

/** Someone new: their link, and a pool of their own (with `item` in it), or the pools given. */
export async function addPerson(name: string, passcode: string | null, opts: { item?: ShareItem; pools?: string[] } = {}): Promise<SharePerson> {
  const r = await api<Payload & { person: SharePerson }>('POST', '/api/share-people', { name, passcode, ...opts })
  take(r)
  return r.person
}

export async function updatePerson(id: string, patch: { name?: string; passcode?: string | null; pools?: string[] }): Promise<void> {
  take(await api<Payload>('PATCH', `/api/share-people/${id}`, patch))
}

/** Their link stops working at once (their pools stay, with anyone else in them). */
export async function stopPerson(id: string): Promise<void> {
  take(await api<Payload>('DELETE', `/api/share-people/${id}`))
}

export async function addPool(name: string, members: string[] = []): Promise<SharePool> {
  const r = await api<Payload & { pool: SharePool }>('POST', '/api/share-pools', { name, members })
  take(r)
  return r.pool
}

export async function renamePool(id: string, name: string): Promise<void> {
  take(await api<Payload>('PATCH', `/api/share-pools/${id}`, { name }))
}

export async function deletePool(id: string): Promise<void> {
  take(await api<Payload>('DELETE', `/api/share-pools/${id}`))
}

/** Put a folder or note in a pool, or take it out. */
export async function setPoolItem(pool: string, item: ShareItem, shared: boolean): Promise<void> {
  take(await api<Payload>('PUT', `/api/share-pools/${pool}/items`, { ...item, shared }))
}

/** A single note's own link, stopped. */
export async function stopShare(id: string): Promise<void> {
  take(await api<Payload>('DELETE', `/api/shares/${id}`))
}

/** "Sydney, Mom" – who sees a pool. */
export const poolPeople = (pool: SharePool, people: SharePerson[]) =>
  pool.members
    .map((m) => people.find((p) => p.id === m)?.name)
    .filter(Boolean)
    .join(', ')

/** The pools a folder or note is in. */
export const poolsWith = (pools: SharePool[], item: ShareItem) => pools.filter((p) => p.items.some((i) => i.kind === item.kind && i.id === item.id))

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
