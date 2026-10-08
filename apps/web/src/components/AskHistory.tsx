import { useEffect, useState } from 'react'
import { ChevronLeft, CornerDownRight, History, Sparkles, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { isFinished, submitJob, useJobs, watchingJob } from '../lib/jobs'
import { AskAnswer, FollowUpBox, Turn, type AskResult } from './AskPanel'

/**
 * Earlier conversations from "Ask about this note" (or "Ask this folder"):
 * a list to come back to, each one readable again – its sources opening the
 * note at the passage – and carried on with a follow-up.
 */

interface SavedTurn {
  question: string
  answer: string
  sources: AskResult['sources']
  at: number
}
interface Conversation {
  id: string
  turns: SavedTurn[]
  updatedAt: number
}

const when = (t: number) => {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The conversations about this note (or folder), newest first; reloaded when an Ask job finishes. */
export function useAskHistory(where: { noteId?: string; folderId?: string }) {
  const [list, setList] = useState<Conversation[] | null>(null)
  const finished = useJobs((s) => s.jobs.filter((j) => j.kind === 'ask' && isFinished(j)).length)
  const key = where.noteId ? `noteId=${where.noteId}` : where.folderId ? `folderId=${where.folderId}` : ''
  useEffect(() => {
    let alive = true
    api<{ conversations: Conversation[] }>('GET', `/api/ask/history?${key}`)
      .then((r) => alive && setList(r.conversations))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [key, finished])
  return { list, remove: (id: string) => (setList((l) => l?.filter((c) => c.id !== id) ?? null), void api('DELETE', `/api/ask/history/${id}`).catch(() => {})) }
}

export function AskHistoryList({ list, onPick, onRemove }: { list: Conversation[]; onPick: (c: Conversation) => void; onRemove: (id: string) => void }) {
  if (!list.length) return null
  return (
    <div className="ask-history">
      <div className="menu-label">
        <History size={13} /> Earlier questions
      </div>
      {list.map((c) => (
        <div key={c.id} className="ask-history-row" onClick={() => onPick(c)}>
          <span className="ask-history-q">{c.turns[0]?.question}</span>
          <span className="ask-history-meta">
            {c.turns.length > 1 ? `${c.turns.length - 1} follow-up${c.turns.length === 2 ? '' : 's'} · ` : ''}
            {when(c.updatedAt)}
          </span>
          <button
            className="icon"
            aria-label="Delete this conversation"
            title="Delete this conversation"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(c.id)
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** One earlier conversation: every question and answer, and a follow-up box to carry on. */
export function AskConversation({
  conversation,
  input,
  onBack,
  onOpen,
}: {
  conversation: Conversation
  /** what the questions are asked about (the note, or the folder) */
  input: Record<string, unknown>
  onBack: () => void
  onOpen: (noteId: string, find?: string) => void
}) {
  const jobs = useJobs((s) => s.jobs)
  // follow-ups asked here and not yet saved into the conversation
  const [asked, setAsked] = useState<string[]>([])
  const pending = jobs.filter((j) => asked.includes(j.id) && !conversation.turns.some((t) => t.question === j.input.question && t.at >= j.createdAt))
  useEffect(() => {
    pending.forEach((j) => watchingJob(j.id, true))
    return () => pending.forEach((j) => watchingJob(j.id, false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.map((j) => j.id).join(',')])
  const askMore = async (q: string) => {
    const history = conversation.turns.map((t) => ({ question: t.question, answer: t.answer, sources: t.sources.map((s) => s.noteId) }))
    const j = await submitJob({ kind: 'ask', title: q, input: { ...input, tzOffset: new Date().getTimezoneOffset(), question: q, thread: conversation.id, history } })
    setAsked((a) => [...a, j.id])
  }
  return (
    <div className="ask-conversation">
      <button className="text ask-back" onClick={onBack}>
        <ChevronLeft size={15} /> Earlier questions
      </button>
      <ul className="ask-note-answer">
        <li className="ask-panel">
          {conversation.turns.map((t, i) => (
            <div key={`${i}-${t.at}`} className={i ? 'ask-followup' : undefined}>
              <div className="ask-q">
                {i ? <CornerDownRight size={15} /> : <Sparkles size={16} />} {t.question}
                <span className="ask-history-meta"> · {when(t.at)}</span>
              </div>
              <AskAnswer result={{ answer: t.answer, sources: t.sources }} onOpen={onOpen} />
            </div>
          ))}
          {pending.map((j) => (
            <div key={j.id} className="ask-followup">
              <div className="ask-q">
                <CornerDownRight size={15} /> {String(j.input.question)}
              </div>
              <Turn job={j} onRetry={() => void askMore(String(j.input.question))} onOpen={onOpen} />
            </div>
          ))}
          {!pending.some((j) => !isFinished(j)) && <FollowUpBox onAsk={askMore} />}
        </li>
      </ul>
    </div>
  )
}
