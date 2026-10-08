import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, MessageCircleQuestion, X } from 'lucide-react'
import { useFolderAccess } from '../lib/folderLock'
import { AskPanel } from './AskPanel'

/**
 * "Ask about this note": a question answered from this note only (by your
 * AI agents, as a job), with follow-ups.
 */
export function AskNoteDialog({ noteId, title, onClose, onOpen }: { noteId: string; title: string; onClose: () => void; onOpen: (noteId: string, find?: string) => void }) {
  const [draft, setDraft] = useState('')
  const [question, setQuestion] = useState<string | null>(null)
  const access = useFolderAccess()
  const ask = () => draft.trim() && setQuestion(draft.trim())
  // on top of everything (it's opened from the toolbar)
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog ask-note-dialog" role="dialog" aria-label="Ask about this note" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <MessageCircleQuestion size={20} /> Ask about “{title || 'Untitled'}”
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
            rows={1}
            autoFocus
            value={draft}
            placeholder="What were the action items? Who was at this meeting?…"
            enterKeyHint="send"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask()
              }
            }}
          />
          <button type="submit" className="icon" disabled={!draft.trim()} aria-label="Ask">
            <ArrowUp size={16} />
          </button>
        </form>
        {question && (
          <ul className="ask-note-answer">
            <AskPanel
              key={question}
              question={question}
              where={{ notes: [noteId], unlocked: access.unlockedIds }}
              onOpen={(id, find) => {
                onClose()
                onOpen(id, find)
              }}
            />
          </ul>
        )}
      </div>
    </div>,
    document.body,
  )
}
