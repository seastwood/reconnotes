import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Wyoming protocol client
 * =======================
 *
 * Wyoming is the voice protocol Home Assistant uses (wyoming-faster-whisper,
 * wyoming-whisper-cpp…). It runs over plain TCP: every event is one line of
 * JSON (`type`, `data`, optional `data_length` / `payload_length`), followed
 * by the extra data and the binary payload (raw audio) if any.
 *
 * Speech to text: transcribe → audio-start → audio-chunk… → audio-stop, and
 * the server answers with a `transcript` event.
 */

export interface WyomingEvent {
  type: string
  data: Record<string, unknown>
  payload?: Buffer
}

export interface PcmAudio {
  pcm: Buffer
  rate: number
  width: number
  channels: number
}

/** "tcp://host:port", "host:port" or "host" (port 10300) → host and port. */
export function parseWyomingUri(uri: string): { host: string; port: number } {
  const m = /^(?:tcp:\/\/)?\[?([^\]/:]+)\]?(?::(\d+))?\/?$/.exec(uri.trim())
  if (!m) throw new Error(`"${uri}" isn't a Wyoming address – use tcp://<host>:<port>, e.g. tcp://192.168.1.20:10300`)
  return { host: m[1], port: m[2] ? Number(m[2]) : 10300 }
}

/** Splits the incoming byte stream into events. */
class EventReader {
  private buf = Buffer.alloc(0)
  push(chunk: Buffer): WyomingEvent[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: WyomingEvent[] = []
    for (;;) {
      const nl = this.buf.indexOf(0x0a)
      if (nl < 0) break
      const header = JSON.parse(this.buf.subarray(0, nl).toString('utf8')) as {
        type: string
        data?: Record<string, unknown>
        data_length?: number
        payload_length?: number
      }
      const dataLen = header.data_length ?? 0
      const payloadLen = header.payload_length ?? 0
      if (this.buf.length < nl + 1 + dataLen + payloadLen) break // wait for the rest
      let pos = nl + 1
      let data = header.data ?? {}
      if (dataLen) {
        data = { ...data, ...(JSON.parse(this.buf.subarray(pos, pos + dataLen).toString('utf8')) as Record<string, unknown>) }
        pos += dataLen
      }
      const payload = payloadLen ? Buffer.from(this.buf.subarray(pos, pos + payloadLen)) : undefined
      pos += payloadLen
      this.buf = this.buf.subarray(pos)
      out.push({ type: header.type, data, payload })
    }
    return out
  }
}

/**
 * Open a connection, send `events`, and resolve with the first event of type
 * `until` (rejects on timeout, connection errors or an `error` event).
 */
async function exchange(uri: string, events: WyomingEvent[], until: string, timeoutMs: number): Promise<WyomingEvent> {
  const { host, port } = parseWyomingUri(uri)
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const reader = new EventReader()
    let settled = false
    const finish = (err: Error | null, ev?: WyomingEvent) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(ev!)
    }
    const timer = setTimeout(() => finish(new Error(`no answer from ${host}:${port} after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') finish(new Error(`nothing is listening on ${host}:${port} – check the address and port of the Wyoming server`))
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') finish(new Error(`can't reach ${host} from the ReconNotes server`))
      else finish(err)
    })
    socket.on('close', () => finish(new Error(`${host}:${port} closed the connection without answering – is it a Wyoming speech-to-text server?`)))
    socket.on('data', (chunk) => {
      let evs: WyomingEvent[]
      try {
        evs = reader.push(chunk)
      } catch {
        return finish(new Error(`${host}:${port} doesn't speak the Wyoming protocol`))
      }
      for (const ev of evs) {
        if (ev.type === 'error') return finish(new Error(`Wyoming server error: ${String(ev.data.text ?? ev.data.code ?? 'unknown')}`))
        if (ev.type === until) return finish(null, ev)
      }
    })
    socket.on('connect', async () => {
      try {
        for (const ev of events) {
          const header: Record<string, unknown> = { type: ev.type, data: ev.data }
          if (ev.payload) header.payload_length = ev.payload.length
          const ok = socket.write(JSON.stringify(header) + '\n')
          const ok2 = ev.payload ? socket.write(ev.payload) : true
          if (!ok || !ok2) await new Promise((r) => socket.once('drain', r))
          if (settled) return
        }
      } catch (err) {
        finish(err as Error)
      }
    })
  })
}

