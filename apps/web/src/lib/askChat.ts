import { Store } from './store'

/**
 * The Ask chat window: which note (or folder) it's about, whether it's put
 * aside while a source is being read (a "Back to chat" button brings it
 * back), and which chat was last open for each note.
 */
export interface AskChatTarget {
  noteId?: string
  folderId?: string
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

export const chatKey = (t: AskChatTarget) => (t.folderId ? `folder:${t.folderId}` : `note:${t.noteId}`)

export const openAskChat = (target: AskChatTarget) => askChat.set({ target, hidden: false })
export const closeAskChat = () => askChat.set({ target: null, hidden: false })
export const hideAskChat = () => askChat.set({ hidden: true })
export const showAskChat = () => askChat.set({ hidden: false })
