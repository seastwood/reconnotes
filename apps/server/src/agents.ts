import Anthropic from '@anthropic-ai/sdk'
import { newId } from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import { log } from './log'

/**
 * AI agents
 * =========
 *
 * An agent is one configured model endpoint: Claude, a model served by Ollama,
 * or anything that speaks the OpenAI chat-completions API (LM Studio, vLLM,
 * llama.cpp server, OpenRouter, OpenAI…). Agents are managed from the app's
 * settings and stored in the server database; API keys never leave the server.
 *
 * Each AI task has its own priority list of agents. A request tries the first
 * enabled agent in the list and fails over to the next one on any error
 * (unreachable, timeout, bad model name, refusal, …).
 */

export type AgentKind = 'anthropic' | 'ollama' | 'openai'
export type AiTask = 'handwriting' | 'images' | 'pdf' | 'compile'
export const AI_TASKS: AiTask[] = ['handwriting', 'images', 'pdf', 'compile']

export interface AgentConfig {
  id: string
  name: string
  kind: AgentKind
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
  /** can the model read images? (non-vision agents get pre-transcribed text for "compile") */
  vision: boolean
  timeoutSec: number
  /** optional replacement for the built-in handwriting prompt (OCR models often prefer a short one) */
  prompt: string
  /** Claude only: reasoning effort */
  effort: 'low' | 'medium' | 'high'
}

export interface AgentStatus {
  lastOkAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

/** What the app sees: never the API key itself. */
export type AgentView = Omit<AgentConfig, 'apiKey'> & { hasApiKey: boolean; apiKeyHint: string; status: AgentStatus }

export interface AiSettings {
  routing: Record<AiTask, string[]>
  autoHandwriting: boolean
  autoImageText: boolean
}

export type Part = { text: string } | { image: Buffer; mime: string } | { pdf: Buffer }

export interface Backend {
  generate(parts: Part[], maxTokens: number): Promise<string>
}

export const DEFAULT_URLS: Record<AgentKind, string> = {
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
  openai: 'http://localhost:1234/v1',
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/** Models that accept adaptive thinking + effort, and the server-side refusal fallback. */
const ADAPTIVE = /^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|5)/
const FALLBACK_OK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/

class AnthropicBackend implements Backend {
  private client: Anthropic
  constructor(private agent: AgentConfig) {
    this.client = new Anthropic({
      apiKey: agent.apiKey,
      baseURL: agent.baseUrl && agent.baseUrl !== DEFAULT_URLS.anthropic ? agent.baseUrl : undefined,
      timeout: agent.timeoutSec * 1000,
      maxRetries: 1,
    })
  }

  async generate(parts: Part[], maxTokens: number): Promise<string> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = parts.map((p) => {
      if ('text' in p) return { type: 'text', text: p.text }
      if ('image' in p)
        return {
          type: 'image',
          source: { type: 'base64', media_type: p.mime as 'image/png', data: p.image.toString('base64') },
        }
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.pdf.toString('base64') } }
    })
    const model = this.agent.model
    const stream = this.client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
      ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: this.agent.effort } } : {}),
      ...(FALLBACK_OK.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    })
    const msg = await stream.finalMessage()
    if (msg.stop_reason === 'refusal') throw new Error('the model declined to process this content')
    return msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }
}

class OllamaBackend implements Backend {
  constructor(private agent: AgentConfig) {}

  async generate(parts: Part[], maxTokens: number): Promise<string> {
    if (parts.some((p) => 'pdf' in p)) throw new Error('Ollama models cannot read PDFs')
    const text = parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join('\n\n')
    const images = parts.filter((p): p is { image: Buffer; mime: string } => 'image' in p).map((p) => p.image.toString('base64'))
    const res = await fetchWithHints(trimSlash(this.agent.baseUrl) + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.agent.timeoutSec * 1000),
      body: JSON.stringify({
        model: this.agent.model,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0 },
        messages: [{ role: 'user', content: text, ...(images.length ? { images } : {}) }],
      }),
    })
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { message?: { content?: string } }
    return stripThinking(body.message?.content ?? '')
  }
}

class OpenAiBackend implements Backend {
  constructor(private agent: AgentConfig) {}

