import { apiUrl, authHeaders } from './settings'

/** Client for the server's AI agent management API (see apps/server/src/agents.ts). */

export type AgentKind = 'anthropic' | 'ollama' | 'openai' | 'wyoming'
export type AiTask = 'handwriting' | 'format' | 'images' | 'pdf' | 'compile' | 'audio' | 'embed'
export type ReadingMode = 'auto' | 'page' | 'lines'

export interface Agent {
  id: string
  name: string
  kind: AgentKind
  baseUrl: string
  model: string
  enabled: boolean
  vision: boolean
  timeoutSec: number
  prompt: string
  effort: 'low' | 'medium' | 'high'
  reading: ReadingMode
  hasApiKey: boolean
  apiKeyHint: string
  status: { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null }
}

export interface AiSettings {
  routing: Record<AiTask, string[]>
  autoHandwriting: boolean
  autoImageText: boolean
  autoAudio: boolean
}

export interface AgentsState {
  agents: Agent[]
  settings: AiSettings
  tasks: { id: AiTask; label: string }[]
}

export interface ModelInfo {
  id: string
  detail: string
  vision: boolean | null
}

export interface ProbeResult {
  ok: boolean
  message: string
  models: string[]
  warnings: string[]
}

/** Fields the user edits; apiKey is only sent when typed (blank keeps the saved one). */
export type AgentInput = Partial<Omit<Agent, 'hasApiKey' | 'apiKeyHint' | 'status'>> & { apiKey?: string }

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the server couldn't be reached */
    readonly status: number,
  ) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Testing can wait for a large local model to load into memory.
      signal: AbortSignal.timeout(path.endsWith('/try-handwriting') ? 10 * 60_000 : path.endsWith('/probe') ? 60_000 : 15_000),
    })
  } catch (e) {
    throw new ApiError((e as Error).name === 'TimeoutError' ? 'The server took too long to answer.' : "Couldn't reach the server.", 0)
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((json as { error?: string }).error ?? `Server error ${res.status}`, res.status)
  return json as T
}

export const DEFAULT_URLS: Record<AgentKind, string> = {
  anthropic: 'https://api.anthropic.com',
  ollama: '',
  openai: 'http://localhost:1234/v1',
  wyoming: '',
}

export const KIND_LABELS: Record<AgentKind, string> = {
  anthropic: 'Claude (Anthropic API)',
  ollama: 'Ollama (local model)',
  openai: 'OpenAI-compatible (LM Studio, vLLM, OpenRouter, Whisper servers…)',
  wyoming: 'Wyoming speech-to-text (Home Assistant Whisper)',
}

export const TASK_HELP: Record<AiTask, string> = {
  handwriting: '“Convert to text” and automatic recognition that makes handwriting searchable. Needs a model that reads images.',
  format:
    'After handwriting is recognised, a general model tidies it up: fixes misread words, joins split lines and keeps lists and headings. Use Claude or a general model (e.g. qwen2.5vl, llama3.1) – not an OCR-only model. Leave empty to skip.',
  images: 'Reads text in photos, screenshots and charts so search can find them. Needs a model that reads images.',
  pdf: 'Extracts text from attached PDFs for search. Only Claude agents can read PDFs.',
  compile: 'Turns a whole note into a clean document. A general model works best; OCR-only models do poorly here.',
  audio:
    '“Transcribe” on recordings and audio files, and background transcripts for search. Needs a speech-to-text server: a Home Assistant Wyoming Whisper server (e.g. wyoming-faster-whisper, port 10300), an OpenAI-compatible one (Speaches, whisper.cpp) or OpenAI (model whisper-1). Ollama and Claude can’t transcribe audio. The iPad app uses Apple’s recognition first.',
  embed:
    'Finds notes by meaning, not just matching words (“safety equipment” finds “safety glasses”), and helps “Ask your notes” find the right notes. Needs an embedding model, e.g. nomic-embed-text in Ollama (ollama pull nomic-embed-text – about 300 MB, fits beside your other models). Leave empty for word search only.',
}

export interface Vocab {
  words: string[]
  learned: { from: string; to: string; count: number; at: number }[]
}
export const vocabApi = {
  get: () => call<Vocab>('GET', '/api/ai/vocabulary'),
  setWords: (words: string[]) => call<Vocab>('PUT', '/api/ai/vocabulary', { words }),
  forget: (from: string, to: string) => call<Vocab>('POST', '/api/ai/vocabulary/forget', { from, to }),
}

/** Read all handwriting and pictures again for search (after changing models). */
export const rereadAll = () => call<{ drawings: number; pictures: number }>('POST', '/api/ai/reread')

export const agentsApi = {
  list: () => call<AgentsState>('GET', '/api/ai/agents'),
  create: (a: AgentInput) => call<AgentsState & { agent: Agent }>('POST', '/api/ai/agents', a),
  update: (id: string, a: AgentInput) => call<AgentsState & { agent: Agent }>('PUT', `/api/ai/agents/${id}`, a),
  remove: (id: string) => call<AgentsState>('DELETE', `/api/ai/agents/${id}`),
  updateSettings: (s: Partial<AiSettings>) => call<AgentsState>('PUT', '/api/ai/settings', s),
  probe: (a: AgentInput) => call<ProbeResult>('POST', '/api/ai/probe', a),
  models: (a: AgentInput) => call<{ models: ModelInfo[]; error: string | null }>('POST', '/api/ai/models', a),
  tryHandwriting: (a: AgentInput) =>
    call<{ ok: boolean; text: string; message: string; seconds: number }>('POST', '/api/ai/try-handwriting', a),
}
