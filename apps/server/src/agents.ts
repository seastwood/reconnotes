import Anthropic from '@anthropic-ai/sdk'
import { newId } from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import { log } from './log'
import { jobSignal, reportAgent, reportProgress, timeoutSignal } from './jobs'
import { parseWyomingUri, toPcm, wyomingDescribe, wyomingTranscribe } from './wyoming'
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'

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

export type AgentKind = 'anthropic' | 'ollama' | 'openai' | 'wyoming'
export type AiTask = 'handwriting' | 'format' | 'images' | 'pdf' | 'compile' | 'ask' | 'audio' | 'embed'
export const AI_TASKS: AiTask[] = ['handwriting', 'format', 'images', 'pdf', 'compile', 'ask', 'audio', 'embed']

/** How an agent reads handwritten drawings. */
export type ReadingMode = 'auto' | 'page' | 'lines'

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
  /**
   * Drawings: read the whole page at once (general vision models) or one
   * line at a time (OCR models, which are poor at page layout).
   */
  reading: ReadingMode
  /** Claude only: stop using this agent once it has cost this much (US$) this month; 0 = no limit */
  monthlyLimitUsd?: number
  /** Ollama thinking models: let it reason before answering (better answers, slower) */
  think?: boolean
}

/** Resolve "auto": Claude reads whole pages well; other (often OCR) models do better line by line. */
export function readingMode(a: AgentConfig): 'page' | 'lines' {
  if (a.reading === 'page' || a.reading === 'lines') return a.reading
  // OCR-only models (GLM-OCR, DeepSeek-OCR…) read one line at a time best; general
  // vision models (qwen2.5vl, llava, Claude…) need the whole page for context –
  // read line by line, wrapped handwriting falls apart into separate items
  return isOcrModel(a.model) ? 'lines' : 'page'
}

export const isOcrModel = (model: string) => /ocr/i.test(model)

export interface AgentStatus {
  lastOkAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

/** What the app sees: never the API key itself. */
export type AgentView = Omit<AgentConfig, 'apiKey'> & { hasApiKey: boolean; apiKeyHint: string; status: AgentStatus; spentThisMonthUsd: number }

// --- Claude spending ------------------------------------------------------------

/** US$ per million tokens [input, output] (Anthropic's API prices); unknown models count as Opus-priced. */
const PRICES: [RegExp, number, number][] = [
  [/fable|mythos/, 10, 50],
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
  [/sonnet-5|sonnet-4-?6|sonnet/, 2, 10],
  [/haiku/, 1, 5],
]
const pricesFor = (model: string) => {
  const hit = PRICES.find(([re]) => re.test(model))
  return hit && /sonnet-4-?6/.test(model) ? ([3, 15] as const) : hit ? ([hit[1], hit[2]] as const) : ([5, 25] as const)
}

/** What a Claude request cost, from its reported usage (cache writes ×1.25, cache reads ×0.1 of the input price). */
export function claudeCost(model: string, u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): number {
  const [inP, outP] = pricesFor(model)
  return ((u.input_tokens ?? 0) * inP + (u.cache_creation_input_tokens ?? 0) * inP * 1.25 + (u.cache_read_input_tokens ?? 0) * inP * 0.1 + (u.output_tokens ?? 0) * outP) / 1e6
}

const SPEND_KEY = 'claude.spend'
let spendStore: Store | null = null
const month = () => new Date().toISOString().slice(0, 7)
/** Spending per agent this month (US$). */
export function spentThisMonth(agentId: string): number {
  const s = spendStore?.getSetting<{ month: string; byAgent: Record<string, number> }>(SPEND_KEY)
  return s && s.month === month() ? (s.byAgent[agentId] ?? 0) : 0
}
function recordSpend(agentId: string, usd: number) {
  if (!spendStore || !usd) return
  const s = spendStore.getSetting<{ month: string; byAgent: Record<string, number> }>(SPEND_KEY)
  const cur = s && s.month === month() ? s : { month: month(), byAgent: {} as Record<string, number> }
  cur.byAgent[agentId] = (cur.byAgent[agentId] ?? 0) + usd
  spendStore.setSetting(SPEND_KEY, cur)
}

export interface AiSettings {
  routing: Record<AiTask, string[]>
  autoHandwriting: boolean
  autoImageText: boolean
  /** transcribe new recordings and audio files in the background (for search) */
  autoAudio: boolean
}

/**
 * Set while a caller wants the reply as it's written (e.g. "Ask your notes"):
 * the backends that can stream call it with the answer so far.
 */
const streamTo = new AsyncLocalStorage<(soFar: string) => void>()
export function streaming<T>(onText: (soFar: string) => void, run: () => Promise<T>): Promise<T> {
  return streamTo.run(onText, run)
}

export type Part = { text: string } | { image: Buffer; mime: string } | { pdf: Buffer }

/** A transcript with each word's time in the recording (seconds), for following along as it plays. */
export interface TimedTranscript {
  text: string
  words?: { word: string; start: number; end: number }[]
}

export interface Backend {
  /** `think`: reason before answering, where the model can (overrides the agent's "Let it think" for this request) */
  generate(parts: Part[], maxTokens: number, opts?: { think?: boolean }): Promise<string>
  /** Speech to text (only OpenAI-compatible agents, e.g. a Whisper server). */
  /** `prompt`: words to expect (names, terms) – a hint, where the server takes one */
  transcribe?(audio: Buffer, mime: string, filename: string, prompt?: string): Promise<string>
  /** …with when each word is said (Whisper's word timestamps), where the server gives them */
  transcribeTimed?(audio: Buffer, mime: string, filename: string, prompt?: string): Promise<TimedTranscript>
  /** Text → vectors that capture meaning (embedding models, e.g. nomic-embed-text), for search by meaning. */
  embed?(texts: string[]): Promise<number[][]>
}

/** Model names that are embedding models (search by meaning) rather than chat models. */
export const EMBED_MODEL = /embed|bge-|e5-|minilm|gte-|arctic-embed|mxbai/i

/** Model names that are speech-to-text models rather than chat models. */
export const SPEECH_MODEL = /whisper|speech|stt|parakeet|canary|voxtral|transcri/i

export const DEFAULT_URLS: Record<AgentKind, string> = {
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
  openai: 'http://localhost:1234/v1',
  wyoming: 'tcp://localhost:10300',
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
    const limit = this.agent.monthlyLimitUsd ?? 0
    if (limit > 0 && spentThisMonth(this.agent.id) >= limit)
      throw new Error(`reached its monthly spending limit ($${limit.toFixed(2)}) – raise it in Settings › AI, or wait for next month`)
    const stream = this.client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
      ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: this.agent.effort } } : {}),
      ...(FALLBACK_OK.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }, { signal: jobSignal() })
    const onText = streamTo.getStore()
    if (onText) {
      let soFar = ''
      stream.on('text', (t) => onText((soFar += t)))
    }
    const msg = await stream.finalMessage()
    recordSpend(this.agent.id, claudeCost(msg.model || model, msg.usage))
    if (msg.stop_reason === 'refusal') throw new Error('the model declined to process this content')
    return msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }
}

