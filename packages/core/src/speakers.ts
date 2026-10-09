/**
 * Who said what
 * =============
 *
 * The speaker-label service (deploy/diarize.py) splits a recording into turns
 * by voice: "speaker 0 from 0.3 s to 6.9 s, speaker 1…". Put together with
 * Whisper's word times, every word gets its speaker, and the transcript
 * becomes turns – "Jesse: …", "Speaker 2: …". The voices are numbered in the
 * order they first speak; you give them names (kept per recording, in the
 * note).
 */

export interface SpeakerSegment {
  start: number
  end: number
  speaker: number
}

export interface SpeakerTurn {
  speaker: number
  start: number
  end: number
  /** the words said in the turn, as Whisper wrote them */
  text: string
}

/** the note's keys for a recording's speaker turns, and the names you gave its voices */
export const speakersKey = (attachmentId: string) => `speakers:att:${attachmentId}`
export const speakerNamesKey = (attachmentId: string) => `names:att:${attachmentId}`

/** "[[start,end,speaker],…]" – compact, as kept in the note */
export function encodeSpeakers(segments: SpeakerSegment[]): string {
  return JSON.stringify(segments.map((s) => [Math.round(s.start * 100) / 100, Math.round(s.end * 100) / 100, s.speaker]))
}

export function parseSpeakers(text: string | null | undefined): SpeakerSegment[] | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) return null
    const out = raw
      .filter((r): r is [number, number, number] => Array.isArray(r) && r.length >= 3 && r.every((n) => typeof n === 'number' && Number.isFinite(n)))
      .map(([start, end, speaker]) => ({ start, end, speaker }))
    return out.length ? out : null
  } catch {
    return null
  }
}

/** The names you gave a recording's voices ({ "0": "Jesse" }). */
export function parseSpeakerNames(text: string | null | undefined): Record<number, string> {
  if (!text) return {}
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const out: Record<number, string> = {}
    for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'string' && v.trim() && /^\d+$/.test(k)) out[Number(k)] = v.trim()
    return out
  } catch {
    return {}
  }
}

export const speakerName = (names: Record<number, string>, speaker: number) => names[speaker] || `Speaker ${speaker + 1}`

/** The speaker of the moment `t`: the turn it falls in, else the nearest one (within a second). */
export function speakerAt(segments: SpeakerSegment[], t: number, end = t): number | null {
  let best: { speaker: number; d: number } | null = null
  for (const s of segments) {
    // overlap of [t, end] with the turn (a word inside it wins)
    const overlap = Math.min(end, s.end) - Math.max(t, s.start)
    const d = overlap >= 0 ? -overlap : Math.min(Math.abs(t - s.end), Math.abs(s.start - end))
    if (!best || d < best.d) best = { speaker: s.speaker, d }
  }
  return best && best.d <= 1 ? best.speaker : null
}

/**
 * Whisper's words, grouped into turns by who said them. A word between turns (a pause, an
 * overlap the service didn't catch) stays with the speaker before it.
 */
export function speakerTurns(words: { word: string; start: number; end: number }[], segments: SpeakerSegment[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = []
  let last: number | null = null
  for (const w of words) {
    const who: number = speakerAt(segments, w.start, w.end) ?? last ?? segments[0]?.speaker ?? 0
    const cur = turns[turns.length - 1]
    if (cur && cur.speaker === who) {
      cur.text += ` ${w.word}`
      cur.end = w.end
    } else turns.push({ speaker: who, start: w.start, end: w.end, text: w.word })
    last = who
  }
  for (const t of turns) t.text = t.text.replace(/\s+/g, ' ').trim()
  return turns.filter((t) => t.text)
}

/** The transcript as turns, a line each: "Jesse: …" / "Speaker 2: …". */
export function labelledTranscript(turns: SpeakerTurn[], names: Record<number, string> = {}): string {
  return turns.map((t) => `${speakerName(names, t.speaker)}: ${t.text}`).join('\n')
}

/** How many different voices spoke. */
export const voiceCount = (turns: SpeakerTurn[]) => new Set(turns.map((t) => t.speaker)).size
