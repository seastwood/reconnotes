import { Capacitor } from '@capacitor/core'
import { newId } from '@reconnotes/core'
import { Store, useStore } from './store'
import { apiUrl, authHeaders, isSyncConfigured, settings } from './settings'
import { showActionToast } from './toast'
import { showNotification } from './notify'
import { pushOn } from './push'

/**
 * Jobs: every AI request and processing step runs on the server as a job
 * (see apps/server/src/jobs.ts). This keeps a live copy of the list – the
 * server holds each request open until something changes – and tells you
 * when a job you started here finishes.
 */

export type JobStatus = 'queued' | 'paused' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  kind: string
  title: string
  noteId: string | null
  status: JobStatus
  origin: 'user' | 'auto' | 'device'
  device: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  agent: string | null
  progress: string | null
  prompt: string | null
  parentId: string | null
  replacedBy: string | null
  redoable: boolean
  /** waiting to try again (the AI server couldn't be reached) at this time */
  retryAt: number | null
  attempts: number
}

interface JobsState {
  jobs: Job[]
  paused: boolean
  counts: { queued: number; paused: number; running: number }
  kinds: Record<string, string>
  version: number
  loaded: boolean
  error: string | null
}

export const jobsStore = new Store<JobsState>({
  jobs: [],
  paused: false,
  counts: { queued: 0, paused: 0, running: 0 },
  kinds: {},
  version: 0,
  loaded: false,
  error: null,
})
export const useJobs = <S,>(select: (s: JobsState) => S) => useStore(jobsStore, select)

