import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Copy,
  Eraser,
  FileSearch,
  FlaskConical,
  Network,
  BookmarkPlus,
  FileText,
  ListChecks,
  ListStart,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  PanelLeft,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  ScanText,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  XCircle,
} from 'lucide-react'
import {
  cancelJob,
  clearFinishedJobs,
  deleteJob,
  isFinished,
  pauseAllJobs,
  pauseJob,
  productNote,
  redoJob,
  removeJobResult,
  resumeJob,
  runJobNext,
  useJobs,
  type Job,
} from '../lib/jobs'
import { isSyncConfigured } from '../lib/settings'
import { showToast } from '../lib/toast'
import { useWorkspace } from '../lib/workspace'
import { Popover } from './Popover'
import { AiHealthLine, BenchTable } from './AiHealth'
import { AskAnswer, type AskResult } from './AskPanel'
import { samplesApi, type BenchResult } from '../lib/agents'

const ICONS: Record<string, typeof Sparkles> = {
  'convert-drawing': PenLine,
  'convert-picture': ScanText,
  transcribe: AudioLines,
  summary: FileText,
  todos: ListChecks,
  clean: WandSparkles,
  compile: Sparkles,
  ask: MessageSquareText,
  tidy: WandSparkles,
  recognise: Search,
  'extract-text': FileSearch,
  embed: Network,
  benchmark: FlaskConical,
}

/** 75 s → "1:15", 3700 s → "1:01:40" */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const clock = (t: number) => {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Re-render every second while something is running. */
function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

interface Props {
  onOpenNote: (id: string) => void
  onBack?: () => void
  onToggleFolders?: () => void
}

/**
 * The Jobs list: everything the AI and the server are doing or have done –
 * what's running (and for how long), what's waiting, and what finished, with
 * links to the results, the errors, and ways to cancel, pause, retry or
 * redo with extra instructions.
 */
export function JobsPanel({ onOpenNote, onBack, onToggleFolders }: Props) {
  const { jobs, paused, loaded, error, kinds } = useJobs((s) => s)
  const [showAuto, setShowAuto] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuBtn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<string | null>(null)
  const anyRunning = jobs.some((j) => j.status === 'running')
  useTick(anyRunning || jobs.some((j) => j.status === 'queued'))

  const visible = jobs.filter((j) => showAuto || j.origin !== 'auto' || !isFinished(j))
  const runningJobs = visible.filter((j) => j.status === 'running')
  const waiting = visible.filter((j) => j.status === 'queued' || j.status === 'paused')
  const finished = visible.filter(isFinished)
  const hiddenAuto = jobs.filter((j) => j.origin === 'auto' && isFinished(j)).length

  const queuePos = useMemo(() => new Map(jobs.filter((j) => j.status === 'queued').map((j, i) => [j.id, i + 1])), [jobs])

  const section = (label: string, list: Job[]) =>
    list.length > 0 && (
      <>
        <div className="jobs-section">{label}</div>
        {list.map((j) => (
          <JobRow
            key={j.id}
            job={j}
            label={kinds[j.kind] ?? j.kind}
            pos={queuePos.get(j.id)}
            open={open === j.id}
            onToggle={() => setOpen(open === j.id ? null : j.id)}
            onOpenNote={onOpenNote}
            jobs={jobs}
          />
        ))}
      </>
    )

  return (
    <section className="note-list jobs-panel">
      <header className="list-head">
        {onBack && (
          <button className="icon" onClick={onBack} aria-label="Back to folders">
            <ChevronLeft size={22} />
          </button>
        )}
        {onToggleFolders && (
          <button className="icon" onClick={onToggleFolders} aria-label="Show folders" title="Show folders">
            <PanelLeft size={20} />
          </button>
        )}
        <h2>Jobs</h2>
        <button
          className={`icon${paused ? ' on' : ''}`}
          onClick={() => void pauseAllJobs(!paused).catch((e) => showToast((e as Error).message))}
          aria-label={paused ? 'Resume the queue' : 'Pause the queue'}
          title={paused ? 'Resume the queue' : 'Pause the queue (the job running now finishes)'}
        >
          {paused ? <Play size={18} /> : <Pause size={18} />}
        </button>
        <div className="menu-anchor">
          <button ref={menuBtn} className="icon" onClick={() => setMenu(!menu)} aria-label="Job options">
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <Popover anchorRef={menuBtn} align="right" onClose={() => setMenu(false)}>
              <button className={showAuto ? 'checked' : ''} onClick={() => (setShowAuto(!showAuto), setMenu(false))}>
                Show background work
              </button>
              <button
                disabled={!jobs.some(isFinished)}
                onClick={() => {
                  setMenu(false)
                  void clearFinishedJobs()
                }}
              >
                Clear finished jobs
              </button>
            </Popover>
          )}
        </div>
      </header>
      <div className="notes jobs-scroll">
        {!isSyncConfigured() && <p className="empty-hint">Jobs run on your ReconNotes server. Connect one in Settings to use AI features.</p>}
        {error && isSyncConfigured() && <p className="jobs-error">Can’t reach the server: {error}</p>}
        {!error && isSyncConfigured() && <AiHealthLine trigger={`${runningJobs.map((j) => j.id).join(',')}|${finished.length}`} />}
        {paused && (
          <div className="jobs-paused">
            <Pause size={14} /> The queue is paused – nothing new starts.
            <button className="text" onClick={() => void pauseAllJobs(false)}>
              Resume
            </button>
          </div>
        )}
        {section('Running', runningJobs)}
        {section(paused ? 'Waiting (queue paused)' : 'Up next', waiting)}
        {section('Finished', finished)}
        {loaded && !visible.length && isSyncConfigured() && (
          <p className="empty-hint">
            No jobs yet. Converting handwriting, transcribing, summarising and compiling show up here while they run and afterwards.
          </p>
        )}
        {!showAuto && hiddenAuto > 0 && (
          <button className="text jobs-show-auto" onClick={() => setShowAuto(true)}>
            Show {hiddenAuto} background job{hiddenAuto === 1 ? '' : 's'} (reading handwriting and files for search)
          </button>
        )}
      </div>
    </section>
  )
}

