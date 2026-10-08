import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { isFinished, useJobs } from '../lib/jobs'
import type { AskResult } from './AskPanel'

/**
 * The chats kept from "Ask about this note" (or "Ask this folder"), as the
 * server keeps them: each question with its answer and sources.
 */

export interface SavedTurn {
  question: string
  answer: string
  sources: AskResult['sources']
  at: number
}
export interface Conversation {
  id: string
  turns: SavedTurn[]
  updatedAt: number
}

export const when = (t: number) => {
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