  async generate(parts: Part[], maxTokens: number): Promise<string> {
    if (parts.some((p) => 'pdf' in p)) throw new Error('PDF input is not supported for OpenAI-compatible agents')
    const content = parts.map((p) =>
      'text' in p
        ? { type: 'text', text: p.text }
        : { type: 'image_url', image_url: { url: `data:${(p as { mime: string }).mime};base64,${(p as { image: Buffer }).image.toString('base64')}` } },
    )
    const res = await fetchWithHints(trimSlash(this.agent.baseUrl) + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.agent.apiKey ? { Authorization: `Bearer ${this.agent.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.agent.timeoutSec * 1000),
      body: JSON.stringify({ model: this.agent.model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content }] }),
    })
    if (!res.ok) throw new Error(`server returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return stripThinking(body.choices?.[0]?.message?.content ?? '')
  }
}

export function makeBackend(agent: AgentConfig): Backend {
  switch (agent.kind) {
    case 'anthropic':
      return new AnthropicBackend(agent)
    case 'ollama':
      return new OllamaBackend(agent)
    case 'openai':
      return new OpenAiBackend(agent)
  }
}

/** Reasoning models may include <think>…</think> blocks; drop them. */
export function stripThinking(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .trim()
}

const trimSlash = (u: string) => u.replace(/\/+$/, '')

/** fetch() whose network errors explain what to check instead of just "fetch failed". */
async function fetchWithHints(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    throw new Error(explainNetworkError(url, err))
  }
}

export function explainNetworkError(url: string, err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  const code = e.cause?.code
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `timed out waiting for ${host}`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return `can't find the host "${host}" – the server can't resolve that name; try its IP address instead`
  if (code === 'ECONNREFUSED')
    return `connection refused by ${host} – is it running and listening on the network? (Ollama only listens on localhost unless OLLAMA_HOST=0.0.0.0 is set)`
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `can't reach ${host} – check the IP address and that both machines are on the same network`
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `connection to ${host} timed out – check the address and any firewall`
  if (code && /CERT|SSL|TLS/.test(code)) return `TLS/certificate problem talking to ${host} (${code})`
  return `could not connect to ${host}: ${e.cause?.message ?? e.message ?? String(err)}`
}

// ---------------------------------------------------------------------------
// Testing an agent from the settings screen
// ---------------------------------------------------------------------------

export interface ProbeResult {
  ok: boolean
  message: string
  models: string[]
  warnings: string[]
}

/** Check that an agent is reachable, authorised and has the chosen model. */
export async function probeAgent(agent: AgentConfig): Promise<ProbeResult> {
  const warnings: string[] = []
  const timeout = AbortSignal.timeout(Math.min(agent.timeoutSec, 20) * 1000)
  try {
    if (agent.kind === 'ollama') {
      const base = trimSlash(agent.baseUrl)
      const res = await fetchWithHints(base + '/api/tags', { signal: timeout })
      if (!res.ok) return { ok: false, message: `Ollama answered ${res.status} – is this an Ollama server?`, models: [], warnings }
      const body = (await res.json()) as { models?: { name: string }[] }
      const models = (body.models ?? []).map((m) => m.name)
      if (!agent.model) return { ok: true, message: `Connected. ${models.length} models installed – pick one.`, models, warnings }
      const want = agent.model.includes(':') ? agent.model : `${agent.model}:latest`
      if (!models.includes(agent.model) && !models.includes(want))
        return { ok: false, message: `Connected, but the model "${agent.model}" isn't installed. Run: ollama pull ${agent.model}`, models, warnings }
      try {
        const show = await fetch(base + '/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: agent.model }),
          signal: AbortSignal.timeout(10_000),
        })
        const info = (await show.json()) as { capabilities?: string[] }
        if (info.capabilities && !info.capabilities.includes('vision') && agent.vision)
          warnings.push(`Ollama reports that "${agent.model}" can't read images, so it won't work for handwriting or images. Turn off "Reads images" or pick a vision model.`)
      } catch {
        /* older Ollama: no capability info */
      }
      return { ok: true, message: `Connected to Ollama. Model "${agent.model}" is installed.`, models, warnings }
    }

    if (agent.kind === 'openai') {
      const res = await fetchWithHints(trimSlash(agent.baseUrl) + '/models', {
        signal: timeout,
        headers: agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {},
      })
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'The server rejected the API key.', models: [], warnings }
      if (!res.ok) return { ok: false, message: `The server answered ${res.status}. The base URL usually ends in /v1.`, models: [], warnings }
      const body = (await res.json()) as { data?: { id: string }[] }
      const models = (body.data ?? []).map((m) => m.id)
      if (agent.model && models.length && !models.includes(agent.model))
        return { ok: false, message: `Connected, but the server doesn't list a model called "${agent.model}".`, models, warnings }
      return { ok: true, message: agent.model ? `Connected. Model "${agent.model}" is available.` : `Connected. Pick a model.`, models, warnings }
    }

