import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, CornerDownRight, FileText, Loader2, Sparkles, XCircle } from 'lucide-react'
import { marked } from 'marked'
import { isSyncConfigured } from '../lib/settings'
import { cancelJob, isFinished, submitJob, useJobs, watchingJob, type Job } from '../lib/jobs'
import { duration } from './JobsPanel'

interface Source {
  n: number
  noteId: string
  title: string
}
export interface AskResult {
  answer: string
  sources: Source[]
}

/** the newest "Ask your notes" job for this question (still useful: not failed or cancelled) */
const sameFolders = (a: unknown, b: string[]) => JSON.stringify([...((a as string[] | undefined) ?? [])].sort()) === JSON.stringify([...b].sort())

function jobFor(jobs: Job[], question: string, folders: string[], notes: string[]): Job | undefined {
  return jobs
    .filter(
      (j) =>
        j.kind === 'ask' &&
        !j.input.thread &&
        j.input.question === question &&
        sameFolders(j.input.folders, folders) &&
        sameFolders(j.input.notes, notes) &&
        j.status !== 'cancelled' &&
        !(j.status === 'done' && !j.result?.answer),
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/**
 * "Ask your notes": the answer to a question, written by your AI agents from
 * your own notes, with numbered links to the notes it used. It runs as a job:
 * you can leave the search and it keeps going (see Jobs), and coming back to
 * the same question shows the answer instead of asking again.
 */
export function AskPanel({
  question,
  where = {},
  onOpen,
}: {
  question: string
  /** folders to search in; or only these notes ("Ask about this note") */
  where?: { folders?: string[]; unlocked?: string[]; notes?: string[] }
  onOpen: (noteId: string) => void
}) {
  const folders = where.folders ?? []
  const notes = where.notes ?? []
  const input = { question, tzOffset: new Date().getTimezoneOffset(), folders, unlocked: where.unlocked ?? [], ...(notes.length ? { notes } : {}) }
  const jobs = useJobs((s) => s.jobs)
  const loaded = useJobs((s) => s.loaded)
  const job = jobFor(jobs, question, folders, notes)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!isSyncConfigured()) return setError('Asking your notes uses the AI agents on your ReconNotes server – connect one in Settings.')
    // wait for the job list, so an earlier ask of the same question is found
    const asking = `${question}|${folders.join(',')}|${notes.join(',')}`
    if (!loaded || job || submitted === asking) return
    setSubmitted(asking)
    submitJob({ kind: 'ask', title: question, input })
      .then((j) => watchingJob(j.id, true))
      .catch((e) => setError((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, folders.join(','), notes.join(','), loaded, Boolean(job)])

  // while it's on screen, no "finished" toast for it
  useEffect(() => {
    if (!job) return
    watchingJob(job.id, true)
    return () => watchingJob(job.id, false)
  }, [job?.id])

  // follow-up questions asked under this answer, oldest first
  const thread = job ? jobs.filter((j) => j.kind === 'ask' && j.input.thread === job.id && j.status !== 'cancelled').sort((a, b) => a.createdAt - b.createdAt) : []
  useEffect(() => {
    thread.forEach((j) => watchingJob(j.id, true))
    return () => thread.forEach((j) => watchingJob(j.id, false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.map((j) => j.id).join(',')])

  const retry = () =>
    void submitJob({ kind: 'ask', title: question, input })
      .then((j) => watchingJob(j.id, true))
      .catch((e) => setError((e as Error).message))

  const askFollowUp = async (q: string) => {
    // the conversation so far: each question with its answer and the notes it used
    const history = [job!, ...thread]
      .filter((j) => j.status === 'done' && typeof j.result?.answer === 'string')
      .map((j) => {
        const r = j.result as unknown as AskResult
        return { question: String(j.input.question), answer: r.answer, sources: r.sources.map((s) => s.noteId) }
      })
    const j = await submitJob({ kind: 'ask', title: q, input: { ...input, question: q, thread: job!.id, history } })
    watchingJob(j.id, true)
  }
  const busy = !job || !isFinished(job) || thread.some((j) => !isFinished(j))

  return (
    <li className="ask-panel">
      <div className="ask-q">
        <Sparkles size={16} /> {question}
      </div>
      <Turn job={job} error={error} onRetry={retry} onOpen={onOpen} />
      {thread.map((j) => (
        <div key={j.id} className="ask-followup">
          <div className="ask-q">
            <CornerDownRight size={15} /> {String(j.input.question)}
          </div>
          <Turn
            job={j}
            onRetry={() =>
              void submitJob({ kind: 'ask', title: String(j.input.question), input: j.input })
                .then((n) => watchingJob(n.id, true))
                .catch((e) => setError((e as Error).message))
            }
            onOpen={onOpen}
          />
        </div>
      ))}
      {job?.status === 'done' && !busy && <FollowUpBox onAsk={askFollowUp} />}
    </li>
  )
}

/** One question's state: waiting, the answer, or what went wrong. */
function Turn({ job, error, onRetry, onOpen }: { job: Job | undefined; error?: string | null; onRetry: () => void; onOpen: (noteId: string) => void }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!job || isFinished(job)) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [job?.id, job?.status])
  const result = job?.status === 'done' ? (job.result as unknown as AskResult) : null
  const failed = job?.status === 'failed' ? (job.error ?? 'Couldn’t answer.') : null
  if (error || failed)
    return (
      <>
        <p className="error-text">{error ?? failed}</p>
        {failed && !error && (
          <button className="text" onClick={onRetry}>
            Try again
          </button>
        )}
      </>
    )
  if (result) return <AskAnswer result={result} onOpen={onOpen} />
  // being written: show it as it grows (with only the sources cited so far)
  const partial = job?.status === 'running' ? (job.partial as unknown as AskResult | null | undefined) : null
  if (partial?.answer) {
    const cited = new Set([...partial.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
    return (
      <div className="ask-writing">
        <AskAnswer result={{ answer: partial.answer, sources: partial.sources.filter((s) => cited.has(s.n)) }} onOpen={onOpen} />
        <p className="hint">
          <Loader2 size={14} className="spin" /> Writing…{' '}
          <button className="text" onClick={() => void cancelJob(job!.id)}>
            <XCircle size={13} /> Stop
          </button>
        </p>
      </div>
    )
  }
  return (
    <div className="ask-wait">
      <p className="hint">
        <Loader2 size={14} className="spin" />{' '}
        {job?.retryAt
          ? 'Your AI server can’t be reached – it will try again by itself.'
          : job?.status === 'running'
            ? `Reading your notes… ${job.startedAt ? duration(Date.now() - job.startedAt) : ''}`
            : job?.status === 'paused'
              ? 'Paused in Jobs.'
              : 'Waiting its turn in Jobs…'}
      </p>
      <p className="hint">You can leave – it keeps going in Jobs, and you’ll be told when the answer is ready.</p>
      {job && (
        <button className="text" onClick={() => void cancelJob(job.id)}>
          <XCircle size={13} /> Stop
        </button>
      )}
    </div>
  )
}

/** "Ask a follow-up…" under an answer. */
function FollowUpBox({ onAsk }: { onAsk: (q: string) => Promise<void> }) {
  const [q, setQ] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    const text = q.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await onAsk(text)
      setQ('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  return (
    <form
      className="ask-followup-box"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <textarea
        rows={1}
        value={q}
        placeholder="Ask a follow-up…"
        enterKeyHint="send"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <button type="submit" className="icon" disabled={!q.trim() || sending} aria-label="Ask">
        {sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
      </button>
      {error && <p className="error-text">{error}</p>}
    </form>
  )
}

/** An answer with its numbered citations linked to the notes. */
export function AskAnswer({ result, onOpen }: { result: AskResult; onOpen: (noteId: string) => void }) {
  const html = useMemo(() => {
    const md = result.answer.replace(/</g, '&lt;')
    // [2] → a link to source 2
    return (marked.parse(md, { async: false }) as string).replace(/\[(\d+)\]/g, (m, n) =>
      result.sources.some((s) => s.n === Number(n)) ? `<button class="cite" data-n="${n}">${n}</button>` : m,
    )
  }, [result])
  return (
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
              <FileText size={14} /> <span>{s.title}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
