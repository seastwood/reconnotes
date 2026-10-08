import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, MessageCircleQuestion, X } from 'lucide-react'
import { useFolderAccess } from '../lib/folderLock'
import { AskPanel } from './AskPanel'
import { AskConversation, AskHistoryList, useAskHistory } from './AskHistory'

/**
 * "Ask about this note" / "Ask this folder": a question answered from this
 * note – or the notes in this folder and its subfolders – only (by your AI
 * agents, as a job), with follow-ups.
 */
export function AskNoteDialog({
  noteId,
  folderId,
  title,
  onClose,
  onOpen,
}: {
  noteId?: string
  /** ask the notes in this folder instead (even one left out of search) */
  folderId?: string
  title: string
  onClose: () => void
  onOpen: (noteId: string, find?: string) => void
}) {
  const access = useFolderAccess()
  const [draft, setDraft] = useState('')
  const [question, setQuestion] = useState<string | null>(null)
  // earlier conversations about this note (or folder), and the one being read again
  const history = useAskHistory(folderId ? { folderId } : { noteId })
  const [viewing, setViewing] = useState<string | null>(null)
  const conversation = viewing ? history.list?.find((c) => c.id === viewing) : undefined
  const scope = folderId ? { folders: [folderId], unlocked: access.unlockedIds } : { notes: [noteId!], unlocked: access.unlockedIds }
  const open = (id: string, find?: string) => {
    onClose()
    onOpen(id, find)
  }
  const answerRef = useRef<HTMLUListElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const liftedAt = useRef(0)
  const ask = () => {
    if (!draft.trim()) return
    setQuestion(draft.trim())
    setViewing(null)
    setDraft('')
    // the keyboard away, and the question (with how it's going) in view
    boxRef.current?.blur()
    setTimeout(() => answerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 350)
  }
  // on top of everything (it's opened from the toolbar)
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog ask-note-dialog" role="dialog" aria-label="Ask about this note" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <MessageCircleQuestion size={20} /> {folderId ? 'Ask' : 'Ask about'} “{title || 'Untitled'}”
          </h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <form
          className="ask-followup-box"
          onSubmit={(e) => {
            e.preventDefault()
            ask()
          }}
        >
          <textarea
            ref={boxRef}
            rows={1}
            autoFocus
            value={draft}
            placeholder={folderId ? 'Ask a question – the answer comes from this folder’s notes…' : 'What were the action items? Who was at this meeting?…'}
            enterKeyHint="send"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask()
              }
            }}
          />
          <button
            type="submit"
            className="icon"
            disabled={!draft.trim()}
            aria-label="Ask"
            // iOS can drop the tap that also puts the keyboard away: act when the finger lifts
            onPointerUp={(e) => {
              if (e.pointerType === 'mouse') return
              e.preventDefault()
              liftedAt.current = Date.now()
              ask()
            }}
            onClick={(e) => {
              if (Date.now() - liftedAt.current < 800) e.preventDefault()
            }}
          >
            <ArrowUp size={16} />
          </button>
        </form>
        {conversation && <AskConversation conversation={conversation} input={scope} onBack={() => setViewing(null)} onOpen={open} />}
        {!question && !conversation && history.list && <AskHistoryList list={history.list} onPick={(c) => setViewing(c.id)} onRemove={history.remove} />}
        {question && !conversation && (
          <ul className="ask-note-answer" ref={answerRef}>
            <AskPanel
              key={question}
              // it's a job: closing this doesn't stop it
              question={question}
              where={scope}
              onOpen={open}
            />
          </ul>
        )}
      </div>
    </div>,
    document.body,
  )
}