    // Claude
    if (!agent.apiKey) return { ok: false, message: 'Enter an Anthropic API key.', models: [], warnings }
    const client = new Anthropic({
      apiKey: agent.apiKey,
      baseURL: agent.baseUrl && agent.baseUrl !== DEFAULT_URLS.anthropic ? agent.baseUrl : undefined,
      timeout: 20_000,
      maxRetries: 0,
    })
    const models: string[] = []
    for await (const m of client.models.list({ limit: 100 })) models.push(m.id)
    if (agent.model && !models.includes(agent.model))
      return { ok: false, message: `The API key works, but "${agent.model}" isn't an available model.`, models, warnings }
    return { ok: true, message: `Connected to Claude. Model "${agent.model}" is available.`, models, warnings }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, message: 'Anthropic rejected the API key.', models: [], warnings }
    if (err instanceof Anthropic.APIConnectionError)
      return { ok: false, message: explainNetworkError(agent.baseUrl || DEFAULT_URLS.anthropic, err.cause ?? err), models: [], warnings }
    if (err instanceof Anthropic.APIError) return { ok: false, message: `Anthropic API error ${err.status}: ${err.message}`, models: [], warnings }
    return { ok: false, message: (err as Error).message, models: [], warnings }
  }
}

// ---------------------------------------------------------------------------
// Registry: storage, routing and failover
// ---------------------------------------------------------------------------

const AGENTS_KEY = 'ai.agents'
const SETTINGS_KEY = 'ai.settings'

export class AllAgentsFailedError extends Error {}
export class NoAgentError extends Error {
  constructor(task: AiTask) {
    super(`No AI agent is enabled for ${TASK_LABELS[task].toLowerCase()}. Add one in Settings › AI agents.`)
  }
}

export const TASK_LABELS: Record<AiTask, string> = {
  handwriting: 'Handwriting to text',
  images: 'Text from images',
  pdf: 'Text from PDFs',
  compile: 'Compile notes',
}

/** Tasks a new agent of this kind can do (where it is added by default). */
function defaultTasks(a: AgentConfig): AiTask[] {
  const t: AiTask[] = []
  if (a.vision) t.push('handwriting', 'images')
  if (a.kind === 'anthropic') t.push('pdf')
  t.push('compile')
  return t
}

export class AgentRegistry {
  private status = new Map<string, AgentStatus>()

  constructor(
    private store: Store,
    config: Config,
  ) {
    if (store.getSetting(AGENTS_KEY) === null) this.seedFromEnv(config)
  }

  agents(): AgentConfig[] {
    return (this.store.getSetting<AgentConfig[]>(AGENTS_KEY) ?? []).map(withDefaults)
  }

  settings(): AiSettings {
    const s = this.store.getSetting<Partial<AiSettings>>(SETTINGS_KEY) ?? {}
    const routing = { handwriting: [], images: [], pdf: [], compile: [], ...(s.routing ?? {}) } as Record<AiTask, string[]>
    return { routing, autoHandwriting: s.autoHandwriting ?? true, autoImageText: s.autoImageText ?? true }
  }

  get(id: string): AgentConfig | undefined {
    return this.agents().find((a) => a.id === id)
  }

  view(): AgentView[] {
    return this.agents().map((a) => toView(a, this.status.get(a.id)))
  }

  viewOf(id: string): AgentView | undefined {
    const a = this.get(id)
    return a && toView(a, this.status.get(a.id))
  }

  /** Create or update an agent. An undefined apiKey keeps the stored key. */
  save(input: Partial<AgentConfig> & { id?: string }): AgentConfig {
    const all = this.agents()
    const existing = input.id ? all.find((a) => a.id === input.id) : undefined
    const merged = validateAgent({ ...(existing ?? {}), ...stripUndefined(input), id: existing?.id ?? newId() })
    if (input.apiKey === undefined && existing) merged.apiKey = existing.apiKey
    const next = existing ? all.map((a) => (a.id === merged.id ? merged : a)) : [...all, merged]
    this.store.setSetting(AGENTS_KEY, next)
    if (!existing) {
      // New agents go to the end of the queue for the tasks they can do.
      const s = this.settings()
      for (const t of defaultTasks(merged)) s.routing[t] = [...s.routing[t], merged.id]
      this.store.setSetting(SETTINGS_KEY, s)
    }
    this.status.delete(merged.id)
    return merged
  }

