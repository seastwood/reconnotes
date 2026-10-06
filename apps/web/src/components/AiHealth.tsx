import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, Circle, Loader2, RefreshCw, Trash2 } from 'lucide-react'
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

/** One line at the top of Jobs: is the AI reachable? (Only shown when something's wrong.) */
export function AiHealthLine() {
  const { h } = useHealth(30_000)
  if (!h || h.status === 'ok' || h.status === 'none') return null
  return (
    <div className={`ai-health-line ${h.status}`}>
      <CircleAlert size={14} /> {h.summary}
    </div>
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
                ? o.loaded.map((m) => `${m.name} (${m.vramMb >= 1024 ? `${(m.vramMb / 1024).toFixed(1)} GB` : `${m.vramMb} MB`} on the GPU${m.vramMb < m.sizeMb * 0.95 ? ', partly on the CPU – slower' : ''})`).join(', ')
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