function statusLine(j: Job, pos: number | undefined): string {
  const now = Date.now()
  switch (j.status) {
    case 'running':
      return `Running ${duration(now - (j.startedAt ?? now))}${j.progress ? ` · ${j.progress}` : ''}`
    case 'queued':
      if (j.retryAt) return `AI server unreachable – trying again in ${duration(Math.max(0, j.retryAt - now)).replace(/\.\d s$/, ' s')} (attempt ${j.attempts + 1})`
      return `Waiting${pos ? ` · #${pos} in line` : ''} · ${duration(now - j.createdAt)}`
    case 'paused':
      return 'Paused'
    case 'done':
      if (j.replacedBy) return 'Replaced by a newer run'
      if (j.result?.removed) return 'Result removed'
      return `Done in ${duration((j.finishedAt ?? now) - (j.startedAt ?? j.createdAt))}${j.agent ? ` · ${j.agent}` : ''}`
    case 'failed':
      return `Failed${j.startedAt ? ` after ${duration((j.finishedAt ?? now) - j.startedAt)}` : ''}`
    case 'cancelled':
      return 'Cancelled'
  }
}

function JobRow({ job: j, label, pos, open, onToggle, onOpenNote, jobs }: { job: Job; label: string; pos?: number; open: boolean; onToggle: () => void; onOpenNote: (id: string) => void; jobs: Job[] }) {
  const ws = useWorkspace()
  const Icon = ICONS[j.kind] ?? Sparkles
  const [redoing, setRedoing] = useState(false)
  const [prompt, setPrompt] = useState(j.prompt ?? '')
  const [busy, setBusy] = useState(false)
  const product = productNote(j)
  const productExists = product ? ws.notes.some((n) => n.id === product && !n.trashedAt) : false
  const sourceExists = j.noteId ? ws.notes.some((n) => n.id === j.noteId && !n.trashedAt) : false
  const replacedBy = j.replacedBy ? jobs.find((x) => x.id === j.replacedBy) : null
  const text = typeof j.result?.text === 'string' ? j.result.text : typeof j.result?.answer === 'string' ? j.result.answer : ''

  const run = (f: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await f()
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const copy = (t: string) => void navigator.clipboard?.writeText(t).then(() => showToast('Copied'))

  return (
    <div className={`job-row status-${j.status}${open ? ' open' : ''}${j.origin === 'auto' ? ' auto' : ''}`}>
      <button className="job-head" onClick={onToggle} aria-expanded={open}>
        <span className="job-icon">
          {j.status === 'running' ? <Loader2 size={17} className="spin" /> : <Icon size={17} />}
        </span>
        <span className="job-main">
          <span className="job-title">
            {label}
            <span className="job-of"> · {j.title}</span>
          </span>
          <span className="job-status">
            {j.status === 'done' && <CheckCircle2 size={12} />}
            {j.status === 'failed' && <XCircle size={12} />}
            {j.status === 'cancelled' && <Ban size={12} />}
            {j.status === 'paused' && <Pause size={12} />}
            {statusLine(j, pos)}
          </span>
          {j.status === 'failed' && j.error && !open && <span className="job-error-line">{j.error}</span>}
        </span>
        <ChevronDown size={15} className="job-chevron" />
      </button>

      {/* the quick actions, without opening the job */}
      {!open && (j.status === 'running' || j.status === 'queued' || j.status === 'paused') && (
        <div className="job-quick">
          {j.status === 'paused' ? (
            <button className="icon" onClick={run(() => resumeJob(j.id))} aria-label="Resume" title="Resume">
              <Play size={15} />
            </button>
          ) : (
            j.redoable && (
              <button className="icon" onClick={run(() => pauseJob(j.id))} aria-label="Pause" title={j.status === 'running' ? 'Pause (it starts over when resumed)' : 'Pause'}>
                <Pause size={15} />
              </button>
            )
          )}
          <button className="icon" onClick={run(() => cancelJob(j.id))} aria-label="Cancel" title="Cancel">
            <XCircle size={15} />
          </button>
        </div>
      )}

      {open && (
        <div className="job-detail">
          <dl>
            {j.noteId && (
              <>
                <dt>Note</dt>
                <dd>
                  {sourceExists ? (
                    <button className="text link" onClick={() => onOpenNote(j.noteId!)}>
                      {j.title}
                    </button>
                  ) : (
                    <span className="muted">{j.title} (deleted)</span>
                  )}
                </dd>
              </>
            )}
            {j.kind === 'compile' && product && (
              <>
                <dt>Made</dt>
                <dd>
                  {productExists ? (
                    <button className="text link" onClick={() => onOpenNote(product)}>
                      Open the compiled note
                    </button>
                  ) : (
                    <span className="muted">The compiled note was deleted</span>
                  )}
                </dd>
              </>
            )}
            <dt>Asked</dt>
            <dd>
              {clock(j.createdAt)}
              {j.device ? ` on ${j.device}` : ''}
              {j.origin === 'auto' ? ' (automatic)' : j.origin === 'device' ? ' (done on the device)' : ''}
            </dd>
            {j.startedAt && j.status !== 'queued' && (
              <>
                <dt>Timing</dt>
                <dd>
                  {j.startedAt - j.createdAt > 1500 ? `waited ${duration(j.startedAt - j.createdAt)}, ` : ''}
                  {j.status === 'running' ? `running for ${duration(Date.now() - j.startedAt)}` : j.finishedAt ? `took ${duration(j.finishedAt - j.startedAt)}` : ''}
                </dd>
              </>
            )}
            {j.agent && (
              <>
                <dt>{j.status === 'running' ? 'Trying' : 'Done by'}</dt>
                <dd>{j.agent}</dd>
              </>
            )}
            {j.prompt && (
              <>
                <dt>Your instructions</dt>
                <dd className="job-prompt">{j.prompt}</dd>
              </>
            )}
            {j.replacedBy && (
              <>
                <dt>Result</dt>
                <dd className="muted">Replaced by a newer run{replacedBy ? ` (${clock(replacedBy.createdAt)})` : ''}</dd>
              </>
            )}
            {j.result?.removed === true && (
              <>
                <dt>Result</dt>
                <dd className="muted">Removed{j.kind === 'compile' ? ' (the note is in Recently Deleted)' : ''}</dd>
              </>
            )}
          </dl>

          {j.error && (
            <div className="job-error">
              <div>{j.error}</div>
              <button className="text" onClick={() => copy(j.error!)}>
                <Copy size={13} /> Copy error
              </button>
            </div>
          )}
          {Array.isArray(j.result?.removedLines) && (j.result.removedLines as string[]).length > 0 && (
            <div className="job-result">
              <div className="muted">
                {(j.result.removedLines as string[]).length === 1
                  ? 'Left out a line the AI wrote that isn’t in your note:'
                  : `Left out ${(j.result.removedLines as string[]).length} lines the AI wrote that aren’t in your note:`}
              </div>
              <pre>{(j.result.removedLines as string[]).join('\n')}</pre>
            </div>
          )}
          {text && j.status === 'done' && (
            <div className="job-result">
              {j.kind === 'ask' && typeof j.result?.answer === 'string' ? (
                <div className="ask-panel">
                  <AskAnswer result={j.result as unknown as AskResult} onOpen={onOpenNote} />
                </div>
              ) : (
                <pre>{text}</pre>
              )}
              <button className="text" onClick={() => copy(text)}>
                <Copy size={13} /> Copy
              </button>
            </div>
          )}

          {j.kind === 'benchmark' && j.status === 'done' && Array.isArray(j.result?.results) && <BenchTable results={j.result.results as BenchResult[]} />}

          {redoing && (
            <div className="job-redo">
              <textarea
                autoFocus
                rows={3}
                placeholder="Extra instructions (optional), e.g. “Keep my bullet points”, “It’s a shopping list”, “Translate to French”"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="job-redo-actions">
                <button className="text" onClick={() => setRedoing(false)}>
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={run(async () => {
                    await redoJob(j.id, prompt)
                    setRedoing(false)
                    showToast(j.status === 'done' && !j.result?.removed ? 'Redoing – the new result will replace this one' : 'Queued again')
                  })}
                >
                  <RotateCcw size={14} /> Redo
                </button>
              </div>
            </div>
          )}

          <div className="job-actions">
            {j.status === 'running' && (
              <>
                {j.redoable && (
                  <button onClick={run(() => pauseJob(j.id))} title="Stops it now; it starts over when resumed">
                    <Pause size={14} /> Pause
                  </button>
                )}
                <button onClick={run(() => cancelJob(j.id))}>
                  <XCircle size={14} /> Cancel
                </button>
              </>
            )}
            {j.status === 'queued' && j.retryAt && (
              <button onClick={run(() => resumeJob(j.id))} title="Try now instead of waiting">
                <RotateCcw size={14} /> Try now
              </button>
            )}
            {(j.status === 'queued' || j.status === 'paused') && (
              <>
                {pos !== 1 && (
                  <button onClick={run(() => runJobNext(j.id))}>
                    <ListStart size={14} /> Run next
                  </button>
                )}
                {j.status === 'paused' ? (
                  <button onClick={run(() => resumeJob(j.id))}>
                    <Play size={14} /> Resume
                  </button>
                ) : (
                  <button onClick={run(() => pauseJob(j.id))}>
                    <Pause size={14} /> Pause
                  </button>
                )}
                <button onClick={run(() => cancelJob(j.id))}>
                  <XCircle size={14} /> Cancel
                </button>
              </>
            )}
            {j.status === 'done' && product && productExists && j.kind !== 'compile' && (
              <button onClick={() => onOpenNote(product)}>
                <FileText size={14} /> Open note
              </button>
            )}
            {isFinished(j) && j.redoable && !redoing && (
              <>
                {j.status !== 'done' && (
                  <button onClick={run(async () => void (await redoJob(j.id)))}>
                    <RotateCcw size={14} /> Retry
                  </button>
                )}
                <button onClick={() => setRedoing(true)}>
                  <WandSparkles size={14} /> {j.status === 'done' ? 'Redo with instructions…' : 'Retry with instructions…'}
                </button>
              </>
            )}
            {j.status === 'done' && !j.result?.removed && !j.replacedBy && (j.kind === 'compile' ? productExists : Boolean(j.noteId) && j.kind !== 'recognise' && j.kind !== 'clean') && (
              <button
                onClick={run(async () => {
                  if (!confirm(j.kind === 'compile' ? 'Move the compiled note to Recently Deleted?' : 'Remove the text this job added to the note? (Changes you made to it go too.)')) return
                  await removeJobResult(j.id)
                })}
              >
                <Eraser size={14} /> Remove result
              </button>
            )}
            {j.status === 'done' && !j.result?.removed && (j.kind === 'convert-drawing' || j.kind === 'convert-picture') && (
              <button
                onClick={run(async () => {
                  await samplesApi.fromJob(j.id)
                  showToast('Saved as a test sample – compare models in Settings › AI')
                })}
                title="Fix the text in the note first: it’s used as the right answer when testing models"
              >
                <BookmarkPlus size={14} /> Save as test sample
              </button>
            )}
            {isFinished(j) && (
              <button className="danger" onClick={run(() => deleteJob(j.id))} title="Remove from this list (the result stays)">
                <Trash2 size={14} /> Forget
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