/** A model answered, but with nothing usable. `details` says what it did. */
/** The model looked and says there's no writing in the image. */
export class NoTextError extends Error {}

export class EmptyReplyError extends Error {
  constructor(
    readonly details: string,
    /** a plain explanation of what went wrong, when it's clear */
    readonly summary?: string,
    /** why, when known: another prompt won't help a model that can't stop thinking */
    readonly reason?: 'thinking' | 'no-vision',
  ) {
    super(summary ? `${summary} (Details: ${details})` : `returned an empty reply (${details})`)
  }
}

interface OllamaReply {
  content: string
  thinking: string
  doneReason: string
  evalCount: number
}

/**
 * Deterministic output, with a repetition penalty: small OCR models with
 * plain greedy decoding easily get stuck repeating the same words.
 */
const SAMPLING = { temperature: 0, repeat_penalty: 1.15, repeat_last_n: 64 }
/** keep a model loaded for a while after use (Ollama's default is 5 minutes): loading one takes seconds */
const KEEP_ALIVE = '30m'

/**
 * Load an Ollama model now (empty prompt), so the first real request doesn't
 * wait for it. Returns false if it isn't an Ollama agent or can't be reached.
 */
export async function warmOllama(agent: AgentConfig): Promise<boolean> {
  if (agent.kind !== 'ollama') return false
  try {
    await makeRoomOnGpu(agent)
    const res = await fetch(trimSlash(agent.baseUrl) + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.model, prompt: '', keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(120_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** What Ollama says about a model (cached per server + model). */
interface OllamaModelInfo {
  thinking: boolean
  /** the model's own context window, if Ollama reports it */
  contextLength: number | null
}
const ollamaInfo = new Map<string, { at: number; info: Promise<OllamaModelInfo> }>()

/** Room for a thinking model's reasoning, on top of its answer. */
const THINK_ROOM = 6144
/** how much it may think when "Let it think" is on (a small GPU writes ~30 tokens a second) */
const THINK_ROOM_ASKED = 3072

/** Thinking was cut off by the token limit (in the thinking field, or an unclosed <think> in the text). */
const ranOutThinking = (r: OllamaReply) =>
  r.doneReason === 'length' && (Boolean(r.thinking.trim()) || (/<think>/i.test(r.content) && !/<\/think>/i.test(r.content)))

/** the context size each model was last loaded with (another size makes Ollama load it again) */
const lastCtx = new Map<string, { ctx: number; at: number }>()

interface OllamaLoaded {
  name: string
  size: number
  size_vram: number
}
const spilled = (m: OllamaLoaded) => m.size > 0 && m.size_vram < m.size * 0.95
const sameModel = (loaded: string, model: string) => loaded === model || loaded === `${model}:latest` || `${loaded}:latest` === model
const MB = 1048576

/**
 * What's been learned about each Ollama server's GPU (kept across restarts):
 * `tight` once a model was seen squeezed partly onto the CPU; `fitMb` the most
 * that was seen loaded with everything on the GPU.
 */
type GpuInfo = { tight?: boolean; fitMb?: number }
const GPU_KEY = 'ollama.gpu'
function gpuInfo(base: string): GpuInfo {
  return spendStore?.getSetting<Record<string, GpuInfo>>(GPU_KEY)?.[base] ?? {}
}
function saveGpuInfo(base: string, info: GpuInfo) {
  if (!spendStore) return
  const all = spendStore.getSetting<Record<string, GpuInfo>>(GPU_KEY) ?? {}
  spendStore.setSetting(GPU_KEY, { ...all, [base]: info })
}

/** how big each model was when last seen loaded (MB, with its context) */
const seenSize = new Map<string, number>()

/** Learn from what's loaded now (also called by the health check). */
export function observeOllama(baseUrl: string, models: OllamaLoaded[]) {
  const base = trimSlash(baseUrl)
  for (const m of models) if (m.size) seenSize.set(`${base}|${m.name}`, m.size / MB)
  const cur = gpuInfo(base)
  const big = models.filter((m) => !EMBED_MODEL.test(m.name))
  const vram = models.reduce((a, m) => a + (m.size_vram || 0), 0) / MB
  // squeezed beside Whisper says nothing about how much fits on the GPU
  if (big.some(spilled) && speechInUse.size) return
  if (big.some(spilled)) {
    if (!cur.tight) log.info(`Ollama at ${base}: a model was squeezed partly onto the CPU – from now on one model at a time on its GPU`)
    if (!cur.tight || (cur.fitMb ?? Infinity) > vram) saveGpuInfo(base, { tight: true, fitMb: Math.round(Math.min(cur.fitMb ?? Infinity, vram)) })
  } else if (models.length && vram > (cur.fitMb ?? 0) && !cur.tight) saveGpuInfo(base, { ...cur, fitMb: Math.round(vram) })
}

const loadedModels = async (base: string): Promise<OllamaLoaded[] | null> => {
  try {
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) })
    return ((await res.json()) as { models?: OllamaLoaded[] }).models ?? []
  } catch {
    return null
  }
}

/** A model's size on disk (MB), about what it needs on the GPU. */
const diskSizes = new Map<string, { at: number; sizes: Map<string, number> }>()
async function diskSizeMb(base: string, model: string): Promise<number | null> {
  let hit = diskSizes.get(base)
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })
      const list = ((await res.json()) as { models?: { name: string; size: number }[] }).models ?? []
      hit = { at: Date.now(), sizes: new Map(list.map((m) => [m.name, m.size / MB])) }
      diskSizes.set(base, hit)
    } catch {
      return null
    }
  }
  return hit.sizes.get(model) ?? hit.sizes.get(`${model}:latest`) ?? null
}

