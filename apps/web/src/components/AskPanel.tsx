import { useEffect, useMemo, useState } from 'react'
import { FileText, Loader2, Sparkles, XCircle } from 'lucide-react'
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

function jobFor(jobs: Job[], question: string, folders: string[]): Job | undefined {
  return jobs
    .filter(
      (j) =>
        j.kind === 'ask' &&
        j.input.question === question &&
        sameFolders(j.input.folders, folders) &&
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
export function AskPanel({ question, where = {}, onOpen }: { question: string; where?: { folders?: string[]; unlocked?: string[] }; onOpen: (noteId: string) => void }) {
  const folders = where.folders ?? []
  const input = { question, tzOffset: new Date().getTimezoneOffset(), folders, unlocked: where.unlocked ?? [] }
  const jobs = useJobs((s) => s.jobs)
  const loaded = useJobs((s) => s.loaded)
  const job = jobFor(jobs, question, folders)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!isSyncConfigured()) return setError('Asking your notes uses the AI agents on your ReconNotes server – connect one in Settings.')
    // wait for the job list, so an earlier ask of the same question is found
    const asking = `${question}|${folders.join(',')}`
    if (!loaded || job || submitted === asking) return
    setSubmitted(asking)
    submitJob({ kind: 'ask', title: question, input })
      .then((j) => watchingJob(j.id, true))
      .catch((e) => setError((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, folders.join(','), loaded, Boolean(job)])

  // while it's on screen, no "finished" toast for it
  useEffect(() => {
    if (!job) return
    watchingJob(job.id, true)
    return () => watchingJob(job.id, false)
  }, [job?.id])

  const [, tick] = useState(0)
  useEffect(() => {
    if (!job || isFinished(job)) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [job?.id, job?.status])

  const result = job?.status === 'done' ? (job.result as unknown as AskResult) : null
  const failed = job?.status === 'failed' ? (job.error ?? 'Couldn’t answer.') : null

  return (
    <li className="ask-panel">
      <div className="ask-q">
        <Sparkles size={16} /> {question}
      </div>
      {(error || failed) && <p className="error-text">{error ?? failed}</p>}
      {failed && !error && (
        <button
          className="text"
          onClick={() =>
            void submitJob({ kind: 'ask', title: question, input })
              .then((j) => watchingJob(j.id, true))
              .catch((e) => setError((e as Error).message))
          }
        >
          Try again
        </button>
      )}
      {!result && !error && !failed && (
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
      )}
      {result && <AskAnswer result={result} onOpen={onOpen} />}
    </li>
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