  remove(id: string) {
    this.store.setSetting(AGENTS_KEY, this.agents().filter((a) => a.id !== id))
    const s = this.settings()
    for (const t of AI_TASKS) s.routing[t] = s.routing[t].filter((x) => x !== id)
    this.store.setSetting(SETTINGS_KEY, s)
    this.status.delete(id)
  }

  updateSettings(patch: Partial<AiSettings>) {
    const s = this.settings()
    const ids = new Set(this.agents().map((a) => a.id))
    if (patch.routing) {
      for (const t of AI_TASKS) {
        const list = patch.routing[t]
        if (Array.isArray(list)) s.routing[t] = [...new Set(list.filter((id) => typeof id === 'string' && ids.has(id)))]
      }
    }
    if (typeof patch.autoHandwriting === 'boolean') s.autoHandwriting = patch.autoHandwriting
    if (typeof patch.autoImageText === 'boolean') s.autoImageText = patch.autoImageText
    this.store.setSetting(SETTINGS_KEY, s)
    return s
  }

  /** Enabled agents for a task, in priority order. */
  chain(task: AiTask): AgentConfig[] {
    const byId = new Map(this.agents().map((a) => [a.id, a]))
    return this.settings()
      .routing[task].map((id) => byId.get(id))
      .filter((a): a is AgentConfig => Boolean(a?.enabled))
  }

  available(task: AiTask): boolean {
    return this.chain(task).length > 0
  }

  /**
   * Run a task with failover: try each agent in priority order until one
   * succeeds. Returns the result and the agent that produced it.
   */
  async run<T>(task: AiTask, fn: (backend: Backend, agent: AgentConfig) => Promise<T>): Promise<{ result: T; agent: AgentConfig }> {
    const chain = this.chain(task)
    if (!chain.length) throw new NoAgentError(task)
    const failures: string[] = []
    for (const agent of chain) {
      try {
        const result = await fn(makeBackend(agent), agent)
        this.status.set(agent.id, { ...this.statusOf(agent.id), lastOkAt: Date.now() })
        return { result, agent }
      } catch (err) {
        const msg = describeError(err)
        failures.push(`${agent.name}: ${msg}`)
        this.status.set(agent.id, { ...this.statusOf(agent.id), lastError: msg, lastErrorAt: Date.now() })
        log.warn(`AI agent "${agent.name}" failed for ${task}: ${msg}${chain.length > failures.length ? ' – trying the next agent' : ''}`)
      }
    }
    throw new AllAgentsFailedError(
      chain.length === 1 ? `${TASK_LABELS[task]} failed – ${failures[0]}` : `All AI agents failed for ${TASK_LABELS[task].toLowerCase()}: ${failures.join(' · ')}`,
    )
  }

  recordProbe(id: string, r: ProbeResult) {
    const s = this.statusOf(id)
    this.status.set(id, r.ok ? { ...s, lastOkAt: Date.now(), lastError: null } : { ...s, lastError: r.message, lastErrorAt: Date.now() })
  }

  private statusOf(id: string): AgentStatus {
    return this.status.get(id) ?? { lastOkAt: null, lastError: null, lastErrorAt: null }
  }

  describe(): string {
    return AI_TASKS.map((t) => `${t}=${this.chain(t).map((a) => a.name).join('>') || 'off'}`).join(' ')
  }

