import type { AgentConfig, AgentRegistry } from './agents'
import { observeOllama, speechLoaded, spentThisMonth } from './agents'
import { wyomingDescribe } from './wyoming'
import { gpuAt, hostOf, speechEstimateMb } from './gpu'
import type { Jobs } from './jobs'

/**
 * AI health
 * =========
 *
 * A quick look at whether each AI agent can be reached right now, and – for
 * Ollama – which models are loaded and how much GPU memory they take, so you
 * can see at a glance why something is slow or failing.
 */

export interface AgentHealth {
  id: string
  name: string
  kind: AgentConfig['kind']
  model: string
  enabled: boolean
  /** reachable now (null: not checked – e.g. Claude, which costs nothing to leave alone) */
  ok: boolean | null
  error: string | null
  /** how long the check took */
  ms: number | null
  /** Ollama: this agent's model is loaded in memory now */
  loaded?: boolean
  /** Claude: spent this month (US$) */
  spentUsd?: number
}

export interface OllamaHealth {
  url: string
  host: string
  ok: boolean
  version: string | null
  /** models in memory now, with their GPU memory (MB) */
  loaded: { name: string; vramMb: number; sizeMb: number; until: string | null }[]
}

export interface Health {
  checkedAt: number
  agents: AgentHealth[]
  ollama: OllamaHealth[]
  /** speech-to-text models in memory (Speaches): they take GPU memory the language models then lack */
  speech: SpeechLoaded[]
  /** the GPUs, where something can say how big and how full they are (deploy/gpu-stats.py, or nvidia-smi here) */
  gpus: GpuHealth[]
  queue: { running: number; queued: number; paused: number; waitingToRetry: number }
  /** one line for the app to show */
  summary: string
  status: 'ok' | 'degraded' | 'down' | 'none'
}

export interface SpeechLoaded {
  agent: string
  model: string
  host: string
  /** GPU memory it takes (MB): measured (the GPU's use less Ollama's), else estimated from its name */
  mb: number
  measured: boolean
}

export interface GpuHealth {
  host: string
  name: string
  totalMb: number
  usedMb: number
  /** used by something other than Ollama's models and the speech models listed (other programs, the driver) */
  otherMb: number
}

const trim = (u: string) => u.replace(/\/+$/, '')

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t = Date.now()
  try {
    return { value: await fn(), ms: Date.now() - t }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    return { error: err.cause?.code === 'ECONNREFUSED' ? 'connection refused' : err.name === 'TimeoutError' ? 'no answer (timed out)' : err.message, ms: Date.now() - t }
  }
}

let cache: { at: number; value: Health } | null = null