/**
 * A speech-to-text server's own address, without the OpenAI path ("http://host:8000/v1" → "http://host:8000"):
 * Speaches keeps its list of loaded models there (/api/ps).
 */
const speechRoot = (agent: AgentConfig) => trimSlash(agent.baseUrl).replace(/\/v1$/, '')

/** The models a speech-to-text server (Speaches) has in memory; null when it can't say (other servers). */
export async function speechLoaded(agent: AgentConfig): Promise<string[] | null> {
  if (agent.kind !== 'openai') return null
  try {
    const res = await fetch(`${speechRoot(agent)}/api/ps`, { headers: agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {}, signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const models = ((await res.json()) as { models?: unknown }).models
    return Array.isArray(models) ? models.map((m) => (typeof m === 'string' ? m : String((m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? ''))).filter(Boolean) : null
  } catch {
    return null
  }
}

/** Ask Speaches to let go of its model (other servers can't be asked, and are left alone). */
async function unloadSpeech(agent: AgentConfig): Promise<boolean> {
  if (agent.kind !== 'openai' || !agent.model) return false
  try {
    const res = await fetch(`${speechRoot(agent)}/api/ps/${agent.model}`, { method: 'DELETE', headers: agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {}, signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Speech-to-text servers used lately: Speaches keeps Whisper in the GPU's memory for a few
 * minutes after transcribing. That's fine on a big GPU – on a small one (8 GB) the language
 * model that writes the meeting notes may then not fit beside it, and runs partly on the CPU,
 * many times slower. So Whisper is only unloaded when a model was seen not to fit beside it.
 */
const speechInUse = new Map<string, AgentConfig>()
export function speechUsed(agent: AgentConfig) {
  if (agent.kind === 'openai' && agent.model) speechInUse.set(`${speechRoot(agent)}|${agent.model}`, agent)
}
/** The speech servers that still have their model loaded. */
async function speechHolding(): Promise<AgentConfig[]> {
  const out: AgentConfig[] = []
  for (const [key, agent] of speechInUse) {
    const loaded = await speechLoaded(agent)
    if (loaded?.includes(agent.model)) out.push(agent)
    else speechInUse.delete(key)
  }
  return out
}

/** Models (per Ollama server) seen squeezed onto the CPU while Whisper was loaded: for them it's unloaded first. */
const SPEECH_OUT_KEY = 'ollama.speechOut'
const needsSpeechOut = (base: string, model: string) => Boolean(spendStore?.getSetting<Record<string, boolean>>(SPEECH_OUT_KEY)?.[`${base}|${model}`])
function rememberSpeechOut(base: string, model: string) {
  if (!spendStore || needsSpeechOut(base, model)) return
  spendStore.setSetting(SPEECH_OUT_KEY, { ...(spendStore.getSetting<Record<string, boolean>>(SPEECH_OUT_KEY) ?? {}), [`${base}|${model}`]: true })
  log.info(`${model} doesn't fit on the GPU beside the speech-to-text model – from now on that's unloaded first`)
}
async function clearSpeech(speech: AgentConfig[], forModel: string) {
  const done = await Promise.all(speech.map(async (a) => ((await unloadSpeech(a)) ? (speechInUse.delete(`${speechRoot(a)}|${a.model}`), a.model) : null)))
  const names = done.filter(Boolean)
  if (names.length) log.info(`made room on the GPU for ${forModel}: unloaded ${names.join(', ')} (speech-to-text)`)
}

/**
 * The other way round: Whisper failing because a language model left too little of the GPU
 * (e.g. qwen3 still loaded from the last job, on an 8 GB card – CUDA "out of memory"). Ollama's
 * models are unloaded and Whisper tried again; when that's what it took, it's remembered, and
 * from then on Ollama makes room before this speech model transcribes.
 */
export async function freeOllamaGpu(baseUrls: string[]): Promise<string[]> {
  const out: string[] = []
  for (const base of [...new Set(baseUrls.map(trimSlash))]) {
    const models = await loadedModels(base)
    if (!models?.length) continue
    await Promise.all(
      models.map((m) =>
        fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          signal: AbortSignal.timeout(15_000),
        }).catch(() => undefined),
      ),
    )
    for (let i = 0; i < 30; i++) {
      const now = await loadedModels(base)
      if (!now?.length) break
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const m of models) lastCtx.delete(`${base}|${m.name}`)
    out.push(...models.map((m) => m.name))
  }
  if (out.length) log.info(`made room on the GPU for speech-to-text: unloaded ${out.join(', ')}`)
  return out
}
const SPEECH_ROOM_KEY = 'speech.needsRoom'
export const speechNeedsRoom = (agent: AgentConfig) => Boolean(spendStore?.getSetting<Record<string, boolean>>(SPEECH_ROOM_KEY)?.[`${speechRoot(agent)}|${agent.model}`])
export function rememberSpeechNeedsRoom(agent: AgentConfig) {
  if (!spendStore || speechNeedsRoom(agent)) return
  spendStore.setSetting(SPEECH_ROOM_KEY, { ...(spendStore.getSetting<Record<string, boolean>>(SPEECH_ROOM_KEY) ?? {}), [`${speechRoot(agent)}|${agent.model}`]: true })
  log.info(`${agent.model} needs the GPU to itself – from now on Ollama's models are unloaded before it transcribes`)
}

/**
 * Before a job: make sure its model will run on the GPU. On a small GPU
 * (8 GB) Ollama keeps the last model in memory and squeezes the next one in
 * beside it – mostly on the CPU, many times slower. So before loading a model,
 * the others are unloaded unless it's known they fit together (small
 * embedding models are left alone), and a model already squeezed onto the CPU
 * is loaded again with the whole GPU.
 */
export async function makeRoomOnGpu(agent: AgentConfig, ctx?: number): Promise<string[]> {
  const out = await makeRoom(agent)
  // Whisper still loaded: load the model now and look, before a long job runs squeezed
  if (ctx && speechInUse.size) await probeBesideSpeech(agent, ctx)
  return out
}

/**
 * Load the model (with the context the job will ask for) and see whether it fits beside the
 * speech-to-text model. If it was squeezed partly onto the CPU: Whisper out, the model out
 * (it loads again fully with the job), and remembered for next time. Seeing it only after a
 * request would leave that request – a long meeting's first part – running slowly.
 */
async function probeBesideSpeech(agent: AgentConfig, ctx: number) {
  const base = trimSlash(agent.baseUrl)
  if ((await loadedModels(base))?.some((m) => sameModel(m.name, agent.model))) return
  if (needsSpeechOut(base, agent.model)) return
  const speech = await speechHolding()
  if (!speech.length) return
  reportProgress(`Loading ${agent.model}…`)
  const loaded = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: agent.model, prompt: '', keep_alive: KEEP_ALIVE, options: { num_ctx: ctx } }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null)
  if (!loaded?.ok) return
  const now = await loadedModels(base)
  const self = now?.find((m) => sameModel(m.name, agent.model))
  if (!self || !spilled(self)) return
  rememberSpeechOut(base, agent.model)
  await clearSpeech(speech, agent.model)
  await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: self.name, keep_alive: 0 }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
  for (let i = 0; i < 30; i++) {
    if (!(await loadedModels(base))?.some((m) => m.name === self.name)) break
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function makeRoom(agent: AgentConfig): Promise<string[]> {
  const base = trimSlash(agent.baseUrl)
  const all = await loadedModels(base)
  if (!all) return []
  observeOllama(base, all)
  const models = all.filter((m) => !EMBED_MODEL.test(m.name))
  const self = models.find((m) => sameModel(m.name, agent.model))
  if (self && !spilled(self)) return []
  // Whisper (Speaches) on the same GPU: out only if this model was squeezed beside it
  const speech = speechInUse.size ? await speechHolding() : []
  if (speech.length && self) rememberSpeechOut(base, agent.model)
  if (speech.length && (self || needsSpeechOut(base, agent.model))) await clearSpeech(speech, agent.model)
  const others = models.filter((m) => m !== self)
  if (!self && !others.length) return []
  if (!self) {
    // will it fit beside what's loaded? Only if that's been seen to work.
    const info = gpuInfo(base)
    const seen = seenSize.get(`${base}|${agent.model}`) ?? seenSize.get(`${base}|${agent.model}:latest`)
    const disk = seen === undefined ? await diskSizeMb(base, agent.model) : null
    const need = seen ?? (disk !== null ? disk * 1.25 + 500 : null)
    const used = all.reduce((a, m) => a + (m.size_vram || 0), 0) / MB
    if (need !== null && info.fitMb && used + need <= info.fitMb + 1) return []
  }
  // everything else out – and this model too if it's half on the CPU, so it loads again fully on the GPU
  const out = self ? [...others, self] : others
  await Promise.all(
    out.map((m) =>
      fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined),
    ),
  )
  // wait until they've really left the GPU (Ollama unloads in the background)
  for (let i = 0; i < 30; i++) {
    const now = await loadedModels(base)
    if (!now || !now.some((m) => out.some((o) => o.name === m.name))) break
    await new Promise((r) => setTimeout(r, 500))
  }
  for (const m of out) lastCtx.delete(`${base}|${m.name}`)
  log.info(`made room on the GPU for ${agent.model}: unloaded ${out.map((m) => m.name).join(', ')}`)
  return out.map((m) => m.name)
}

class OllamaBackend implements Backend {
  constructor(private agent: AgentConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const body = await this.post('/api/embed', { input: texts, keep_alive: KEEP_ALIVE, truncate: true })
    const out = body.embeddings as number[][] | undefined
    if (!Array.isArray(out) || out.length !== texts.length) throw new Error(`${this.agent.model} didn't return embeddings – is it an embedding model (e.g. nomic-embed-text)?`)
    return out
  }

  /** Can it think, and how long is its context? Asked once an hour; unknown if Ollama doesn't say. */
  private info(): Promise<OllamaModelInfo> {
    const key = `${trimSlash(this.agent.baseUrl)}|${this.agent.model}`
    const hit = ollamaInfo.get(key)
    if (hit && Date.now() - hit.at < 3600_000) return hit.info
    const info = this.post('/api/show', {})
      .then((body) => {
        const caps = (body.capabilities as string[] | undefined) ?? []
        const modelInfo = (body.model_info ?? {}) as Record<string, unknown>
        const ctxKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'))
        return { thinking: caps.includes('thinking'), contextLength: ctxKey ? Number(modelInfo[ctxKey]) || null : null }
      })
      .catch(() => ({ thinking: false, contextLength: null }))
    ollamaInfo.set(key, { at: Date.now(), info })
    return info
  }

  async generate(parts: Part[], maxTokens: number, opts?: { think?: boolean }): Promise<string> {
    const think = opts?.think ?? this.agent.think
    if (parts.some((p) => 'pdf' in p)) throw new Error('Ollama models cannot read PDFs')
    const text = parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join('\n\n')
    const images = parts.filter((p): p is { image: Buffer; mime: string } => 'image' in p).map((p) => p.image.toString('base64'))
    const info = await this.info()
    // room for the answer itself (callers size it to the job, e.g. small per handwritten line)
    const limit = Math.min(maxTokens, 8192)
    // Ollama's default context (often 4K) silently cuts long jobs short:
    // ask for one that fits the prompt, the pictures and the reply.
    const inputTokens = Math.ceil(text.length / 3) + images.length * 1500
    const ctxFor = (predict: number) => {
      const need = inputTokens + predict + 512
      const cap = Math.min(info.contextLength ?? 32768, 32768)
      const want = Math.min(cap, [8192, 16384, 32768].find((b) => b >= need) ?? 32768)
      // a different size makes Ollama load the model again: keep a bigger one it already has
      const key = `${trimSlash(this.agent.baseUrl)}|${this.agent.model}`
      const last = lastCtx.get(key)
      const ctx = last && last.ctx > want && Date.now() - last.at < 30 * 60_000 ? last.ctx : want
      lastCtx.set(key, { ctx, at: Date.now() })
      return ctx
    }
    // room on the GPU – sized for the first request (the context it'll be loaded with)
    await makeRoomOnGpu(this.agent, ctxFor(info.thinking && think ? limit + THINK_ROOM_ASKED : limit))
    const tried: string[] = []
    let thoughtTooLong = 0

    const attempt = async (label: string, run: () => Promise<OllamaReply>): Promise<string | null> => {
      const r = await run()
      const answer = answerOf(r.content)
      if (answer) return answer
      if (ranOutThinking(r)) thoughtTooLong = Math.max(thoughtTooLong, r.evalCount)
      tried.push(
        `${label}: ${r.evalCount} tokens, done_reason=${r.doneReason || '?'}${r.thinking.trim() || /<think>/i.test(r.content) ? `, reasoning only: “${preview(r.thinking || r.content.replace(/<\/?think>/gi, ''), 80)}”` : ''}`,
      )
      return null
    }
    // Qwen's "/no_think" switch, which some models honour instead of think:false
    const noThinkText = `${text}\n\n/no_think`

    if (info.thinking && think) {
      // asked to think ("Let it think"): reason first, with room for it – a bounded amount, so a
      // small model that would think forever still gets to answer (below, without thinking)
      const roomy = limit + THINK_ROOM_ASKED
      reportProgress(`${this.agent.name} is thinking it through…`)
      const thought = await attempt('chat with thinking', () => this.chat(text, images, roomy, ctxFor(roomy), true)).catch((e) => {
        tried.push(`chat with thinking: ${(e as Error).message}`)
        return null
      })
      if (thought !== null) return thought
    }
    if (info.thinking) {
      // 1. thinking models: these jobs don't need reasoning – ask for the answer straight away
      const quick = await attempt('chat without thinking', () => this.chat(noThinkText, images, limit, ctxFor(limit), false))
      if (quick !== null) return quick
      // 2. it thought anyway (some only can): give it room to think *and* answer
      const roomy = limit + THINK_ROOM
      const full = await attempt('chat with room to think', () => this.chat(text, images, roomy, ctxFor(roomy), true)).catch((e) => {
        tried.push(`chat with room to think: ${(e as Error).message}`)
        return null
      })
      if (full !== null) return full
      // still thinking when it ran out of room: other ways of asking won't help
      if (thoughtTooLong >= roomy - 64) throw new EmptyReplyError(tried.join('; '), this.thinkingSummary(thoughtTooLong), 'thinking')
    } else {
      // 1. normal chat request
      const first = await attempt('chat', () => this.chat(text, images, limit, ctxFor(limit)))
      if (first !== null) return first
      // 2. it reasoned without saying it could: again with thinking off, and room to finish if it reasons anyway
      if (tried[0].includes('reasoning only')) {
        const roomy = limit + THINK_ROOM
        const again = await attempt('chat without thinking', () => this.chat(noThinkText, images, roomy, ctxFor(roomy), false)).catch(() => null)
        if (again !== null) return again
      }
    }
    // 3. some OCR models only answer through the plain /api/generate endpoint
    const gen = await attempt('generate', () => this.plainGenerate(text, images, limit, ctxFor(limit))).catch((e) => {
      tried.push(`generate: ${(e as Error).message}`)
      return null
    })
    if (gen) return gen

    const noTokens = tried.every((t) => /^[^:]+: 0 tokens/.test(t))
    log.info(`Ollama model ${this.agent.model} gave empty replies – ${tried.join('; ')}`)
    if (thoughtTooLong) throw new EmptyReplyError(tried.join('; '), this.thinkingSummary(thoughtTooLong), 'thinking')
    if (noTokens && images.length)
      throw new EmptyReplyError(
        tried.join('; '),
        `The model generated nothing at all, which usually means it can't read images – run “ollama show ${this.agent.model}” and check that Capabilities lists “vision”.`,
        'no-vision',
      )
    throw new EmptyReplyError(tried.join('; '))
  }

  private thinkingSummary(tokens: number): string {
    return (
      `“${this.agent.model}” is a thinking model: it spent all ${tokens} tokens it was given reasoning and never wrote an answer, ` +
      `even when asked not to think. Choose a version of it that doesn't think (often tagged “instruct”, e.g. ${suggestInstruct(this.agent.model)}) or another model for this job.`
    )
  }

  private async post(path: string, body: object): Promise<Record<string, unknown>> {
    const res = await fetchWithHints(trimSlash(this.agent.baseUrl) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: timeoutSignal(this.agent.timeoutSec * 1000),
      body: JSON.stringify({ model: this.agent.model, stream: false, ...body }),
    })
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return (await res.json()) as Record<string, unknown>
  }

  private async chat(text: string, images: string[], maxTokens: number, numCtx: number, think?: boolean): Promise<OllamaReply> {
    const req = {
      ...(think === undefined ? {} : { think }),
      options: { num_predict: maxTokens, num_ctx: numCtx, ...SAMPLING },
      keep_alive: KEEP_ALIVE,
      messages: [{ role: 'user', content: text, ...(images.length ? { images } : {}) }],
    }
    const onText = streamTo.getStore()
    if (onText) return this.streamChat(req, onText)
    const body = await this.post('/api/chat', req)
    const m = (body.message ?? {}) as { content?: string; thinking?: string }
    return { content: m.content ?? '', thinking: m.thinking ?? '', doneReason: String(body.done_reason ?? ''), evalCount: Number(body.eval_count ?? 0) }
  }

  /** /api/chat, a line of JSON per few words; the answer so far goes to `onText` (without any reasoning). */
  private async streamChat(req: object, onText: (soFar: string) => void): Promise<OllamaReply> {
    const res = await fetchWithHints(trimSlash(this.agent.baseUrl) + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: timeoutSignal(this.agent.timeoutSec * 1000),
      body: JSON.stringify({ model: this.agent.model, stream: true, ...req }),
    })
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const out: OllamaReply = { content: '', thinking: '', doneReason: '', evalCount: 0 }
    const decoder = new TextDecoder()
    let buf = ''
    const line = (l: string) => {
      if (!l.trim()) return
      const j = JSON.parse(l) as { message?: { content?: string; thinking?: string }; done_reason?: string; eval_count?: number; error?: string }
      if (j.error) throw new Error(`Ollama: ${j.error}`)
      if (j.message?.content) {
        out.content += j.message.content
        const answer = answerOf(out.content)
        if (answer) onText(answer)
      }
      if (j.message?.thinking) out.thinking += j.message.thinking
      if (j.done_reason) out.doneReason = j.done_reason
      if (j.eval_count) out.evalCount = j.eval_count
    }
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      lines.forEach(line)
    }
    line(buf)
    return out
  }

  private async plainGenerate(text: string, images: string[], maxTokens: number, numCtx: number): Promise<OllamaReply> {
    const body = await this.post('/api/generate', {
      prompt: text,
      ...(images.length ? { images } : {}),
      options: { num_predict: maxTokens, num_ctx: numCtx, ...SAMPLING },
      keep_alive: KEEP_ALIVE,
    })
    return {
      content: String(body.response ?? ''),
      thinking: String(body.thinking ?? ''),
      doneReason: String(body.done_reason ?? ''),
      evalCount: Number(body.eval_count ?? 0),
    }
  }
}