export interface WyomingInfo {
  /** speech-to-text programs and their models */
  asr: { name: string; models: { name: string; languages: string[] }[] }[]
}

/** Ask the server what it offers (used by "Test connection" and the model list). */
export async function wyomingDescribe(uri: string, timeoutMs = 10_000): Promise<WyomingInfo> {
  const ev = await exchange(uri, [{ type: 'describe', data: {} }], 'info', timeoutMs)
  const asr = (ev.data.asr as { name?: string; models?: { name?: string; languages?: string[] }[] }[] | undefined) ?? []
  return {
    asr: asr.map((a) => ({
      name: String(a.name ?? 'asr'),
      models: (a.models ?? []).map((m) => ({ name: String(m.name ?? ''), languages: m.languages ?? [] })),
    })),
  }
}

/** Speech to text: stream the audio (1-second chunks) and wait for the transcript. */
export async function wyomingTranscribe(uri: string, audio: PcmAudio, opts: { model?: string; language?: string; timeoutMs: number }): Promise<string> {
  const fmt = { rate: audio.rate, width: audio.width, channels: audio.channels }
  const chunkBytes = audio.rate * audio.width * audio.channels
  const events: WyomingEvent[] = [
    { type: 'transcribe', data: { ...(opts.model ? { name: opts.model } : {}), ...(opts.language ? { language: opts.language } : {}) } },
    { type: 'audio-start', data: { ...fmt, timestamp: 0 } },
  ]
  for (let i = 0; i < audio.pcm.length; i += chunkBytes) {
    events.push({ type: 'audio-chunk', data: { ...fmt, timestamp: Math.round((i / chunkBytes) * 1000) }, payload: audio.pcm.subarray(i, i + chunkBytes) })
  }
  events.push({ type: 'audio-stop', data: { timestamp: Math.round((audio.pcm.length / chunkBytes) * 1000) } })
  const ev = await exchange(uri, events, 'transcript', opts.timeoutMs)
  return String(ev.data.text ?? '').trim()
}

/**
 * Wyoming takes raw audio. Plain 16-bit WAV files are read directly; anything
 * else (m4a recordings from iPhone/iPad, WebM from Chrome, mp3…) is
 * converted to 16 kHz mono with ffmpeg.
 */
export async function toPcm(data: Buffer, mime: string): Promise<PcmAudio> {
  const wav = readWav(data)
  if (wav) return wav
  const tmp = path.join(os.tmpdir(), `reconnotes-audio-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(tmp, data)
  try {
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'])
      const out: Buffer[] = []
      let err = ''
      ff.stdout.on('data', (c: Buffer) => out.push(c))
      ff.stderr.on('data', (c: Buffer) => (err += c.toString()))
      ff.on('error', (e: NodeJS.ErrnoException) =>
        reject(e.code === 'ENOENT' ? new Error('ffmpeg is needed to send recordings to a Wyoming server – install it on the ReconNotes server: sudo apt install ffmpeg') : e),
      )
      ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`couldn't decode the ${mime || 'audio'} file: ${err.trim().slice(0, 200)}`))))
    })
    return { pcm, rate: 16000, width: 2, channels: 1 }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** 16-bit PCM WAV → its samples and format; null for anything else. */
export function readWav(data: Buffer): PcmAudio | null {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null
  let pos = 12
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  while (pos + 8 <= data.length) {
    const id = data.toString('ascii', pos, pos + 4)
    const size = data.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') fmt = { format: data.readUInt16LE(body), channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return null
      return { pcm: data.subarray(body, Math.min(data.length, body + size)), rate: fmt.rate, width: 2, channels: fmt.channels }
    }
    pos = body + size + (size % 2)
  }
  return null
}
