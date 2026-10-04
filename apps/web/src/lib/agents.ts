import { apiUrl, authHeaders } from './settings'

/** Client for the server's AI agent management API (see apps/server/src/agents.ts). */

export type AgentKind = 'anthropic' | 'ollama' | 'openai'
export type AiTask = 'handwriting' | 'images' | 'pdf' | 'compile'

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
  hasApiKey: boolean
  apiKeyHint: string
  status: { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null }
}

export interface AiSettings {
  routing: Record<AiTask, string[]>
  autoHandwriting: boolean
  autoImageText: boolean
}

export interface AgentsState {
  agents: Agent[]
  settings: AiSettings
  tasks: { id: AiTask; label: string }[]
}

export interface ProbeResult {
  ok: boolean
  message: string
  models: string[]
  warnings: string[]
}

/** Fields the user edits; apiKey is only sent when typed (blank keeps the saved one). */
export type AgentInput = Partial<Omit<Agent, 'hasApiKey' | 'apiKeyHint' | 'status'>> & { apiKey?: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Server error ${res.status}`)
  return json as T
}

export const DEFAULT_URLS: Record<AgentKind, string> = {
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://192.168.1.x:11434',
  openai: 'http://localhost:1234/v1',
}

export const KIND_LABELS: Record<AgentKind, string> = {
  anthropic: 'Claude (Anthropic API)',
  ollama: 'Ollama (local model)',
  openai: 'OpenAI-compatible (LM Studio, vLLM, OpenRouter…)',
}

export const TASK_HELP: Record<AiTask, string> = {
  handwriting: '“Convert to text” and automatic recognition that makes handwriting searchable. Needs a model that reads images.',
  images: 'Reads text in photos, screenshots and charts so search can find them. Needs a model that reads images.',
  pdf: 'Extracts text from attached PDFs for search. Only Claude agents can read PDFs.',
  compile: 'Turns a whole note into a clean document. A general model works best; OCR-only models do poorly here.',
}

export const agentsApi = {
  list: () => call<AgentsState>('GET', '/api/ai/agents'),
  create: (a: AgentInput) => call<AgentsState & { agent: Agent }>('POST', '/api/ai/agents', a),
  update: (id: string, a: AgentInput) => call<AgentsState & { agent: Agent }>('PUT', `/api/ai/agents/${id}`, a),
  remove: (id: string) => call<AgentsState>('DELETE', `/api/ai/agents/${id}`),
  updateSettings: (s: Partial<AiSettings>) => call<AgentsState>('PUT', '/api/ai/settings', s),
  probe: (a: AgentInput) => call<ProbeResult>('POST', '/api/ai/probe', a),
}