/** The answer in a reply: without reasoning, including reasoning that was cut off mid-way. */
function answerOf(content: string): string {
  const open = content.search(/<think>/i)
  // an unclosed <think>: everything after it is unfinished reasoning
  if (open >= 0 && !/<\/think>/i.test(content.slice(open))) return stripThinking(content.slice(0, open))
  return stripThinking(content)
}

/** "qwen3-vl:4b" → "qwen3-vl:4b-instruct" (a guess to show people what to look for). */
function suggestInstruct(model: string): string {
  const [name, tag = 'latest'] = model.split(':')
  const base = tag.replace(/-(thinking|think)$/i, '')
  return `${name}:${base === 'latest' ? 'instruct' : `${base}-instruct`}`
}

class OpenAiBackend implements Backend {
  constructor(private agent: AgentConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetchWithHints(trimSlash(this.agent.baseUrl) + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.agent.apiKey ? { Authorization: `Bearer ${this.agent.apiKey}` } : {}) },
      signal: timeoutSignal(this.agent.timeoutSec * 1000),
      body: JSON.stringify({ model: this.agent.model, input: texts }),
    })
    if (!res.ok) throw new Error(`embeddings: ${res.status} ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] }
    const data = (json.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding)
    if (data.length !== texts.length) throw new Error(`${this.agent.model} didn't return embeddings`)
    return data
  }

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
      signal: timeoutSignal(this.agent.timeoutSec * 1000),
      body: JSON.stringify({
        model: this.agent.model,
        max_tokens: maxTokens,
        temperature: 0,
        frequency_penalty: 0.3, // discourages repetition loops
        messages: [{ role: 'user', content }],
      }),
    })
    if (!res.ok) throw new Error(`server returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return stripThinking(body.choices?.[0]?.message?.content ?? '')
  }
  /**
   * OpenAI's /audio/transcriptions API, which self-hosted Whisper servers
   * (Speaches / faster-whisper-server, whisper.cpp, LocalAI…) also offer.
   */
  async transcribe(audio: Buffer, mime: string, filename: string, prompt?: string): Promise<string> {
    return (await this.transcribeTimed(audio, mime, filename, prompt)).text
  }

  async transcribeTimed(audio: Buffer, mime: string, filename: string, prompt?: string): Promise<TimedTranscript> {
    const send = async (timed: boolean) => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'application/octet-stream' }), filename || audioFileName(mime))
      form.append('model', this.agent.model || 'whisper-1')
      // with each word's time (to follow along as it plays), where the server can
      form.append('response_format', timed ? 'verbose_json' : 'json')
      if (timed) form.append('timestamp_granularities[]', 'word')
      // your names and terms: Whisper spells what it hears like the words it was "told" before
      if (prompt) form.append('prompt', prompt)
      return fetchWithHints(trimSlash(this.agent.baseUrl) + '/audio/transcriptions', {
        method: 'POST',
        headers: this.agent.apiKey ? { Authorization: `Bearer ${this.agent.apiKey}` } : {},
        // a long recording takes a while, even on a GPU
        signal: timeoutSignal(Math.max(this.agent.timeoutSec, 900) * 1000),
        body: form,
      })
    }
    let res = await send(true)
    // a server without word times (some whisper.cpp builds): the words alone
    if (res.status === 400 || res.status === 422) res = await send(false)
    if (!res.ok) throw new Error(`server returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = await res.text()
    try {
      const j = JSON.parse(body) as { text?: string; words?: { word?: string; start?: number; end?: number }[]; segments?: { words?: { word?: string; start?: number; end?: number }[] }[] }
      const raw = j.words ?? j.segments?.flatMap((sg) => sg.words ?? []) ?? []
      const words = raw
        .filter((w) => typeof w.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
        .map((w) => ({ word: w.word!.trim(), start: w.start!, end: w.end! }))
        .filter((w) => w.word)
      return { text: String(j.text ?? '').trim(), ...(words.length ? { words } : {}) }
    } catch {
      return { text: body.trim() }
    }
  }

}