export const FINISHED: JobStatus[] = ['done', 'failed', 'cancelled']
export const isFinished = (j: Job) => FINISHED.includes(j.status)

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!isSyncConfigured()) throw new Error('Connect a ReconNotes server in Settings to use AI features.')
  const res = await fetch(apiUrl(path), {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Server error ${res.status}`)
  return json as T
}

function apply(p: Omit<JobsState, 'loaded' | 'error'>) {
  const before = new Map(jobsStore.get().jobs.map((j) => [j.id, j]))
  jobsStore.set({ ...p, loaded: true, error: null })
  for (const j of p.jobs) {
    const was = before.get(j.id)
    if (mine.has(j.id) && isFinished(j) && (!was || !isFinished(was))) announce(j)
  }
}

// --- the live list -------------------------------------------------------------

let running = false
let wake: (() => void) | null = null

/** Keep the job list up to date while the app is open. */
export function startJobs() {
  if (running) return
  running = true
  const native = Capacitor.isNativePlatform()
  /** a job started here is still running or waiting */
  const pending = () => jobsStore.get().jobs.some((j) => mine.has(j.id) && !isFinished(j))
  const loop = async () => {
    for (;;) {
      // in the background: iOS freezes the app soon, so the server notifies instead; a
      // browser tab keeps following its own jobs so it can show a notification
      const idle = !isSyncConfigured() || (document.hidden && (native || !pending()))
      if (idle) {
        await new Promise<void>((r) => {
          wake = r
          setTimeout(r, 5000)
        })
        continue
      }
      try {
        const v = jobsStore.get().loaded ? jobsStore.get().version : 0
        apply(await call<Omit<JobsState, 'loaded' | 'error'>>('GET', v ? `/api/jobs/changes?since=${v}${document.hidden ? '&away=1' : ''}` : '/api/jobs'))
      } catch (e) {
        jobsStore.set({ ...jobsStore.get(), error: (e as Error).message })
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
  // does the server push notifications itself?
  if (isSyncConfigured()) void call<{ kind: string }>('GET', '/api/notify').then((n) => (serverPush = n.kind !== 'off')).catch(() => {})
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return wake?.()
    // going to the background: let the server send notifications from now on
    if (native && isSyncConfigured()) void fetch(apiUrl('/api/jobs/away'), { method: 'POST', headers: authHeaders(), keepalive: true }).catch(() => {})
  })
  void loop()
}

/** Fetch the list now (after an action), without waiting for the long poll. */
async function refresh() {
  try {
    apply(await call('GET', '/api/jobs'))
  } catch {
    /* the loop will catch up */
  }
}

// --- asking for jobs -------------------------------------------------------------

/** jobs started from this device: we say when they finish */
const mine = new Set<string>()
/** jobs whose caller is waiting for them (shows its own message, no toast) */
const awaited = new Set<string>()
/** Someone on screen is showing this job's result: no "finished" toast for it (while `on`). */
export function watchingJob(id: string, on: boolean) {
  if (on) awaited.add(id)
  else awaited.delete(id)
}

export interface JobRequest {
  kind: string
  title?: string
  noteId?: string | null
  input?: Record<string, unknown>
  prompt?: string
  /** a picture / image to work on, base64 */
  file?: string
}

export async function submitJob(req: JobRequest): Promise<Job> {
  const { job } = await call<{ job: Job }>('POST', '/api/jobs', req)
  mine.add(job.id)
  void refresh()
  return job
}

/**
 * Wait for a job to finish. Resolves with the finished job; throws with its
 * error when it failed or was cancelled.
 */
export async function waitJob(id: string): Promise<Job> {
  awaited.add(id)
  try {
    for (;;) {
      const { job } = await call<{ job: Job }>('GET', `/api/jobs/${id}/wait`)
      if (job.status === 'done') return job
      if (job.status === 'failed') throw new Error(job.error ?? 'The job failed.')
      if (job.status === 'cancelled') throw new JobCancelled()
      if (job.retryAt) throw new Error('Your AI server can’t be reached right now – this will be tried again automatically (see Jobs).')
    }
  } finally {
    setTimeout(() => awaited.delete(id), 3000)
  }
}

/** Thrown when a job you were waiting for was cancelled (from the Jobs list): not an error to show. */
export class JobCancelled extends Error {
  constructor() {
    super('Cancelled.')
  }
}
/** The message to show for a failed AI action, or null when it was just cancelled. */
export const errorText = (e: unknown): string | null => (e instanceof JobCancelled ? null : (e as Error).message)

/** Ask for a job and wait for it. */
export async function runJob(req: JobRequest): Promise<Job> {
  const job = await submitJob(req)
  return waitJob(job.id)
}

/** Load the handwriting model on the server ahead of time (a note with handwriting or pictures was opened). */
export function warmUpAi() {
  if (isSyncConfigured()) void call('POST', '/api/ai/warm', {}).catch(() => {})
}

/** A job id made here, for work done on this device (its results carry it). */
export const localJobId = () => newId()

/** Show work done on this device (e.g. Apple's recognizer) in the job list. */
export function recordJob(j: { id: string; kind: string; title: string; noteId?: string | null; input?: Record<string, unknown>; result?: Record<string, unknown>; agent: string; startedAt: number; error?: string }) {
  if (!isSyncConfigured()) return
  void call('POST', '/api/jobs/record', { ...j, finishedAt: Date.now() })
    .then(refresh)
    .catch(() => {})
}

// --- actions -----------------------------------------------------------------------

const act = async (path: string, body?: unknown) => {
  const r = await call<{ job?: Job }>('POST', path, body ?? {})
  await refresh()
  return r.job ?? null
}
export const cancelJob = (id: string) => act(`/api/jobs/${id}/cancel`)
export const pauseJob = (id: string) => act(`/api/jobs/${id}/pause`)
export const resumeJob = (id: string) => act(`/api/jobs/${id}/resume`)
export const runJobNext = (id: string) => act(`/api/jobs/${id}/run-next`)
export const removeJobResult = (id: string) => act(`/api/jobs/${id}/remove-result`)
export const clearFinishedJobs = () => act('/api/jobs/clear-finished')
export const pauseAllJobs = (paused: boolean) => act('/api/jobs/pause-all', { paused })
export async function redoJob(id: string, prompt?: string): Promise<Job | null> {
  const job = await act(`/api/jobs/${id}/redo`, { prompt: prompt ?? '' })
  if (job) mine.add(job.id)
  return job
}
export async function deleteJob(id: string) {
  await call('DELETE', `/api/jobs/${id}`)
  await refresh()
}

// --- telling you when it's done -------------------------------------------------

type Navigator = { openNote(id: string): void; showJobs(): void; showSearch?(query: string): void }
let nav: Navigator | null = null
/** The app tells us how to open a note or the job list (for the toasts' buttons). */
export function setJobNavigator(n: Navigator) {
  nav = n
}

/** whether the server sends notifications itself (then the iOS app doesn't double up) */
let serverPush = false
export function setServerPush(on: boolean) {
  serverPush = on
}

/** Open a note from outside React (toasts, file blocks). */
export const navigateToNote = (id: string) => nav?.openNote(id)

/** What a job made, if it's a note to open. */
export function productNote(j: Job): string | null {
  if (j.result?.removed) return null
  const id = (j.kind === 'compile' ? j.result?.noteId : j.noteId) as string | null | undefined
  return id ?? null
}

function announce(j: Job) {
  const label = jobsStore.get().kinds[j.kind] ?? 'Job'
  // not looking at the app: a system notification (if allowed)
  if (document.hidden) {
    if (settings.get().jobNotifications && !pushOn() && !(Capacitor.isNativePlatform() && serverPush) && (j.status === 'done' || j.status === 'failed')) {
      const note = j.status === 'done' ? productNote(j) : j.noteId
      void showNotification(
        `${label} ${j.status === 'done' ? 'finished' : 'failed'}`,
        j.status === 'done' ? j.title : `${j.title}: ${j.error ?? ''}`.slice(0, 200),
        note,
        (id) => nav?.openNote(id),
      ).catch(() => {})
    }
    return
  }
  if (awaited.has(j.id)) return
  if (j.status === 'done' && j.kind === 'ask' && nav?.showSearch) {
    const q = String(j.input.question ?? '')
    showActionToast('Your notes have an answer', 'Show', () => nav?.showSearch?.(q))
  } else if (j.status === 'done') {
    const note = productNote(j)
    if (note) showActionToast(`${label} finished – ${j.title}`, 'Open', () => nav?.openNote(note))
    else showActionToast(`${label} finished`, 'Jobs', () => nav?.showJobs())
  } else if (j.status === 'failed') {
    showActionToast(`${label} failed – ${j.error?.slice(0, 80) ?? ''}`, 'Jobs', () => nav?.showJobs())
  }
}
