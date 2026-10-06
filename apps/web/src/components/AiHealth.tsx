import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, Circle, Cpu, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { aiHealth, samplesApi, type AiHealth, type BenchResult, type Sample } from '../lib/agents'
import { isFinished, submitJob, useJobs } from '../lib/jobs'
import { isSyncConfigured } from '../lib/settings'
import { showToast } from '../lib/toast'

/** The server's AI health, checked now and every `everyMs` while shown. */
function useHealth(everyMs: number) {
  const [h, setH] = useState<AiHealth | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const check = (fresh = false) =>
    aiHealth(fresh)
      .then((r) => (setH(r), setErr(null)))
      .catch((e) => setErr((e as Error).message))
  useEffect(() => {
    if (!isSyncConfigured()) return
    void check()
    const t = setInterval(() => document.visibilityState === 'visible' && void check(), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return { h, err, check }
}

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`)
/** "unloads in 23 min" from Ollama's expiry time */
function unloadsIn(until: string | null): string {
  if (!until) return ''
  const ms = Date.parse(until) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0 || ms > 7 * 864e5) return ''
  const min = Math.round(ms / 60_000)
  return min < 1 ? 'unloads now' : min < 60 ? `unloads in ${min} min` : `unloads in ${Math.round(min / 60)} h`
}

/**
 * Top of Jobs: which AI models are in memory now (so you can see what's ready
 * and what a job will have to load first) – or a warning when the AI can't be reached.
 * `trigger` changes when a job starts or finishes: check again then.
 */
export function AiHealthLine({ trigger }: { trigger?: string }) {
  const { h, check } = useHealth(15_000)
  useEffect(() => {
    if (trigger === undefined) return
    // loading a model takes a moment
    const t = setTimeout(() => void check(true), 2000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])
  if (!h || h.status === 'none') return null
  const loaded = h.ollama.flatMap((o) => o.loaded)
  return (
    <>
      {h.status !== 'ok' && (
        <div className={`ai-health-line ${h.status}`}>
          <CircleAlert size={14} /> {h.summary}
        </div>
      )}
      {h.ollama.some((o) => o.ok) && (
        <div className="ai-loaded-line" title="Models in your Ollama server’s memory. A job using another model loads it first, which takes longer.">
          <Cpu size={14} />
          {loaded.length ? (
            <span>
              In memory:{' '}
              {loaded.map((m, i) => (
                <span key={m.name} className="ai-model">
                  {i > 0 && ', '}
                  <b>{m.name.replace(/:latest$/, '')}</b>{' '}
                  {m.vramMb < m.sizeMb * 0.95 ? (
                    <span className="ai-health-err">
                      {gb(m.vramMb)} of {gb(m.sizeMb)} on the GPU – {m.vramMb < m.sizeMb / 2 ? 'mostly' : 'partly'} on the CPU, slow
                    </span>
                  ) : (
                    gb(m.sizeMb)
                  )}
                  {unloadsIn(m.until) && <span className="muted"> · {unloadsIn(m.until)}</span>}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">No model in memory – the next job loads one first</span>
          )}
        </div>
      )}
    </>
  )
}

/** Settings › AI: is each agent reachable, what's loaded in memory, what Claude has cost. */
export function AiHealthBox() {
  const { h, err, check } = useHealth(20_000)
  const [busy, setBusy] = useState(false)
  if (err) return <p className="hint">Couldn’t check the AI: {err}</p>
  if (!h || h.status === 'none') return null
  return (
    <div className={`ai-health ${h.status}`}>
      <div className="ai-health-head">
        {h.status === 'ok' ? <CheckCircle2 size={16} className="dot-ok" /> : <CircleAlert size={16} className="dot-bad" />}
        <span>{h.summary}</span>
        <button
          className="icon"
          aria-label="Check again"
          title="Check again"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void check(true).finally(() => setBusy(false))
          }}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      <ul>
        {h.agents
          .filter((a) => a.enabled)
          .map((a) => (
            <li key={a.id}>
              {a.ok === true ? <CheckCircle2 size={14} className="dot-ok" /> : a.ok === false ? <CircleAlert size={14} className="dot-bad" /> : <Circle size={14} className="dot-unknown" />}
              <span>
                {a.name}
                {a.model && <span className="muted"> · {a.model}</span>}
                {a.loaded && <span className="ai-loaded"> loaded</span>}
                {a.spentUsd !== undefined && <span className="muted"> · ${a.spentUsd.toFixed(2)} this month</span>}
                {a.error && <span className="ai-health-err"> – {a.error}</span>}
              </span>
            </li>
          ))}
      </ul>
      {h.ollama.map(
        (o) =>
          o.ok && (
            <p key={o.url} className="hint">
              Ollama {o.version ?? ''} at {o.url}:{' '}
              {o.loaded.length
                ? o.loaded.map((m) => (m.vramMb < m.sizeMb * 0.95 ? `${m.name} (only ${gb(m.vramMb)} of ${gb(m.sizeMb)} on the GPU – the rest on the CPU, slow)` : `${m.name} (${gb(m.sizeMb)} on the GPU)`)).join(', ')
                : 'nothing loaded right now (the first job loads a model, which takes a little longer)'}
            </p>
          ),
      )}
      {h.queue.waitingToRetry > 0 && (
        <p className="hint">
          {h.queue.waitingToRetry} job{h.queue.waitingToRetry === 1 ? ' is' : 's are'} waiting to try again (see Jobs).
        </p>
      )}
    </div>
  )
}

/** Settings › AI: compare models on samples of your own handwriting. */
export function TestBenchSection() {
  const [samples, setSamples] = useState<Sample[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [truth, setTruth] = useState('')
  const jobs = useJobs((s) => s.jobs)
  const latest = jobs.filter((j) => j.kind === 'benchmark').sort((a, b) => b.createdAt - a.createdAt)[0]
  const running = latest && !isFinished(latest)
  useEffect(() => {
    void samplesApi
      .list()
      .then((r) => setSamples(r.samples))
      .catch(() => {})
  }, [])
  if (!samples) return null
  const results = (latest?.status === 'done' ? latest.result?.results : null) as BenchResult[] | null
  return (
    <div className="bench">
      <h3>Test models on your handwriting</h3>
      <p className="hint">
        In Jobs, open a “Handwriting to text” or “Picture to text” job, fix its text in the note, then choose “Save as test sample”. Testing has each agent that reads images read every sample, and
        shows which gets your handwriting right most often – and how fast.
      </p>
      {samples.length > 0 && (
        <ul className="bench-samples">
          {samples.map((s) => (
            <li key={s.id}>
              {editing === s.id ? (
                <div className="bench-edit">
                  <textarea rows={4} value={truth} onChange={(e) => setTruth(e.target.value)} />
                  <div className="row">
                    <button className="text" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      onClick={() =>
                        void samplesApi
                          .setTruth(s.id, truth)
                          .then((r) => (setSamples(r.samples), setEditing(null)))
                          .catch((e) => showToast((e as Error).message))
                      }
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button className="text bench-title" title="Edit the right text" onClick={() => (setEditing(s.id), setTruth(s.truth))}>
                    {s.title}
                  </button>
                  <button className="icon danger" aria-label={`Remove sample ${s.title}`} onClick={() => void samplesApi.remove(s.id).then((r) => setSamples(r.samples))}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button
          disabled={!samples.length || Boolean(running)}
          onClick={() =>
            void submitJob({ kind: 'benchmark', title: 'Test models on your handwriting' })
              .then(() => showToast('Testing – it runs in Jobs; results show here'))
              .catch((e) => showToast((e as Error).message))
          }
        >
          {running ? (
            <>
              <Loader2 size={14} className="spin" /> {latest.progress ?? 'Testing…'}
            </>
          ) : (
            `Run test${samples.length ? ` (${samples.length} sample${samples.length === 1 ? '' : 's'})` : ''}`
          )}
        </button>
      </div>
      {latest?.status === 'failed' && <p className="hint">❌ {latest.error}</p>}
      {results && results.length > 0 && <BenchTable results={results} />}
    </div>
  )
}

export function BenchTable({ results }: { results: BenchResult[] }) {
  return (
    <table className="bench-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Right</th>
          <th>Time each</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => (
          <tr key={r.agentId} title={r.samples.map((s) => `${s.title}: ${s.error ? `failed – ${s.error}` : `${s.accuracy}%`}`).join('\n')}>
            <td>
              {i === 0 && r.accuracy > 0 ? '🏆 ' : ''}
              {r.name}
              <span className="muted"> · {r.model}</span>
              {r.errors > 0 && <span className="ai-health-err"> ({r.errors} failed)</span>}
            </td>
            <td>{r.accuracy}%</td>
            <td>{r.avgSeconds}s</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