/** A file name with the right extension: Whisper servers pick the decoder from it. */
function audioFileName(mime: string): string {
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : /ogg|opus/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /flac/.test(mime) ? 'flac' : 'webm'
  return `audio.${ext}`
}

/**
 * A Wyoming speech-to-text server (Home Assistant's wyoming-faster-whisper
 * and friends). Audio only; recordings are converted to raw 16 kHz audio.
 */
class WyomingBackend implements Backend {
  constructor(private agent: AgentConfig) {}

  async generate(): Promise<string> {
    throw new Error('Wyoming servers only transcribe audio')
  }

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const pcm = await toPcm(audio, mime)
    return wyomingTranscribe(this.agent.baseUrl, pcm, {
      model: this.agent.model || undefined,
      // a long recording takes a while, especially without a GPU
      timeoutMs: Math.max(this.agent.timeoutSec, 900) * 1000,
    })
  }
}

export function makeBackend(agent: AgentConfig): Backend {
  switch (agent.kind) {
    case 'wyoming':
      return new WyomingBackend(agent)
    case 'anthropic':
      return new AnthropicBackend(agent)
    case 'ollama':
      return new OllamaBackend(agent)
    case 'openai':
      return new OpenAiBackend(agent)
  }
}

/** Is ffmpeg installed (needed to send recordings to Wyoming servers)? */
function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'])
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
}

