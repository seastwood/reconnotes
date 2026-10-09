import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, CircleAlert, Circle, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import {
  ApiError,
  DEFAULT_URLS,
  KIND_LABELS,
  TASK_HELP,
  rereadAll,
  vocabApi,
  type Vocab,
  agentsApi,
  type Agent,
  type AgentInput,
  type AgentKind,
  type AgentsState,
  type AiTask,
  type ModelInfo,
  type ProbeResult,
  type ReadingMode,
} from '../lib/agents'
import { apiUrl, settings } from '../lib/settings'
import { AiHealthBox, TestBenchSection } from './AiHealth'

/**
 * Settings › AI agents: add Claude / Ollama / OpenAI-compatible endpoints,
 * enable or disable them, and choose per task which agent is tried first.
 * If an agent fails, the server automatically tries the next one in the list.
 */
export function AiAgentsSection() {
  const [state, setState] = useState<AgentsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [editing, setEditing] = useState<Agent | 'new' | null>(null)

  const refresh = () =>
    agentsApi
      .list()
      .then((s) => {
        setState(s)
        setError(null)
        setLoadError(null)
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e : new ApiError((e as Error).message, 0)))

  useEffect(() => {
    void refresh()
  }, [])

  const apply = async (p: Promise<AgentsState>) => {
    try {
      setState(await p)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Check a just-saved agent so its status dot is accurate. */
  const retest = async (id: string) => {
    await agentsApi.probe({ id }).catch(() => undefined)
    await refresh()
  }

  if (!state) {
    if (!loadError)
      return (
        <p className="hint">
          <Loader2 size={14} className="spin" /> Loading AI agents from your server…
        </p>
      )
    return <LoadProblem error={loadError} onRetry={() => void refresh()} />
  }

  const byId = new Map(state.agents.map((a) => [a.id, a]))

  const moveInTask = (task: AiTask, id: string, delta: number) => {
    const list = [...state.settings.routing[task]]
    const i = list.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    void apply(agentsApi.updateSettings({ routing: { ...state.settings.routing, [task]: list } }))
  }
  const setTask = (task: AiTask, list: string[]) =>
    void apply(agentsApi.updateSettings({ routing: { ...state.settings.routing, [task]: list } }))

  return (
    <div className="ai-agents">
      {error && <p className="status error-text">{error}</p>}
      {state.agents.length > 0 && <AiHealthBox />}

      <div className="agent-list">
        {state.agents.map((a) =>
          editing !== 'new' && editing?.id === a.id ? (
            <AgentForm
              key={a.id}
              agent={a}
              onCancel={() => setEditing(null)}
              onSaved={(s) => {
                setState(s)
                setEditing(null)
                void retest(a.id)
              }}
            />
          ) : (
            <div key={a.id} className={`agent-card${a.enabled ? '' : ' off'}`}>
              <StatusDot agent={a} />
              <div className="agent-main">
                <div className="agent-name">
                  {a.name} <span className="agent-kind">{a.kind === 'anthropic' ? 'Claude' : a.kind === 'ollama' ? 'Ollama' : a.kind === 'wyoming' ? 'Wyoming' : 'OpenAI-compatible'}</span>
                </div>
                <div className="agent-sub">
                  {a.model || 'no model chosen'}
                  {a.kind !== 'anthropic' && <> · {a.baseUrl}</>}
                  {!a.vision && a.kind !== 'wyoming' && <> · text only</>}
                  {a.kind === 'wyoming' && <> · speech to text</>}
                </div>
                {a.status.lastError && (a.status.lastErrorAt ?? 0) >= (a.status.lastOkAt ?? 0) && (
                  <div className="agent-error">{a.status.lastError}</div>
                )}
              </div>
              <label className="switch" title={a.enabled ? 'Enabled' : 'Disabled'}>
                <input type="checkbox" checked={a.enabled} onChange={(e) => void apply(agentsApi.update(a.id, { enabled: e.target.checked }))} />
                <span />
              </label>
              <button className="icon" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
                <Pencil size={16} />
              </button>
              <button
                className="icon danger"
                onClick={() => confirm(`Remove the agent "${a.name}"?`) && void apply(agentsApi.remove(a.id))}
                aria-label={`Remove ${a.name}`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ),
        )}
        {editing === 'new' ? (
          <AgentForm
            onCancel={() => setEditing(null)}
            onSaved={(s, id) => {
              setState(s)
              setEditing(null)
              void retest(id)
            }}
          />
        ) : (
          <button className="add-agent" onClick={() => setEditing('new')}>
            <Plus size={16} /> Add AI agent
          </button>
        )}
        {!state.agents.length && editing !== 'new' && (
          <p className="hint">No AI agents yet. Add your Ollama server, a Claude API key, or any OpenAI-compatible server.</p>
        )}
      </div>

      {state.agents.length > 0 && (
        <>
          <h3>Which agent does what</h3>
          <p className="hint">Agents are tried from the top. If one fails or is unreachable, the next one takes over.</p>
          {state.tasks.map((t) => {
            const list = state.settings.routing[t.id]
            const unused = state.agents.filter((a) => !list.includes(a.id))
            return (
              <div key={t.id} className="task-route">
                <div className="task-head">
                  <strong>{t.label}</strong>
                  <span className="hint">{TASK_HELP[t.id]}</span>
                </div>
                <ol className="route-list">
                  {list.map((id, i) => {
                    const a = byId.get(id)
                    if (!a) return null
                    return (
                      <li key={id} className={a.enabled ? '' : 'off'}>
                        <span className="rank">{i + 1}</span>
                        <span className="route-name">
                          {a.name}
                          {!a.enabled && ' (disabled)'}
                          {!a.vision && (t.id === 'handwriting' || t.id === 'images') && <em> – can't read images</em>}
                          {t.id === 'audio' && a.kind !== 'openai' && a.kind !== 'wyoming' && <em> – can't transcribe audio</em>}
                          {t.id !== 'audio' && a.kind === 'wyoming' && <em> – only transcribes audio</em>}
                        </span>
                        <button className="icon" disabled={i === 0} onClick={() => moveInTask(t.id, id, -1)} aria-label="Move up">
                          <ArrowUp size={15} />
                        </button>
                        <button className="icon" disabled={i === list.length - 1} onClick={() => moveInTask(t.id, id, 1)} aria-label="Move down">
                          <ArrowDown size={15} />
                        </button>
                        <button className="icon" onClick={() => setTask(t.id, list.filter((x) => x !== id))} aria-label="Don't use for this">
                          <X size={15} />
                        </button>
                      </li>
                    )
                  })}
                  {!list.length && <li className="none">Off – no agent assigned</li>}
                </ol>
                {unused.length > 0 && (
                  <select
                    className="route-add"
                    value=""
                    onChange={(e) => e.target.value && setTask(t.id, [...list, e.target.value])}
                    aria-label={`Add an agent for ${t.label}`}
                  >
                    <option value="">+ Add an agent…</option>
                    {unused.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )
          })}

          <h3>Automatic</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={state.settings.autoHandwriting}
              onChange={(e) => void apply(agentsApi.updateSettings({ autoHandwriting: e.target.checked }))}
            />
            Recognise handwriting automatically so it's searchable (runs after you stop writing)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={state.settings.autoImageText}
              onChange={(e) => void apply(agentsApi.updateSettings({ autoImageText: e.target.checked }))}
            />
            Extract text from new images and PDFs for search
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={state.settings.autoAudio}
              onChange={(e) => void apply(agentsApi.updateSettings({ autoAudio: e.target.checked }))}
            />
            Transcribe new recordings and audio files for search (needs an “Audio to text” agent)
          </label>
          <RereadButton />
          <VocabularySection />
          <TestBenchSection />
        </>
      )}
    </div>
  )
}

function StatusDot({ agent }: { agent: Agent }) {
  const { lastOkAt, lastError, lastErrorAt } = agent.status
  if (lastError && (lastErrorAt ?? 0) >= (lastOkAt ?? 0)) return <CircleAlert size={18} className="dot-bad" aria-label="Last attempt failed" />
  if (lastOkAt) return <CheckCircle2 size={18} className="dot-ok" aria-label="Working" />
  return <Circle size={18} className="dot-unknown" aria-label="Not tested yet" />
}

function AgentForm({ agent, onCancel, onSaved }: { agent?: Agent; onCancel: () => void; onSaved: (s: AgentsState, id: string) => void }) {
  const [form, setForm] = useState<AgentInput>(() =>
    agent
      ? { ...agent }
      : {
          kind: 'ollama',
          name: '',
          baseUrl: DEFAULT_URLS.ollama,
          model: '',
          vision: true,
          timeoutSec: 300,
          prompt: '',
          effort: 'medium',
          enabled: true,
          reading: 'auto',
        },
  )
  const [apiKey, setApiKey] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | 'try' | null>(null)
  const [trial, setTrial] = useState<{ ok: boolean; text: string; message: string; seconds: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(Boolean(agent?.prompt))
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [typing, setTyping] = useState(false)

  const set = (patch: AgentInput) => setForm((f) => ({ ...f, ...patch }))
  const kind = form.kind as AgentKind
  const payload = (): AgentInput => ({ ...form, ...(apiKey ? { apiKey } : {}), id: agent?.id })

  const changeKind = (k: AgentKind) =>
    set({
      kind: k,
      baseUrl: DEFAULT_URLS[k],
      model: k === 'anthropic' ? 'claude-opus-5-5' : '',
      name: form.name,
      // a speech-to-text server doesn't read images
      vision: k !== 'wyoming',
    })

  const canList = kind === 'anthropic' ? Boolean(apiKey || agent?.hasApiKey) : Boolean(form.baseUrl)
  const loadModels = async () => {
    if (!canList) {
      setModels(null)
      return
    }
    setLoadingModels(true)
    try {
      const r = await agentsApi.models(payload())
      setModels(r.models)
      setModelsError(r.error)
      // a Wyoming Whisper server usually has exactly one model: use it
      if (kind === 'wyoming' && r.models.length === 1 && !form.model) set({ model: r.models[0].id })
    } catch (e) {
      setModels(null)
      setModelsError((e as Error).message)
    } finally {
      setLoadingModels(false)
    }
  }
  // Fetch the model list when the form opens and whenever the address/key changes.
  useEffect(() => {
    const t = setTimeout(() => void loadModels(), 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, form.baseUrl, apiKey])

  const test = async () => {
    setBusy('test')
    setError(null)
    setProbe(null)
    try {
      setProbe(await agentsApi.probe(payload()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const tryHandwriting = async () => {
    setBusy('try')
    setError(null)
    setTrial(null)
    try {
      setTrial(await agentsApi.tryHandwriting(payload()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const body = { ...payload(), name: form.name?.trim() || defaultName(kind, form.model ?? '') }
      const { id: _id, ...rest } = body
      const r = agent ? await agentsApi.update(agent.id, rest) : await agentsApi.create(rest)
      onSaved(r, r.agent.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const needsKey = kind === 'anthropic'

  return (
    <div className="agent-form">
      <label>
        Type
        <select value={kind} onChange={(e) => changeKind(e.target.value as AgentKind)}>
          {(Object.keys(KIND_LABELS) as AgentKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input value={form.name ?? ''} placeholder={defaultName(kind, form.model ?? '')} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {kind !== 'anthropic' && (
        <label>
          Address
          <input
            value={form.baseUrl ?? ''}
            onChange={(e) => set({ baseUrl: e.target.value.trim() })}
            placeholder={kind === 'ollama' ? 'http://192.168.1.50:11434' : kind === 'wyoming' ? 'tcp://192.168.1.50:10300' : DEFAULT_URLS[kind]}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <span className="hint">
            {kind === 'ollama'
              ? 'The Ollama machine, e.g. http://192.168.1.50:11434. Use the IP address if the name doesn’t work.'
              : kind === 'wyoming'
                ? 'The Wyoming Whisper server, e.g. tcp://192.168.1.50:10300 (10300 is the usual port). The ReconNotes server needs ffmpeg to send it recordings.'
                : 'Usually ends in /v1, e.g. http://192.168.1.50:1234/v1 or https://openrouter.ai/api/v1'}
          </span>
        </label>
      )}
      {(needsKey || kind === 'openai') && (
        <label>
          API key{kind === 'openai' && ' (if the server needs one)'}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value.trim())}
            placeholder={agent?.hasApiKey ? `Saved (${agent.apiKeyHint}) – leave blank to keep` : needsKey ? 'sk-ant-…' : 'optional'}
            autoComplete="off"
          />
        </label>
      )}
      <label>
        Model
        <div className="row model-row">
          {models && models.length > 0 && !typing ? (
            <select
              value={form.model && models.some((m) => m.id === form.model) ? form.model : form.model ? '__missing' : ''}
              onChange={(e) => {
                const v = e.target.value
                if (v === '__type') return setTyping(true)
                const m = models.find((x) => x.id === v)
                if (m) set({ model: m.id, ...(m.vision !== null ? { vision: m.vision } : {}) })
              }}
            >
              {!form.model && <option value="">{kind === 'wyoming' ? 'The server’s model' : 'Choose a model…'}</option>}
              {form.model && !models.some((m) => m.id === form.model) && (
                <option value="__missing">{form.model} (not found on the server)</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.detail ? ` — ${m.detail}` : ''}
                  {m.vision === true ? ' · reads images' : m.vision === false ? ' · text only' : ''}
                </option>
              ))}
              <option value="__type">Type a model name…</option>
            </select>
          ) : (
            <input
              value={form.model ?? ''}
              onChange={(e) => set({ model: e.target.value.trim() })}
              placeholder={kind === 'ollama' ? 'e.g. qwen3-vl:4b' : kind === 'anthropic' ? 'claude-opus-5-5' : kind === 'wyoming' ? 'optional – the server’s own model is used' : 'model id'}
              autoCapitalize="off"
              autoCorrect="off"
            />
          )}
          <button type="button" className="icon" onClick={() => void loadModels()} aria-label="Refresh the model list" title="Refresh the model list">
            {loadingModels ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
        <span className="hint">
          {loadingModels
            ? 'Looking for models…'
            : modelsError
              ? `Couldn’t list models: ${modelsError}`
              : models
                ? models.length
                  ? `${models.length} model${models.length === 1 ? '' : 's'} on this server.${typing ? ' ' : ''}`
                  : kind === 'ollama'
                    ? 'No models installed yet. On the Ollama machine run e.g. “ollama pull qwen3-vl:4b”, then refresh.'
                    : 'The server lists no models.'
                : kind === 'anthropic'
                  ? 'Enter your API key to see the available models.'
                  : 'Enter the address to see the available models.'}
          {typing && models && models.length > 0 && (
            <button type="button" className="link" onClick={() => setTyping(false)}>
              {' '}
              Pick from the list instead
            </button>
          )}
        </span>
      </label>
      {kind !== 'wyoming' && (
        <label className="check">
          <input type="checkbox" checked={form.vision ?? true} onChange={(e) => set({ vision: e.target.checked })} />
          Reads images (needed for handwriting and image text)
        </label>
      )}
      {kind !== 'wyoming' && (form.vision ?? true) && (
        <label>
          Reading style for drawings
          <select value={form.reading ?? 'auto'} onChange={(e) => set({ reading: e.target.value as ReadingMode })}>
            <option value="auto">Automatic ({/ocr/i.test(form.model ?? '') ? 'line by line for this OCR model' : 'whole page'})</option>
            <option value="lines">Line by line – best for OCR models</option>
            <option value="page">Whole page at once – best for general vision models</option>
          </select>
          <span className="hint">
            Whole page suits general vision models (qwen2.5vl, llava, Claude): they see the context that joins wrapped lines. Line by line
            finds each written line from your pen strokes and reads them one at a time – for OCR-only models (GLM-OCR, DeepSeek-OCR) that
            break apart on a whole page.
          </span>
        </label>
      )}
      {kind === 'ollama' && (
        <label className="check">
          <input type="checkbox" checked={Boolean(form.think)} onChange={(e) => set({ think: e.target.checked })} /> Let it think before answering
          <span className="hint">
            For thinking models (qwen3, deepseek-r1…): it reasons first, so it answers questions about rules and manuals more carefully – but
            each answer takes longer. Best on an agent you use only for “Ask your notes”.
          </span>
        </label>
      )}
      {kind === 'anthropic' && (
        <label>
          Thinking effort
          <select value={form.effort} onChange={(e) => set({ effort: e.target.value as 'low' | 'medium' | 'high' })}>
            <option value="low">Low – fastest, cheapest</option>
            <option value="medium">Medium</option>
            <option value="high">High – most careful</option>
          </select>
        </label>
      )}
      {kind === 'anthropic' && (
        <label>
          Monthly spending limit (US$)
          <input
            type="number"
            min={0}
            step={1}
            value={form.monthlyLimitUsd ?? 0}
            onChange={(e) => set({ monthlyLimitUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="hint">
            {agent?.spentThisMonthUsd !== undefined ? `Spent this month: about $${agent.spentThisMonthUsd.toFixed(2)}. ` : ''}
            Once it reaches the limit, Claude isn’t used until next month and the next agent in each list takes over – put Claude last to use it only
            when your own models fail. 0 = no limit.
          </span>
        </label>
      )}
      <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
        {advanced ? 'Hide advanced' : 'Advanced…'}
      </button>
      {advanced && (
        <>
          <label>
            Timeout (seconds)
            <input
              type="number"
              min={5}
              max={1800}
              value={form.timeoutSec ?? 300}
              onChange={(e) => set({ timeoutSec: Number(e.target.value) })}
            />
            <span className="hint">Large local models can take a while to load the first time.</span>
          </label>
          {kind !== 'wyoming' && (
          <label>
            Handwriting prompt (optional)
            <textarea
              rows={3}
              value={form.prompt ?? ''}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="Leave empty for the built-in prompt. OCR models often work better with something short, like: Transcribe the handwritten text in this image."
            />
          </label>
          )}
          {kind === 'anthropic' && (
            <label>
              API address
              <input value={form.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value.trim() })} />
            </label>
          )}
        </>
      )}

      {probe && (
        <div className={`probe ${probe.ok ? 'ok' : 'bad'}`}>
          {probe.ok ? '✅ ' : '❌ '}
          {probe.message}
          {probe.warnings.map((w) => (
            <div key={w} className="probe-warn">
              ⚠️ {w}
            </div>
          ))}
        </div>
      )}
      {trial && (
        <div className={`probe ${trial.ok ? 'ok' : 'bad'}`}>
          {trial.ok ? '✅ ' : '❌ '}
          {trial.message} {trial.seconds ? `(${trial.seconds}s)` : ''}
          {trial.text && (
            <div className="probe-warn">
              It answered: <q>{trial.text.length > 200 ? trial.text.slice(0, 200) + '…' : trial.text}</q>
            </div>
          )}
          <div className="probe-warn">
            <a href={apiUrl('/api/ai/sample-handwriting.png?token=' + encodeURIComponent(settings.get().token))} target="_blank" rel="noreferrer">
              See the sample image
            </a>
          </div>
        </div>
      )}
      {error && <p className="status error-text">{error}</p>}
      <div className="row">
        <button onClick={test} disabled={busy !== null}>
          {busy === 'test' ? <Loader2 size={14} className="spin" /> : null} Test connection
        </button>
        {kind !== 'wyoming' && (form.vision ?? true) && (
          <button onClick={tryHandwriting} disabled={busy !== null || !form.model} title="Send a sample handwritten word and see what comes back">
            {busy === 'try' ? <Loader2 size={14} className="spin" /> : null} Test reading handwriting
          </button>
        )}
        <button className="primary" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? <Loader2 size={14} className="spin" /> : null} {agent ? 'Save' : 'Add agent'}
        </button>
        <button onClick={onCancel} disabled={busy !== null}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function defaultName(kind: AgentKind, model: string) {
  const short = model.split('/').pop()?.split(':')[0]
  if (kind === 'anthropic') return 'Claude'
  if (kind === 'ollama') return short ? `Ollama · ${short}` : 'Ollama'
  if (kind === 'wyoming') return 'Whisper (Wyoming)'
  return short || 'OpenAI-compatible'
}

/** Explain why agents can't be shown, and how to fix it. */
function LoadProblem({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  let title: string
  let body: React.ReactNode
  if (error.status === 404) {
    title = 'Your server needs updating'
    body = (
      <>
        The app is newer than the server it's connected to, which doesn't support AI agents yet. On the server, run:
        <pre>cd /opt/reconnotes && git pull && npm ci && npm run build && systemctl restart reconnotes</pre>
        Then press Retry.
      </>
    )
  } else if (error.status === 401) {
    title = 'The server rejected your access token'
    body = <>Check the access token above (it's RECON_TOKEN in /etc/reconnotes.env on the server), then press Save &amp; connect.</>
  } else if (error.status === 0) {
    title = "Can't reach your server"
    body = <>{error.message} Check the server address above and that the server is running, then press Retry.</>
  } else {
    title = "Couldn't load AI agents"
    body = <>{error.message}</>
  }
  return (
    <div className="setup-problem" role="alert">
      <strong>{title}</strong>
      <div>{body}</div>
      <button onClick={onRetry}>Retry</button>
    </div>
  )
}

/** Read all handwriting and pictures again for search, e.g. after switching to a better model. */
function RereadButton() {
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <div className="reread">
      <button
        onClick={() =>
          void rereadAll()
            .then((r) => setMsg(`Queued ${r.drawings} handwriting section${r.drawings === 1 ? '' : 's'} and ${r.pictures} picture${r.pictures === 1 ? '' : 's'} – they run in the background (see Jobs › Show background work).`))
            .catch((e) => setMsg(`❌ ${(e as Error).message}`))
        }
      >
        Re-read all handwriting and pictures for search
      </button>
      <p className="hint">{msg ?? 'After switching to a better model: searchable text is refreshed with the current agents. Your notes aren’t changed.'}</p>
    </div>
  )
}

/** Names and terms in your notes, so the AI spells them right – plus the corrections it learned from you. */
function VocabularySection() {
  const [v, setV] = useState<Vocab | null>(null)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    void vocabApi.get().then((r) => {
      setV(r)
      setText(r.words.join(', '))
    }).catch(() => {})
  }, [])
  if (!v) return null
  const save = () =>
    void vocabApi.setWords(text.split(/[,\n]/)).then((r) => {
      setV(r)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    })
  return (
    <div className="vocab">
      <h3>Your words</h3>
      <p className="hint">Names and terms that come up in your notes. Every handwriting reading and clean-up is told to spell them like this.</p>
      <textarea rows={3} value={text} placeholder="e.g. Klai, Doug, Sophie, Lieutenant, GitHub" onChange={(e) => setText(e.target.value)} onBlur={save} />
      <div className="row">
        <button onClick={save}>{saved ? 'Saved' : 'Save'}</button>
      </div>
      {v.learned.length > 0 && (
        <>
          <p className="hint">Learned from your corrections – the AI is told about these too:</p>
          <ul className="learned">
            {v.learned.map((l) => (
              <li key={l.from + l.to}>
                <span>
                  <s>{l.from}</s> → <b>{l.to}</b>
                  {l.count > 1 ? ` (${l.count}×)` : ''}
                </span>
                <button className="icon" aria-label="Forget this correction" title="Forget" onClick={() => void vocabApi.forget(l.from, l.to).then(setV)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
