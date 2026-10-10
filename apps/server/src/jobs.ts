import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { newId } from '@reconnotes/core'
import type { Store } from './store'
import { log } from './log'

/**
 * Jobs
 * ====
 *
 * Every AI request and background processing step (reading handwriting,
 * transcribing a recording, compiling a note, extracting text from a PDF…)
 * is a job in one queue. Jobs run one at a time – a local GPU or a paid API
 * shouldn't be hit in parallel – and are saved in the database, so the list
 * survives restarts and shows what ran, how long it took, which AI agent did
 * it and what came out. A job can be cancelled, paused, moved to the front,
 * retried, or redone with extra instructions (which replaces its result).
 *
 * Results that belong in a note are written into the note by the server
 * (see jobHandlers.ts), so a job finishes even if the app was closed.
 */

export type JobStatus = 'queued' | 'paused' | 'running' | 'done' | 'failed' | 'cancelled'
export type JobOrigin = 'user' | 'auto' | 'device'

export interface Job {
  id: string
  kind: string
  title: string
  noteId: string | null
  status: JobStatus
  origin: JobOrigin
  /** which device asked for it */
  device: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  /** the AI agent that produced the result (or is being tried now) */
  agent: string | null
  /** what it's doing right now, e.g. "Trying Ollama (qwen2.5vl)" */
  progress: string | null
  /** the result so far, while it's being written (e.g. an answer appearing word by word) */
  partial: Record<string, unknown> | null
  /** extra instructions for the AI, given when redoing a job */
  prompt: string | null
  /** the job this one redoes */
  parentId: string | null
  /** a later job that redid this one and replaced its result */
  replacedBy: string | null
  /** whether the server knows how to run it again (redo / retry / resume after a restart) */
  redoable: boolean
  /** waiting to try again (the AI server couldn't be reached) at this time */
  retryAt: number | null
  /** how many times it has been tried automatically */
  attempts: number
}

export interface JobSpec {
  kind: string
  title: string
  noteId?: string | null
  input?: Record<string, unknown>
  origin?: JobOrigin
  device?: string | null
  prompt?: string | null
  parentId?: string | null
  /** don't add a second queued job with the same key (e.g. background recognition of one drawing) */
  dedupeKey?: string
}

export interface JobOutcome {
  result?: Record<string, unknown> | null
  agent?: string | null
}

export type JobHandler = (job: Job) => Promise<JobOutcome>

/** What the job running now can see (AI calls use it to stop when cancelled). */
interface JobContext {
  job: Job
  signal: AbortSignal
  setAgent(name: string): void
  setProgress(text: string): void
  setPartial(value: Record<string, unknown>): void
}
const context = new AsyncLocalStorage<JobContext>()

/** The cancel signal of the job running now (if any). */
export function jobSignal(): AbortSignal | undefined {
  return context.getStore()?.signal
}

/** A timeout that also ends when the job running now is cancelled or paused. */
export function timeoutSignal(ms: number): AbortSignal {
  const own = jobSignal()
  const t = AbortSignal.timeout(ms)
  return own ? AbortSignal.any([t, own]) : t
}

/** Extra instructions for the AI, given when redoing a job ('' when none). */
export function extraInstructions(): string {
  return context.getStore()?.job.prompt?.trim() ?? ''
}

/** Add the user's extra instructions (if any) to a prompt. */
export function withExtra(prompt: string, where: 'start' | 'end' = 'end'): string {
  const extra = extraInstructions()
  if (!extra) return prompt
  const line = `Additional instructions from the user (follow these): ${extra}`
  return where === 'start' ? `${line}\n\n${prompt}` : `${prompt}\n\n${line}`
}

/** The job running now redoes an earlier one (so it should read afresh, not reuse a saved reading). */
export function isRedo(): boolean {
  return Boolean(context.getStore()?.job.input.replace)
}

/** Tell the job list which AI agent is being tried. */
export function reportAgent(name: string) {
  context.getStore()?.setAgent(name)
}

/** Show the result so far while it's being written (the app shows it as it grows). */
export function reportPartial(value: Record<string, unknown>) {
  context.getStore()?.setPartial(value)
}

/** Say how far the running job has got ("sample 2 of 5"). */
export function reportProgress(text: string) {
  context.getStore()?.setProgress(text)
}

