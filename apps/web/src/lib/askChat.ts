import { Store } from './store'

/**
 * The Ask chat window: which note (or folder) it's about, whether it's put
 * aside while a source is being read (a "Back to chat" button brings it
 * back), and which chat was last open for each note.
 */
export interface AskChatTarget {
  noteId?: string
  folderId?: string
  /** a chat about all your notes */
  all?: boolean
  title: string
}

interface AskChatState {
  target: AskChatTarget | null
  /** put aside: a source was opened in the note */
  hidden: boolean
  /** the chat last open, per note or folder ("note:<id>" / "folder:<id>"); null for a new one */
  chat: Record<string, string | null>
}

export const askChat = new Store<AskChatState>({ target: null, hidden: false, chat: {} })

export const chatKey = (t: AskChatTarget) => (t.all ? 'all' : t.folderId ? `folder:${t.folderId}` : `note:${t.noteId}`)
/** the chat about all your notes */
export const ALL_NOTES: AskChatTarget = { all: true, title: 'All your notes' }
/** a chat, open at one conversation (its first question's job) */
export const openChatAt = (target: AskChatTarget, conversation: string) => {
  askChat.set((s) => ({ chat: { ...s.chat, [chatKey(target)]: conversation } }))
  openAskChat(target)
}

export const openAskChat = (target: AskChatTarget) => askChat.set({ target, hidden: false })
export const closeAskChat = () => askChat.set({ target: null, hidden: false })
export const hideAskChat = () => askChat.set({ hidden: true })
export const showAskChat = () => askChat.set({ hidden: false })
