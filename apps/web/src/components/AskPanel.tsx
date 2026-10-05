import { useEffect, useMemo, useState } from 'react'
import { FileText, Loader2, Sparkles } from 'lucide-react'
import { marked } from 'marked'
import { apiUrl, authHeaders, isSyncConfigured } from '../lib/settings'

interface Source {
  n: number
  noteId: string
  title: string
}

/**
 * "Ask your notes": the answer to a question, written by your AI agents from
 * your own notes, with numbered links to the notes it used.
 */
export function AskPanel({ question, onOpen }: { question: string; onOpen: (noteId: string) => void }) {
  const [result, setResult] = useState<{ answer: string; sources: Source[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setResult(null)
    setError(null)
    if (!isSyncConfigured()) return setError('Asking your notes uses the AI agents on your ReconNotes server – connect one in Settings.')
    const ctl = new AbortController()
    fetch(apiUrl('/api/ai/ask'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: ctl.signal,
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `Server error ${res.status}`)
        setResult(json as { answer: string; sources: Source[] })
      })
      .catch((e) => (e as Error).name !== 'AbortError' && setError((e as Error).message))
    return () => ctl.abort()
  }, [question])

  const html = useMemo(() => {
    if (!result) return ''
    const md = result.answer.replace(/</g, '&lt;')
    // [2] → a link to source 2
    return (marked.parse(md, { async: false }) as string).replace(/\[(\d+)\]/g, (m, n) =>
      result.sources.some((s) => s.n === Number(n)) ? `<button class="cite" data-n="${n}">${n}</button>` : m,
    )
  }, [result])

  return (
    <li className="ask-panel">
      <div className="ask-q">
        <Sparkles size={16} /> {question}
      </div>
      {error && <p className="error-text">{error}</p>}
      {!result && !error && (
        <p className="hint">
          <Loader2 size={14} className="spin" /> Reading your notes…
        </p>
      )}
      {result && (
        <>
          <div
            className="ask-answer"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={(e) => {
              const n = (e.target as HTMLElement).closest('.cite') as HTMLElement | null
              const s = n && result.sources.find((x) => x.n === Number(n.dataset.n))
              if (s) onOpen(s.noteId)
            }}
          />
          {result.sources.length > 0 && (
            <div className="ask-sources">
              {result.sources.map((s) => (
                <button key={s.n} onClick={() => onOpen(s.noteId)}>
                  <span className="cite">{s.n}</span>
                  <FileText size={14} /> {s.title}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </li>
  )
}
