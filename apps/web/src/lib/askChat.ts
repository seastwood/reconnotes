import { Store, safeLocalGet, safeLocalSet } from './store'

/**
 * The Ask chat: which note (or folder, or all your notes) the open chat is about, which chat was
 * last open for each, and whether the list of all chats is showing.
 *
 * On a big screen it's a panel beside the note that stays open as you go from note to note (and
 * across restarts), so you can read a chat and write a note at once; on a phone it covers the note,
 * stepping aside while a source is read ("Back to chat" brings it back).
 */
export interface AskChatTarget {
  noteId?: string
  folderId?: string
  /** a chat about all your notes */
  all?: boolean
  title: string
}

interface AskChatState {
  /** the chat window's subject (null: closed, unless the list of chats is open) */
  target: AskChatTarget | null
  /** put aside (phone): a source was opened in the note */
  hidden: boolean
  /** the list of every chat showing */
  browsing: boolean
  /** the chat last open, per note or folder ("note:<id>" / "folder:<id>" / "all"); null for a new one */
  chat: Record<string, string | null>
  /** being slid in with a finger (phone): how far from its place it starts (px); null otherwise */
  dragX: number | null
}

interface Kept {
  /** open (as a panel) when the app was closed */
  open?: boolean
  target?: AskChatTarget | null
  /** the last chat's subject, for the Chat button to bring back */
  last?: AskChatTarget | null
  chat?: Record<string, string | null>
}
const KEY = 'reconnotes.askChat'
const kept = safeLocalGet<Kept>(KEY, {})

/** a screen with room for the chat beside the note */
export const DOCK_MEDIA = '(min-width: 900px)'
const roomy = typeof window !== 'undefined' && window.matchMedia?.(DOCK_MEDIA).matches

export const askChat = new Store<AskChatState>({
  // open again as it was – beside the note (on a phone it would cover it: closed)
  target: roomy && kept.open && kept.target ? kept.target : null,
  hidden: false,
  browsing: false,
  chat: kept.chat ?? {},
  dragX: null,
})
let last: AskChatTarget | null = kept.last ?? kept.target ?? null
askChat.subscribe(() => {
  const s = askChat.get()
  if (s.target) last = s.target
  safeLocalSet(KEY, { open: Boolean(s.target), target: s.target, last, chat: s.chat })
})

export const chatKey = (t: AskChatTarget) => (t.all ? 'all' : t.folderId ? `folder:${t.folderId}` : `note:${t.noteId}`)
/** the chat about all your notes */
export const ALL_NOTES: AskChatTarget = { all: true, title: 'All your notes' }
/** a chat, open at one conversation (its first question's job) */
export const openChatAt = (target: AskChatTarget, conversation: string | null) => {
  askChat.set((s) => ({ chat: { ...s.chat, [chatKey(target)]: conversation }, target, hidden: false, browsing: false }))
}

export const openAskChat = (target: AskChatTarget) => askChat.set({ target, hidden: false, browsing: false })
export const closeAskChat = () => askChat.set({ target: null, hidden: false, browsing: false, dragX: null })
export const hideAskChat = () => askChat.set({ hidden: true })
export const showAskChat = () => askChat.set({ hidden: false })
/** the list of every chat (the panel opens on it) */
export const browseChats = () => askChat.set({ browsing: true, hidden: false })
export const stopBrowsing = () => askChat.set({ browsing: false })
/** the subject of the chat last open (for the Chat button), if any */
export const lastChatTarget = () => last

/** The Chat button: closed if it's open; else the last chat back – or, with none, a chat about `fallback`. */
export function toggleAskChat(fallback: AskChatTarget | null) {
  const s = askChat.get()
  if (s.target || s.browsing) return closeAskChat()
  const t = last ?? fallback
  if (t) openAskChat(t)
  else browseChats()
}
