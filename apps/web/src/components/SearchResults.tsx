import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { searchNotes, type SearchResult } from '../lib/search'
import { useWorkspace } from '../lib/workspace'
import { AskPanel } from './AskPanel'

/** Notes matching the search text (and "Ask your notes" for it), updated as you type. */
export function SearchResults({ query, activeNoteId, onOpen }: { query: string; activeNoteId: string | null; onOpen: (noteId: string) => void }) {
  const ws = useWorkspace()
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [asked, setAsked] = useState<string | null>(null)
  const q = query.trim()

  useEffect(() => {
    if (!q) return setResults(null)
    let alive = true
    const t = setTimeout(() => void searchNotes(q).then((r) => alive && setResults(r)), 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])

  return (
    <ul className="notes search-results">
      {q.length > 2 && asked !== q && (
        <li className="note-row ask-row" onClick={() => setAsked(q)}>
          <div className="note-title">
            <Sparkles size={15} /> Ask your notes
          </div>
          <div className="note-snippet">“{q}” – an answer from your notes, with sources</div>
        </li>
      )}
      {asked === q && <AskPanel question={asked} onOpen={onOpen} />}
      {results
        ?.filter((r) => !ws.notes.find((n) => n.id === r.noteId)?.template)
        .map((r) => (
          <li key={r.noteId} className={`note-row${r.noteId === activeNoteId ? ' active' : ''}`} onClick={() => onOpen(r.noteId)}>
            <div className="note-title">
              {r.title || 'Untitled'}
              {r.meaning && (
                <span className="related-badge" title="Found by meaning – no exact word match">
                  related
                </span>
              )}
            </div>
            <div className="note-snippet">{r.snippet}</div>
          </li>
        ))}
      {results && !results.length && <li className="empty-hint">No matches</li>}
    </ul>
  )
}