export class JobCancelledError extends Error {
  constructor(readonly reason: 'cancel' | 'pause') {
    super(reason === 'pause' ? 'Paused' : 'Cancelled')
  }
}

const KEEP_FINISHED = 300

interface Row {
  id: string
  kind: string
  title: string
  note_id: string | null
  status: JobStatus
  origin: JobOrigin
  device: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  input: string
  result: string | null
  error: string | null
  agent: string | null
  prompt: string | null
  parent_id: string | null
  replaced_by: string | null
  rank: number
  dedupe_key: string | null
  attempts: number | null
  retry_at: number | null
}

/** Failures worth trying again by themselves: the AI server was off, asleep or restarting. */
const UNREACHABLE = /connection refused|can't reach|could not connect|connection to .* timed out|can't find the host|returned 50[234]|ECONNRESET|socket hang up/i
/** wait this long before each automatic retry */
const RETRY_AFTER = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

export class Jobs {
  private handlers = new Map<string, JobHandler>()
  /** closures for jobs that only exist while the server runs (no handler) */
  private closures = new Map<string, () => Promise<JobOutcome>>()
  private settle = new Map<string, { resolve: (j: Job) => void }[]>()
  private running: { id: string; controller: AbortController } | null = null
  private progress = new Map<string, string>()
  private liveAgent = new Map<string, string>()
  private partial = new Map<string, Record<string, unknown>>()
  private partialTimer: NodeJS.Timeout | null = null
  private waiters: (() => void)[] = []
  private pumping = false
  /**
   * The AI models a job starts and ends with (e.g. the vision model, then the
   * text model that tidies), so the queue can run jobs for the model that's
   * already loaded first – a home GPU can't hold both, and swapping takes seconds.
   */
  modelsOf: ((job: Job) => { first: string | null; last: string | null }) | null = null
  private lastModel: string | null = null
  private passedOver = new Map<string, number>()
  private moved = new Set<string>()
  private retryTimer: NodeJS.Timeout | null = null
  /** called when a job finishes (done, failed or cancelled) – e.g. to send a notification */
  onFinish: ((job: Job) => void) | null = null
  /** bumps on every change, so the app can wait for the next one */
  version = 1
  readonly fileDir: string

  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        note_id TEXT,
        status TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        device TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        input TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        error TEXT,
        agent TEXT,
        prompt TEXT,
        parent_id TEXT,
        replaced_by TEXT,
        rank REAL NOT NULL,
        dedupe_key TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, rank);
      CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
    `)
    const cols = new Set((store.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('attempts')) store.db.exec('ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
    if (!cols.has('retry_at')) store.db.exec('ALTER TABLE jobs ADD COLUMN retry_at INTEGER')
    this.fileDir = path.join(store.dataDir, 'job-files')
    fs.mkdirSync(this.fileDir, { recursive: true })
    // a job that was running when the server stopped starts again
    store.db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run()
    this.queuePaused = store.getSetting<boolean>('jobs.paused') === true
  }

  queuePaused: boolean

  /** How to run (and re-run) a kind of job. */
  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler)
  }

  /** Start handling jobs (after the handlers are registered). */
  start() {
    // jobs left from before a restart that can't run again
    for (const r of this.rows("status IN ('queued', 'paused')")) {
      if (!this.handlers.has(r.kind)) this.finish(r.id, { status: 'failed', error: 'The server restarted before this ran. Try it again.' })
    }
    this.kick()
  }

  /** Queue a job of a registered kind. */
  submit(spec: JobSpec): Job {
    if (!this.handlers.has(spec.kind)) throw new Error(`unknown job kind ${spec.kind}`)
    return this.add(spec)
  }

  /**
   * Run some work as a job (it waits its turn in the queue) and resolve with
   * its result. Used for requests the app waits on.
   */
  async run<T>(spec: JobSpec, fn: () => Promise<T>, outcome: (r: T) => JobOutcome = () => ({})): Promise<T> {
    let value: T
    const job = this.add(spec, async () => {
      value = await fn()
      return outcome(value)
    })
    const done = await this.wait(job.id)
    if (done.status === 'done') return value!
    if (done.status === 'cancelled') throw new JobCancelledError('cancel')
    throw this.errors.get(job.id) ?? new Error(done.error ?? 'failed')
  }
  private errors = new Map<string, Error>()

  /** Record work done elsewhere (e.g. Apple's recognizer on the iPad), so it shows in the list. */
  record(spec: JobSpec & { startedAt?: number; finishedAt?: number; result?: Record<string, unknown> | null; agent?: string | null; error?: string | null; id?: string }): Job {
    const now = Date.now()
    const id = spec.id && /^[a-z0-9]{8,64}$/.test(spec.id) && !this.get(spec.id) ? spec.id : newId()
    this.store.db
      .prepare(
        `INSERT INTO jobs (id, kind, title, note_id, status, origin, device, created_at, started_at, finished_at, input, result, error, agent, prompt, parent_id, rank)
         VALUES (?, ?, ?, ?, ?, 'device', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        spec.kind,
        spec.title.slice(0, 200),
        spec.noteId ?? null,
        spec.error ? 'failed' : 'done',
        spec.device ?? null,
        spec.startedAt ?? now,
        spec.startedAt ?? now,
        spec.finishedAt ?? now,
        JSON.stringify(spec.input ?? {}),
        spec.result ? JSON.stringify(spec.result) : null,
        spec.error ?? null,
        spec.agent ?? null,
        spec.prompt ?? null,
        spec.parentId ?? null,
        now,
      )
    this.changed()
    this.prune()
    return this.get(id)!
  }

  private add(spec: JobSpec, closure?: () => Promise<JobOutcome>): Job {
    if (spec.dedupeKey) {
      const dup = this.store.db
        .prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'paused')")
        .get(spec.dedupeKey) as { id: string } | undefined
      if (dup) return this.get(dup.id)!
    }
    const id = newId()
    const now = Date.now()
    this.store.db
      .prepare(
        `INSERT INTO jobs (id, kind, title, note_id, status, origin, device, created_at, input, prompt, parent_id, rank, dedupe_key)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        spec.kind,
        spec.title.slice(0, 200),
        spec.noteId ?? null,
        spec.origin ?? 'user',
        spec.device ?? null,
        now,
        JSON.stringify(spec.input ?? {}),
        spec.prompt?.trim() || null,
        spec.parentId ?? null,
        // background work waits behind what you asked for
        spec.origin === 'auto' ? now + 1e13 : now,
        spec.dedupeKey ?? null,
      )
    if (closure) this.closures.set(id, closure)
    this.changed()
    this.kick()
    return this.get(id)!
  }

  get(id: string): Job | null {
    const r = this.store.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
    return r ? this.toJob(r) : null
  }

  /**
   * The meeting notes last written from a recording in a note (done, not since replaced) – found
   * even when it's no longer among the jobs listed.
   */
  lastMeeting(noteId: string, attachmentId: string, except?: string): Job | null {
    const r = this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE kind = 'meeting' AND note_id = ? AND json_extract(input, '$.attachmentId') = ? AND status = 'done' AND replaced_by IS NULL AND id != ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(noteId, attachmentId, except ?? '') as Row | undefined
    return r ? this.toJob(r) : null
  }

  /** Newest first; queued and running ones always included. */
  list(limit = 150): Job[] {
    const active = this.rows("status IN ('queued', 'paused', 'running') ORDER BY rank")
    const done = this.store.db
      .prepare("SELECT * FROM jobs WHERE status NOT IN ('queued', 'paused', 'running') ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?")
      .all(limit) as Row[]
    return [...active, ...done].map((r) => this.toJob(r))
  }

  /** Resolve when the job has finished (done, failed or cancelled). */
  wait(id: string): Promise<Job> {
    const j = this.get(id)
    if (!j) return Promise.reject(new Error('job not found'))
    // finished – or waiting to try again later, which the caller should hear about now
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled' || j.retryAt) return Promise.resolve(j)
    return new Promise((resolve) => {
      const list = this.settle.get(id) ?? []
      list.push({ resolve })
      this.settle.set(id, list)
    })
  }

  /** Resolve on the next change to any job (or after `ms`). */
  nextChange(since: number, ms: number): Promise<void> {
    if (since !== this.version) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        this.waiters = this.waiters.filter((w) => w !== done)
        resolve()
      }
      const t = setTimeout(done, ms)
      this.waiters.push(done)
    })
  }

  cancel(id: string): Job | null {
    const j = this.get(id)
    if (!j) return null
    if (j.status === 'running' && this.running?.id === id) this.running.controller.abort(new JobCancelledError('cancel'))
    else if (j.status === 'queued' || j.status === 'paused') this.finish(id, { status: 'cancelled' })
    return this.get(id)
  }

  /** Hold a queued job (a running one stops and starts over when resumed). */
  pause(id: string): Job | null {
    const j = this.get(id)
    if (!j) return null
    if (j.status === 'running' && this.running?.id === id) {
      if (!this.handlers.has(j.kind) || this.closures.has(id)) return j // can't start it again
      this.running.controller.abort(new JobCancelledError('pause'))
    } else if (j.status === 'queued') {
      this.store.db.prepare("UPDATE jobs SET status = 'paused' WHERE id = ?").run(id)
      this.changed()
    }
    return this.get(id)
  }

  resume(id: string): Job | null {
    this.store.db.prepare("UPDATE jobs SET status = 'queued', retry_at = NULL WHERE id = ? AND status IN ('paused', 'queued')").run(id)
    this.changed()
    this.kick()
    return this.get(id)
  }

  /** Run this queued job next. */
  runNext(id: string): Job | null {
    this.moved.add(id)
    const min = this.store.db.prepare("SELECT MIN(rank) AS r FROM jobs WHERE status IN ('queued', 'paused')").get() as { r: number | null }
    this.store.db.prepare("UPDATE jobs SET rank = ?, status = CASE WHEN status = 'paused' THEN 'queued' ELSE status END WHERE id = ? AND status IN ('queued', 'paused')").run((min.r ?? Date.now()) - 1, id)
    this.changed()
    this.kick()
    return this.get(id)
  }

  /** Stop starting new jobs (the one running now finishes). */
  setPaused(paused: boolean) {
    this.queuePaused = paused
    this.store.setSetting('jobs.paused', paused)
    this.changed()
    this.kick()
  }

  /** Run a finished job again, optionally with extra instructions; its result is replaced. */
  redo(id: string, prompt: string | null, device: string | null, extra: Record<string, unknown> = {}): Job {
    const j = this.get(id)
    if (!j) throw new Error('job not found')
    if (!this.handlers.has(j.kind)) throw new Error('This kind of job can’t be redone.')
    // the result to replace: the latest one in this job's chain of redos
    let latest = j
    for (let n = 0; latest.replacedBy && n < 100; n++) latest = this.get(latest.replacedBy) ?? latest
    const replace = latest.status === 'done' && !latest.result?.removed ? latest.id : ((latest.input.replace as string | undefined) ?? null)
    const job = this.add({
      kind: j.kind,
      title: j.title,
      noteId: j.noteId,
      // one-off asks (read the recording again) don't carry on to later redos
      input: { ...Object.fromEntries(Object.entries(j.input).filter(([k]) => k !== 'retranscribe')), replace, ...extra },
      origin: 'user',
      device,
      prompt: prompt ?? j.prompt,
      parentId: id,
    })
    // the picture or image it worked on comes along (it starts on the next tick)
    if (fs.existsSync(this.filePath(id))) fs.copyFileSync(this.filePath(id), this.filePath(job.id))
    return job
  }

  /** Mark a job's result as replaced by a later one. */
  markReplaced(id: string, by: string) {
    this.store.db.prepare('UPDATE jobs SET replaced_by = ? WHERE id = ?').run(by, id)
    this.changed()
  }

  setResult(id: string, result: Record<string, unknown> | null) {
    this.store.db.prepare('UPDATE jobs SET result = ? WHERE id = ?').run(result ? JSON.stringify(result) : null, id)
    this.changed()
  }

  /** Forget a finished job. */
  remove(id: string) {
    const j = this.get(id)
    if (!j || j.status === 'running') return
    if (j.status === 'queued' || j.status === 'paused') this.cancel(id)
    this.store.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
    this.dropFiles(id)
    this.changed()
  }

  /** Forget all finished jobs. */
  clearFinished() {
    const ids = this.rows("status IN ('done', 'failed', 'cancelled')").map((r) => r.id)
    this.store.db.prepare("DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled')").run()
    ids.forEach((id) => this.dropFiles(id))
    this.changed()
  }

  /** A file kept with a job (e.g. the picture to read), so it can be redone. */
  filePath(id: string): string {
    return path.join(this.fileDir, id)
  }

  counts() {
    const rows = this.store.db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'paused', 'running') GROUP BY status").all() as { status: string; n: number }[]
    const c = { queued: 0, paused: 0, running: 0 }
    for (const r of rows) c[r.status as keyof typeof c] = r.n
    return c
  }

  // --- running ---------------------------------------------------------------

  private kick() {
    queueMicrotask(() => void this.pump())
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.queuePaused) {
        const ready = this.store.db
          .prepare("SELECT * FROM jobs WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= ?) ORDER BY rank LIMIT 40")
          .all(Date.now()) as Row[]
        if (!ready.length) break
        await this.execute(this.toJob(this.choose(ready)))
      }
    } finally {
      this.pumping = false
      this.wakeForRetries()
    }
  }

  /**
   * The next job: the first in line – unless it needs a different model than
   * the one just used and another job of the same kind (yours vs background)
   * can use the loaded one. A job is passed over at most 3 times, and never
   * when you moved it to the front.
   */
  private choose(ready: Row[]): Row {
    const head = ready[0]
    if (!this.modelsOf || !this.lastModel || this.moved.has(head.id) || (this.passedOver.get(head.id) ?? 0) >= 3) return head
    const first = (r: Row) => this.modelsOf!(this.toJob(r)).first
    if (first(head) === this.lastModel) return head
    const auto = head.origin === 'auto'
    const alt = ready.find((r) => (r.origin === 'auto') === auto && first(r) === this.lastModel)
    if (!alt) return head
    this.passedOver.set(head.id, (this.passedOver.get(head.id) ?? 0) + 1)
    return alt
  }

  /** Start again when the next automatic retry is due. */
  private wakeForRetries() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const r = this.store.db.prepare("SELECT MIN(retry_at) AS t FROM jobs WHERE status = 'queued' AND retry_at IS NOT NULL").get() as { t: number | null }
    if (r.t === null) return
    this.retryTimer = setTimeout(() => this.kick(), Math.max(1000, r.t - Date.now() + 50))
    this.retryTimer.unref?.()
  }

  private async execute(job: Job) {
    const handler = this.closures.get(job.id) ?? (this.handlers.has(job.kind) ? () => this.handlers.get(job.kind)!(job) : null)
    if (!handler) {
      this.finish(job.id, { status: 'failed', error: 'The server restarted before this ran. Try it again.' })
      return
    }
    const controller = new AbortController()
    this.running = { id: job.id, controller }
    const startedAt = Date.now()
    this.store.db.prepare("UPDATE jobs SET status = 'running', started_at = ?, error = NULL, agent = NULL WHERE id = ?").run(startedAt, job.id)
    this.changed()
    const running = { ...job, status: 'running' as const, startedAt }
    const ctx: JobContext = {
      job: running,
      signal: controller.signal,
      setAgent: (name) => {
        this.liveAgent.set(job.id, name)
        this.progress.set(job.id, `Trying ${name}`)
        this.changed()
      },
      setProgress: (text) => {
        this.progress.set(job.id, text)
        this.changed()
      },
      setPartial: (value) => {
        this.partial.set(job.id, value)
        // every app following the jobs fetches them again on a change: at most a few times a second
        this.partialTimer ??= setTimeout(() => {
          this.partialTimer = null
          this.changed()
        }, 400)
      },
    }
    // cancelling stops waiting at once, even if the AI call can't be interrupted
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    try {
      const out = await Promise.race([context.run(ctx, handler), aborted])
      // "Local (qwen2.5:7b)" says more than the handler's "Local"
      const live = this.liveAgent.get(job.id)
      const agent = live && (!out.agent || live.startsWith(out.agent)) ? live : (out.agent ?? null)
      this.finish(job.id, { status: 'done', result: out.result ?? null, agent })
    } catch (err) {
      const reason = controller.signal.aborted ? controller.signal.reason : null
      if (reason instanceof JobCancelledError && reason.reason === 'pause') {
        this.store.db.prepare("UPDATE jobs SET status = 'paused', started_at = NULL WHERE id = ?").run(job.id)
        this.cleanupRun(job.id)
        this.changed()
      } else if (reason instanceof JobCancelledError) {
        this.finish(job.id, { status: 'cancelled' })
      } else {
        const e = err instanceof Error ? err : new Error(String(err))
        this.errors.set(job.id, e)
        setTimeout(() => this.errors.delete(job.id), 60_000)
        const attempts = job.attempts ?? 0
        if (UNREACHABLE.test(e.message) && this.handlers.has(job.kind) && !this.closures.has(job.id) && attempts < RETRY_AFTER.length) {
          // the AI server is off or asleep: wait and try again by itself
          const at = Date.now() + RETRY_AFTER[attempts]
          log.warn(`job ${job.kind} "${job.title}": ${e.message} – trying again at ${new Date(at).toLocaleTimeString()}`)
          this.store.db
            .prepare("UPDATE jobs SET status = 'queued', started_at = NULL, error = ?, attempts = ?, retry_at = ? WHERE id = ?")
            .run(e.message, attempts + 1, at, job.id)
          this.cleanupRun(job.id)
          this.changed()
          // whoever waits for it hears it's waiting (the app says so instead of spinning)
          const waiting = this.get(job.id)!
          for (const w of this.settle.get(job.id) ?? []) w.resolve(waiting)
          this.settle.delete(job.id)
          return
        }
        log.warn(`job ${job.kind} "${job.title}" failed: ${e.message}`)
        this.finish(job.id, { status: 'failed', error: e.message, agent: this.liveAgent.get(job.id) ?? null })
      }
    } finally {
      this.running = null
      this.moved.delete(job.id)
      this.passedOver.delete(job.id)
      if (this.modelsOf) this.lastModel = this.modelsOf(job).last ?? this.lastModel
    }
  }

  private cleanupRun(id: string) {
    this.progress.delete(id)
    this.partial.delete(id)
    this.liveAgent.delete(id)
  }

  private finish(id: string, f: { status: JobStatus; result?: Record<string, unknown> | null; error?: string; agent?: string | null }) {
    this.store.db
      .prepare('UPDATE jobs SET status = ?, finished_at = ?, result = ?, error = ?, agent = COALESCE(?, agent), dedupe_key = NULL, retry_at = NULL WHERE id = ?')
      .run(f.status, Date.now(), f.result ? JSON.stringify(f.result) : null, f.error ?? null, f.agent ?? null, id)
    this.closures.delete(id)
    this.cleanupRun(id)
    this.changed()
    const job = this.get(id)!
    try {
      this.onFinish?.(job)
    } catch (err) {
      log.warn(`after job ${id}: ${(err as Error).message}`)
    }
    for (const w of this.settle.get(id) ?? []) w.resolve(job)
    this.settle.delete(id)
    this.prune()
  }

  private prune() {
    const old = this.store.db
      .prepare("SELECT id FROM jobs WHERE status IN ('done', 'failed', 'cancelled') ORDER BY COALESCE(finished_at, created_at) DESC LIMIT -1 OFFSET ?")
      .all(KEEP_FINISHED) as { id: string }[]
    for (const { id } of old) {
      this.store.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
      this.dropFiles(id)
    }
  }

  private dropFiles(id: string) {
    fs.rmSync(this.filePath(id), { force: true })
  }

  private changed() {
    this.version++
    const w = this.waiters
    this.waiters = []
    w.forEach((f) => f())
  }

  private rows(where: string): Row[] {
    return this.store.db.prepare(`SELECT * FROM jobs WHERE ${where}`).all() as Row[]
  }

  private toJob(r: Row): Job {
    const parse = (s: string | null) => {
      if (!s) return null
      try {
        return JSON.parse(s)
      } catch {
        return null
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      noteId: r.note_id,
      status: r.status,
      origin: r.origin,
      device: r.device,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      input: parse(r.input) ?? {},
      result: parse(r.result),
      error: r.error,
      agent: r.status === 'running' ? (this.liveAgent.get(r.id) ?? r.agent) : r.agent,
      progress: r.status === 'running' ? (this.progress.get(r.id) ?? null) : null,
      partial: r.status === 'running' ? (this.partial.get(r.id) ?? null) : null,
      prompt: r.prompt,
      parentId: r.parent_id,
      replacedBy: r.replaced_by,
      redoable: this.handlers.has(r.kind),
      retryAt: r.status === 'queued' ? (r.retry_at ?? null) : null,
      attempts: r.attempts ?? 0,
    }
  }
}