/** Shorten model output for error messages. */
export function preview(s: string, n = 160): string {
  const t = stripThinking(s) || s.replace(/<\/?think>/gi, '')
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one || '(empty)'
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

export interface ModelInfo {
  id: string
  /** e.g. "3.3 GB · 4B · Q4_K_M" */
  detail: string
  /** can it read images? null = unknown */
  vision: boolean | null
}

/** List the models an agent's server offers, for the model picker. */
export async function listModels(agent: AgentConfig): Promise<{ models: ModelInfo[]; error: string | null }> {
  try {
    if (agent.kind === 'wyoming') {
      const info = await wyomingDescribe(agent.baseUrl)
      const models = info.asr.flatMap((a) =>
        a.models.map((m) => ({ id: m.name, detail: [a.name, m.languages.length > 3 ? `${m.languages.length} languages` : m.languages.join(', ')].filter(Boolean).join(' · '), vision: false })),
      )
      return { models, error: models.length ? null : "This Wyoming server doesn't offer speech to text." }
    }
    if (agent.kind === 'ollama') {
      const base = trimSlash(agent.baseUrl)
      const res = await fetchWithHints(base + '/api/tags', { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { models: [], error: `Ollama answered ${res.status}` }
      const body = (await res.json()) as {
        models?: { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }[]
      }
      const list = body.models ?? []
      // Ask each model what it can do (Ollama ≥ 0.6 reports "vision").
      const caps = await Promise.all(
        list.map(async (m) => {
          try {
            const r = await fetch(base + '/api/show', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: m.name }),
              signal: AbortSignal.timeout(8_000),
            })
            const info = (await r.json()) as { capabilities?: string[] }
            return info.capabilities ? info.capabilities.includes('vision') : null
          } catch {
            return null
          }
        }),
      )
      return {
        models: list.map((m, i) => ({
          id: m.name,
          detail: [m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '', m.details?.parameter_size ?? '', m.details?.quantization_level ?? '']
            .filter(Boolean)
            .join(' · '),
          vision: caps[i],
        })),
        error: null,
      }
    }
    if (agent.kind === 'openai') {
      const res = await fetchWithHints(trimSlash(agent.baseUrl) + '/models', {
        signal: AbortSignal.timeout(10_000),
        headers: agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {},
      })
      if (res.status === 401 || res.status === 403) return { models: [], error: 'The server rejected the API key.' }
      if (!res.ok) return { models: [], error: `The server answered ${res.status}. The base URL usually ends in /v1.` }
      const body = (await res.json()) as { data?: { id: string }[] }
      return { models: (body.data ?? []).map((m) => ({ id: m.id, detail: '', vision: null })), error: null }
    }
    if (!agent.apiKey) return { models: [], error: 'Enter an API key to list models.' }
    const client = new Anthropic({
      apiKey: agent.apiKey,
      baseURL: agent.baseUrl && agent.baseUrl !== DEFAULT_URLS.anthropic ? agent.baseUrl : undefined,
      timeout: 15_000,
      maxRetries: 0,
    })
    const models: ModelInfo[] = []
    for await (const m of client.models.list({ limit: 100 })) models.push({ id: m.id, detail: m.display_name, vision: true })
    return { models, error: null }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { models: [], error: 'Anthropic rejected the API key.' }
    return { models: [], error: (err as Error).message }
  }
}

