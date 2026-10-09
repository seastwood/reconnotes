import { execFile } from 'node:child_process'

/**
 * GPU memory
 * ==========
 *
 * Ollama says how much of the GPU each of its models takes, but neither it
 * nor Speaches says how big the GPU is or how full. deploy/gpu-stats.py,
 * run on the machine with the GPU, answers that on port 9401; or, when the
 * GPU is in this machine, nvidia-smi does. Without either, the speech-to-text
 * models' share is estimated from their names, and the total is unknown.
 */

export const GPU_STATS_PORT = 9401

export interface GpuCard {
  name: string
  totalMb: number
  usedMb: number
}

/** the host part of an address ("http://192.168.1.20:11434/v1" → "192.168.1.20") */
export function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^tcp:/, 'http:')).hostname
  } catch {
    return ''
  }
}
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/

// a host without the monitor isn't asked again for a minute (no waiting on every check)
const missing = new Map<string, number>()

function parseCards(raw: unknown): GpuCard[] | null {
  const list = (raw as { gpus?: unknown })?.gpus
  if (!Array.isArray(list)) return null
  const cards = list
    .map((g) => g as { name?: unknown; totalMb?: unknown; usedMb?: unknown })
    .filter((g) => Number(g.totalMb) > 0)
    .map((g) => ({ name: String(g.name ?? 'GPU'), totalMb: Number(g.totalMb), usedMb: Number(g.usedMb) || 0 }))
  return cards.length ? cards : null
}

function localSmi(): Promise<GpuCard[] | null> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(null)
      const cards = out
        .trim()
        .split('\n')
        .map((l) => l.split(',').map((p) => p.trim()))
        .filter((p) => p.length >= 3 && Number(p[1]) > 0)
        .map(([name, total, used]) => ({ name, totalMb: Number(total), usedMb: Number(used) || 0 }))
      resolve(cards.length ? cards : null)
    })
  })
}

/** The GPU(s) at a host: its monitor, or nvidia-smi when the host is this machine. Null when nobody can say. */
export async function gpuAt(host: string): Promise<GpuCard[] | null> {
  if (!host) return null
  const gone = missing.get(host)
  if (gone && Date.now() - gone < 60_000) return null
  let cards: GpuCard[] | null = null
  try {
    const res = await fetch(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${GPU_STATS_PORT}/`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) cards = parseCards(await res.json())
  } catch {
    /* no monitor there */
  }
  if (!cards && LOCAL.test(host)) cards = await localSmi()
  if (cards) missing.delete(host)
  else missing.set(host, Date.now())
  return cards
}

/**
 * About how much GPU memory a speech-to-text model takes (MB), from its name – when nothing measures it.
 * Whisper sizes, with the room it needs to work; Speaches' voice detector, small but with its own GPU runtime.
 */
export function speechEstimateMb(model: string): number {
  const m = model.toLowerCase()
  // small, but run with its own GPU runtime (measured ~0.4 GB)
  if (/vad|silero/.test(m)) return 400
  if (/tiny/.test(m)) return 300
  if (/base/.test(m)) return 400
  if (/small/.test(m)) return 800
  if (/turbo|distil/.test(m)) return 1600
  if (/medium/.test(m)) return 1600
  if (/large/.test(m)) return 3200
  return 1000
}
