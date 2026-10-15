import { api } from './api'
import { isFinished, jobsStore } from './jobs'
import { isSyncConfigured } from './settings'
import { Store, useStore } from './store'

/** A chat in brief, as the list of every chat shows it. */
export interface ChatBrief {
  id: string
  scope: string
  question: string
  questions: number
  /** answers not read yet (on any device) */
  unread: number
  updatedAt: number
}

/**
 * Every chat with your AI, in brief – for the list of chats and the unread counts
 * (beside Chats in the sidebar, and on each chat). Fetched again as answers come in,
 * and when the app comes back to the front (a chat may have been read on another device).
 */
export const chatList = new Store<{ list: ChatBrief[] | null; error: string | null }>({ list: null, error: null })

let loading: Promise<void> | null = null
let again = false
export function refreshChats(): Promise<void> {
  if (!isSyncConfigured()) return Promise.resolve()
  if (loading) {
    again = true
    return loading
  }
  loading = api<{ chats: ChatBrief[] }>('GET', '/api/ask/chats')
    .then((r) => chatList.set({ list: r.chats.map((c) => ({ ...c, unread: c.unread ?? 0 })), error: null }))
    .catch((e) => chatList.set((s) => ({ list: s.list ?? [], error: (e as Error).message })))
    .finally(() => {
      loading = null
      if (again) {
        again = false
        void refreshChats()
      }
    })
  return loading
}

/** The chat was read: its answers aren't unread any more (here at once, everywhere else soon). */
export function markChatSeen(id: string) {
  const c = chatList.get().list?.find((x) => x.id === id)
  if (!c?.unread) return
  chatList.set((s) => ({ list: s.list?.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) ?? null }))
  void api('POST', `/api/ask/history/${id}/seen`).catch(() => {})
}

export function forgetChat(id: string) {
  chatList.set((s) => ({ list: s.list?.filter((c) => c.id !== id) ?? null }))
  void api('DELETE', `/api/ask/history/${id}`).catch(() => {})
}

/** how many chats have an answer not read yet */
export const useUnreadChats = () => useStore(chatList, (s) => s.list?.filter((c) => c.unread > 0).length ?? 0)

// answers coming in (an Ask job finishing), and coming back to the app
let finished = -1
jobsStore.subscribe(() => {
  const n = jobsStore.get().jobs.filter((j) => j.kind === 'ask' && isFinished(j)).length
  if (n === finished) return
  const first = finished < 0
  finished = n
  if (!first || chatList.get().list === null) void refreshChats()
})
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshChats()
  })