  /**
   * First start: turn the old environment-variable configuration (if any) into
   * agents, so existing setups keep working. After this the app is in charge.
   */
  private seedFromEnv(c: Config) {
    const agents: AgentConfig[] = []
    const claude = c.anthropicApiKey
      ? withDefaults({ id: newId(), name: 'Claude', kind: 'anthropic', apiKey: c.anthropicApiKey, model: c.aiModel, effort: effortOf(c.aiEffort) })
      : null
    const ollama = c.ollamaUrl
      ? withDefaults({ id: newId(), name: 'Ollama', kind: 'ollama', baseUrl: c.ollamaUrl, model: c.ollamaModel, prompt: c.ollamaHandwritingPrompt ?? '', timeoutSec: c.ollamaTimeoutMs / 1000 })
      : null
    const ollamaText =
      c.ollamaUrl && c.ollamaTextModel !== c.ollamaModel
        ? withDefaults({ id: newId(), name: 'Ollama (text)', kind: 'ollama', baseUrl: c.ollamaUrl, model: c.ollamaTextModel, vision: false, timeoutSec: c.ollamaTimeoutMs / 1000 })
        : null
    for (const a of [claude, ollama, ollamaText]) if (a) agents.push(a)
    const order = (preferred: string, candidates: (AgentConfig | null)[]) => {
      const list = candidates.filter((a): a is AgentConfig => Boolean(a))
      return [...list.filter((a) => a.kind === preferred), ...list.filter((a) => a.kind !== preferred)].map((a) => a.id)
    }
    const routing: Record<AiTask, string[]> = {
      handwriting: order(c.handwritingProvider, [claude, ollama]),
      images: order(c.imageProvider, [claude, ollama]),
      pdf: claude ? [claude.id] : [],
      compile: order(c.compileProvider, [claude, ollamaText ?? ollama]),
    }
    this.store.setSetting(AGENTS_KEY, agents)
    this.store.setSetting(SETTINGS_KEY, { routing, autoHandwriting: c.autoHandwriting || agents.length === 0, autoImageText: c.autoImageText || agents.length === 0 })
    if (agents.length) log.info(`imported ${agents.length} AI agent(s) from environment variables; manage them in Settings › AI agents`)
  }
}

function effortOf(e: string): AgentConfig['effort'] {
  return e === 'low' || e === 'high' ? e : 'medium'
}

function withDefaults(a: Partial<AgentConfig>): AgentConfig {
  const kind: AgentKind = a.kind === 'ollama' || a.kind === 'openai' ? a.kind : 'anthropic'
  return {
    id: a.id ?? newId(),
    name: a.name || (kind === 'anthropic' ? 'Claude' : kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible'),
    kind,
    baseUrl: a.baseUrl || DEFAULT_URLS[kind],
    apiKey: a.apiKey ?? '',
    model: a.model ?? (kind === 'anthropic' ? 'claude-opus-5-5' : ''),
    enabled: a.enabled ?? true,
    vision: a.vision ?? true,
    timeoutSec: a.timeoutSec ?? (kind === 'anthropic' ? 300 : 300),
    prompt: a.prompt ?? '',
    effort: effortOf(a.effort ?? 'medium'),
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

export class AgentValidationError extends Error {}

export function validateAgent(input: Partial<AgentConfig>): AgentConfig {
  const a = withDefaults(input)
  if (!['anthropic', 'ollama', 'openai'].includes(String(input.kind ?? a.kind))) throw new AgentValidationError('unknown agent type')
  a.name = String(a.name).trim().slice(0, 80) || 'Agent'
  a.model = String(a.model).trim().slice(0, 200)
  a.baseUrl = String(a.baseUrl).trim()
  try {
    const u = new URL(a.baseUrl)
    if (!/^https?:$/.test(u.protocol)) throw new Error()
  } catch {
    throw new AgentValidationError('The address must start with http:// or https://')
  }
  a.apiKey = String(a.apiKey ?? '').trim()
  a.prompt = String(a.prompt ?? '').slice(0, 4000)
  a.timeoutSec = Math.min(1800, Math.max(5, Number(a.timeoutSec) || 300))
  a.enabled = Boolean(a.enabled)
  a.vision = Boolean(a.vision)
  return a
}

function toView(a: AgentConfig, status?: AgentStatus): AgentView {
  const { apiKey, ...rest } = a
  return {
    ...rest,
    hasApiKey: apiKey.length > 0,
    apiKeyHint: apiKey.length > 8 ? `…${apiKey.slice(-4)}` : apiKey ? '…' : '',
    status: status ?? { lastOkAt: null, lastError: null, lastErrorAt: null },
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'API key rejected'
  if (err instanceof Anthropic.NotFoundError) return 'model not found'
  if (err instanceof Anthropic.RateLimitError) return 'rate limited'
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timed out'
  if (err instanceof Anthropic.APIConnectionError) return 'could not connect to the Anthropic API'
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`
  const e = err as Error
  if (e?.name === 'TimeoutError') return 'timed out'
  return e?.message ?? String(err)
}