/** Check that an agent is reachable, authorised and has the chosen model. */
export async function probeAgent(agent: AgentConfig): Promise<ProbeResult> {
  const warnings: string[] = []
  const timeout = AbortSignal.timeout(Math.min(agent.timeoutSec, 20) * 1000)
  try {
    if (agent.kind === 'wyoming') {
      const info = await wyomingDescribe(agent.baseUrl, Math.min(agent.timeoutSec, 20) * 1000)
      const models = info.asr.flatMap((a) => a.models.map((m) => m.name))
      if (!info.asr.length)
        return { ok: false, message: "Connected, but this Wyoming server doesn't offer speech to text (it may be a text-to-speech or wake-word server).", models, warnings }
      if (!(await hasFfmpeg())) warnings.push('ffmpeg isn\'t installed on the ReconNotes server, so only WAV files can be transcribed. Install it: sudo apt install ffmpeg')
      if (agent.model && models.length && !models.includes(agent.model)) warnings.push(`The server offers ${models.join(', ')} – "${agent.model}" will be ignored.`)
      return { ok: true, message: `Connected to ${info.asr.map((a) => a.name).join(', ')}${models.length ? ` (${models.join(', ')})` : ''}.`, models, warnings }
    }
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
        if (info.capabilities?.includes('thinking'))
          warnings.push(
            agent.think
              ? `"${agent.model}" is a thinking model, and "Let it think" is on: it reasons before each answer – better answers to questions about rules and manuals, but each takes longer (a minute or more on a small GPU). If it thinks too long, it answers without thinking instead.`
              : `"${agent.model}" is a thinking model. ReconNotes asks it to answer without thinking (faster), and gives it extra room when it thinks anyway. Turn on "Let it think" for better reasoning – worth it for "Ask your notes", slower for everything else.`,
          )
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
  format: 'Clean up converted text',
  images: 'Text from images',
  pdf: 'Text from PDFs',
  compile: 'Compile notes',
  ask: 'Ask your notes',
  audio: 'Audio to text',
  embed: 'Search by meaning',
}

/** Tasks a new agent of this kind can do (where it is added by default). */
function defaultTasks(a: AgentConfig): AiTask[] {
  // a speech-to-text server (e.g. Whisper) does only that
  if (a.kind === 'wyoming' || (a.kind === 'openai' && SPEECH_MODEL.test(a.model))) return ['audio']
  // an embedding model only does search by meaning
  if (EMBED_MODEL.test(a.model)) return a.kind === 'anthropic' ? [] : ['embed']
  const t: AiTask[] = []
  if (a.vision) t.push('handwriting', 'images')
  if (a.kind === 'anthropic') t.push('format', 'pdf')
  t.push('compile')
  return t
}

export class AgentRegistry {
  private status = new Map<string, AgentStatus>()

  constructor(
    private store: Store,
    config: Config,
  ) {
    spendStore = store
    if (store.getSetting(AGENTS_KEY) === null) this.seedFromEnv(config)
    this.adoptTranscribeEnv(config)
  }

  /**
   * Audio transcription used to be configured only with RECON_TRANSCRIBE_URL.
   * Turn that into a speech-to-text agent once, so it shows up (and can be
   * changed) in Settings › AI agents.
   */
  private adoptTranscribeEnv(c: Config) {
    if (!c.transcribeUrl || this.store.getSetting('ai.transcribeEnvAdopted')) return
    this.store.setSetting('ai.transcribeEnvAdopted', true)
    const wyoming = /^tcp:\/\//.test(c.transcribeUrl)
    const agent = withDefaults({
      id: newId(),
      name: 'Speech to text',
      kind: wyoming ? 'wyoming' : 'openai',
      baseUrl: wyoming ? c.transcribeUrl : trimSlash(c.transcribeUrl).replace(/\/v1$/, '') + '/v1',
      apiKey: c.transcribeApiKey ?? '',
      model: c.transcribeModel,
      vision: false,
    })
    this.store.setSetting(AGENTS_KEY, [...this.agents(), agent])
    const s = this.settings()
    s.routing.audio = [agent.id]
    this.store.setSetting(SETTINGS_KEY, s)
    log.info(`added speech-to-text agent for ${agent.baseUrl} (from RECON_TRANSCRIBE_URL); manage it in Settings › AI agents`)
  }

  agents(): AgentConfig[] {
    return (this.store.getSetting<AgentConfig[]>(AGENTS_KEY) ?? []).map(withDefaults)
  }

  settings(): AiSettings {
    const s = this.store.getSetting<Partial<AiSettings>>(SETTINGS_KEY) ?? {}
    const routing = { handwriting: [], format: [], images: [], pdf: [], compile: [], ask: [], audio: [], embed: [], ...(s.routing ?? {}) } as Record<AiTask, string[]>
    return { routing, autoHandwriting: s.autoHandwriting ?? true, autoImageText: s.autoImageText ?? true, autoAudio: s.autoAudio ?? true }
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
    if (typeof patch.autoAudio === 'boolean') s.autoAudio = patch.autoAudio
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
  async run<T>(
    task: AiTask,
    fn: (backend: Backend, agent: AgentConfig) => Promise<T>,
    /** only some of the task's agents (e.g. leave out the ones that just did the reading) */
    only?: (agent: AgentConfig) => boolean,
  ): Promise<{ result: T; agent: AgentConfig }> {
    const chain = only ? this.chain(task).filter(only) : this.chain(task)
    if (!chain.length) throw new NoAgentError(task)
    const failures: string[] = []
    for (const agent of chain) {
      if (jobSignal()?.aborted) throw jobSignal()!.reason
      reportAgent(agent.model ? `${agent.name} (${agent.model})` : agent.name)
      try {
        const result = await fn(makeBackend(agent), agent)
        this.status.set(agent.id, { ...this.statusOf(agent.id), lastOkAt: Date.now() })
        return { result, agent }
      } catch (err) {
        if (jobSignal()?.aborted) throw jobSignal()!.reason
        if (err instanceof NoTextError) throw err // nothing written there: another model won't find more
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
      format: claude ? [claude.id] : [],
      compile: order(c.compileProvider, [claude, ollamaText ?? ollama]),
      ask: [],
      audio: [],
      embed: [],
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
  const kind: AgentKind = a.kind === 'ollama' || a.kind === 'openai' || a.kind === 'wyoming' ? a.kind : 'anthropic'
  return {
    id: a.id ?? newId(),
    name: a.name || (kind === 'anthropic' ? 'Claude' : kind === 'ollama' ? 'Ollama' : kind === 'wyoming' ? 'Whisper (Wyoming)' : 'OpenAI-compatible'),
    kind,
    baseUrl: a.baseUrl || DEFAULT_URLS[kind],
    apiKey: a.apiKey ?? '',
    model: a.model ?? (kind === 'anthropic' ? 'claude-opus-5-5' : ''),
    enabled: a.enabled ?? true,
    vision: a.vision ?? kind !== 'wyoming',
    timeoutSec: a.timeoutSec ?? (kind === 'anthropic' ? 300 : 300),
    prompt: a.prompt ?? '',
    effort: effortOf(a.effort ?? 'medium'),
    reading: a.reading === 'page' || a.reading === 'lines' ? a.reading : 'auto',
    monthlyLimitUsd: Number(a.monthlyLimitUsd) > 0 ? Number(a.monthlyLimitUsd) : 0,
    think: kind === 'ollama' && a.think === true,
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

export class AgentValidationError extends Error {}

export function validateAgent(input: Partial<AgentConfig>): AgentConfig {
  const a = withDefaults(input)
  if (!['anthropic', 'ollama', 'openai', 'wyoming'].includes(String(input.kind ?? a.kind))) throw new AgentValidationError('unknown agent type')
  a.name = String(a.name).trim().slice(0, 80) || 'Agent'
  a.model = String(a.model).trim().slice(0, 200)
  a.baseUrl = String(a.baseUrl).trim()
  if (a.kind === 'wyoming') {
    try {
      const { host, port } = parseWyomingUri(a.baseUrl)
      a.baseUrl = `tcp://${host}:${port}`
    } catch (err) {
      throw new AgentValidationError((err as Error).message)
    }
  } else {
    try {
      const u = new URL(a.baseUrl)
      if (!/^https?:$/.test(u.protocol)) throw new Error()
    } catch {
      throw new AgentValidationError('The address must start with http:// or https://')
    }
  }
  a.apiKey = String(a.apiKey ?? '').trim()
  a.prompt = String(a.prompt ?? '').slice(0, 4000)
  a.timeoutSec = Math.min(1800, Math.max(5, Number(a.timeoutSec) || 300))
  a.enabled = Boolean(a.enabled)
  a.vision = Boolean(a.vision)
  a.monthlyLimitUsd = Math.max(0, Math.min(100000, Number(a.monthlyLimitUsd) || 0))
  a.think = a.kind === 'ollama' && Boolean(a.think)
  return a
}

function toView(a: AgentConfig, status?: AgentStatus): AgentView {
  const { apiKey, ...rest } = a
  return {
    ...rest,
    hasApiKey: apiKey.length > 0,
    apiKeyHint: apiKey.length > 8 ? `…${apiKey.slice(-4)}` : apiKey ? '…' : '',
    status: status ?? { lastOkAt: null, lastError: null, lastErrorAt: null },
    spentThisMonthUsd: a.kind === 'anthropic' ? Math.round(spentThisMonth(a.id) * 100) / 100 : 0,
  }
}

export function describeError(err: unknown): string {
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
