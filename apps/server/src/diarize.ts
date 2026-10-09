import type { SpeakerSegment } from '@reconnotes/core'
import { hostOf } from './gpu'
import { log } from './log'
import { timeoutSignal } from './jobs'

/**
 * Who spoke when
 * ==============
 *
 * deploy/diarize.py, run next to the speech-to-text server, splits a recording
 * into turns by voice. ReconNotes looks for it on port 9402 of the speech
 * server's address – nothing to set up in the app. Without it, transcripts
 * simply have no speakers.
 */

export const DIARIZE_PORT = 9402

// a host without the service isn't asked again for a minute
const missing = new Map<string, number>()
/** Ask every host again (tests). */
export const forgetDiarizeHosts = () => missing.clear()

const base = (host: string) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${DIARIZE_PORT}`

/** Is the speaker-label service running at the speech server's address? */
export async function diarizeAvailable(speechUrl: string): Promise<boolean> {
  const host = hostOf(speechUrl)
  if (!host) return false
  const gone = missing.get(host)
  if (gone && Date.now() - gone < 60_000) return false
  try {
    const res = await fetch(`${base(host)}/`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) return missing.delete(host), true
  } catch {
    /* not there */
  }
  missing.set(host, Date.now())
  return false
}

/**
 * The recording's turns by voice, or null when there's no service (or it failed – the
 * transcript is then just without speakers). `most`: at most this many people spoke.
 */
export async function diarize(speechUrl: string, audio: Buffer, most = 0): Promise<SpeakerSegment[] | null> {
  if (!(await diarizeAvailable(speechUrl))) return null
  try {
    const res = await fetch(`${base(hostOf(speechUrl))}/diarize${most > 0 ? `?speakers=${most}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(audio),
      // about 5 s a minute of audio on a CPU; room for a long one on a slow machine
      signal: timeoutSignal(30 * 60_000),
    })
    const body = (await res.json().catch(() => ({}))) as { segments?: SpeakerSegment[]; speakers?: number; error?: string }
    if (!res.ok || !Array.isArray(body.segments)) {
      log.warn(`speaker labels failed: ${body.error ?? `answered ${res.status}`}`)
      return null
    }
    log.info(`speaker labels: ${body.speakers ?? '?'} voices, ${body.segments.length} turns`)
    return body.segments.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && Number.isInteger(s.speaker))
  } catch (e) {
    log.warn(`speaker labels failed: ${(e as Error).message}`)
    return null
  }
}