export async function aiHealth(agents: AgentRegistry, jobs: Jobs, fresh = false): Promise<Health> {
  if (!fresh && cache && Date.now() - cache.at < 10_000) return cache.value
  const all = agents.agents()
  const signal = () => AbortSignal.timeout(3000)

  // each Ollama server once: its version and loaded models
  const servers = [...new Set(all.filter((a) => a.kind === 'ollama' && a.enabled).map((a) => trim(a.baseUrl)))]
  const ollama: OllamaHealth[] = await Promise.all(
    servers.map(async (url) => {
      const v = await timed(async () => ((await (await fetch(`${url}/api/version`, { signal: signal() })).json()) as { version?: string }).version ?? null)
      if (v.error !== undefined) return { url, host: hostOf(url), ok: false, version: null, loaded: [] }
      const ps = await timed(async () => (await (await fetch(`${url}/api/ps`, { signal: signal() })).json()) as { models?: { name: string; size: number; size_vram: number; expires_at?: string }[] })
      if (ps.value?.models) observeOllama(url, ps.value.models)
      const loaded = (ps.value?.models ?? []).map((m) => ({ name: m.name, vramMb: Math.round((m.size_vram ?? 0) / 1048576), sizeMb: Math.round((m.size ?? 0) / 1048576), until: m.expires_at ?? null }))
      return { url, host: hostOf(url), ok: true, version: v.value ?? null, loaded }
    }),
  )
  const byUrl = new Map(ollama.map((o) => [o.url, o]))
  // what the speech-to-text servers have in memory (Speaches says; others can't)
  const speechAgents = all.filter((a) => a.enabled && a.kind === 'openai' && agents.chain('audio').some((c) => c.id === a.id))
  const speech: SpeechLoaded[] = (
    await Promise.all(speechAgents.map(async (a) => ((await speechLoaded(a)) ?? []).map((model) => ({ agent: a.name, model, host: hostOf(a.baseUrl), mb: speechEstimateMb(model), measured: false }))))
  ).flat()

  // each GPU's size and use, where its machine can say; what Ollama doesn't account for is the speech models' (and the rest)
  const hosts = [...new Set([...ollama.filter((o) => o.ok).map((o) => o.host), ...speech.map((m) => m.host)].filter(Boolean))]
  const gpus: GpuHealth[] = []
  for (const host of hosts) {
    const cards = await gpuAt(host)
    if (!cards) continue
    const totalMb = cards.reduce((a, c) => a + c.totalMb, 0)
    const usedMb = cards.reduce((a, c) => a + c.usedMb, 0)
    const ollamaMb = ollama.filter((o) => o.host === host).flatMap((o) => o.loaded).reduce((a, m) => a + m.vramMb, 0)
    let rest = Math.max(0, usedMb - ollamaMb)
    // the small ones (the voice detector) as estimated; the rest is Whisper's
    const here = speech.filter((m) => m.host === host).sort((a, b) => a.mb - b.mb)
    here.forEach((m, i) => {
      const share = i === here.length - 1 ? rest : Math.min(m.mb, rest)
      m.mb = share
      m.measured = true
      rest -= share
    })
    gpus.push({ host, name: cards.length > 1 ? cards.map((c) => c.name).join(' + ') : cards[0].name, totalMb, usedMb, otherMb: rest })
  }

  const agentHealth: AgentHealth[] = await Promise.all(
    all.map(async (a): Promise<AgentHealth> => {
      const base = { id: a.id, name: a.name, kind: a.kind, model: a.model, enabled: a.enabled }
      if (!a.enabled) return { ...base, ok: null, error: null, ms: null }
      if (a.kind === 'ollama') {
        const o = byUrl.get(trim(a.baseUrl))
        const loaded = Boolean(o?.loaded.some((m) => m.name === a.model || m.name === `${a.model}:latest` || m.name.split(':')[0] === a.model))
        return { ...base, ok: Boolean(o?.ok), error: o?.ok ? null : `can't reach Ollama at ${a.baseUrl}`, ms: null, loaded }
      }
      if (a.kind === 'openai') {
        const r = await timed(async () => {
          const res = await fetch(`${trim(a.baseUrl)}/models`, { headers: a.apiKey ? { Authorization: `Bearer ${a.apiKey}` } : {}, signal: signal() })
          if (res.status >= 500) throw new Error(`answered ${res.status}`)
        })
        return { ...base, ok: r.error === undefined, error: r.error ?? null, ms: r.ms }
      }
      if (a.kind === 'wyoming') {
        const r = await timed(() => wyomingDescribe(a.baseUrl, 3000))
        return { ...base, ok: r.error === undefined, error: r.error ?? null, ms: r.ms }
      }
      // Claude: not pinged; its limit is what can stop it
      const spent = spentThisMonth(a.id)
      const over = Boolean(a.monthlyLimitUsd && spent >= a.monthlyLimitUsd)
      return { ...base, ok: over ? false : null, error: over ? 'monthly spending limit reached' : null, ms: null, spentUsd: Math.round(spent * 100) / 100 }
    }),
  )

  const c = jobs.counts()
  const waitingToRetry = jobs.list(0).filter((j) => j.retryAt).length
  const enabled = agentHealth.filter((a) => a.enabled)
  const down = enabled.filter((a) => a.ok === false)
  const status: Health['status'] = !enabled.length ? 'none' : down.length === 0 ? 'ok' : down.length === enabled.length ? 'down' : 'degraded'
  const loadedNames = ollama.flatMap((o) => o.loaded.map((m) => m.name))
  const summary =
    status === 'none'
      ? 'No AI agents set up'
      : status === 'down'
        ? `AI unreachable: ${down.map((a) => a.name).join(', ')}`
        : status === 'degraded'
          ? `${down.map((a) => a.name).join(', ')} unreachable – others working`
          : `AI ready${loadedNames.length ? ` · loaded: ${loadedNames.join(', ')}` : ''}`
  const value: Health = { checkedAt: Date.now(), agents: agentHealth, ollama, speech, gpus, queue: { ...c, waitingToRetry }, summary, status }
  cache = { at: Date.now(), value }
  return value
}
