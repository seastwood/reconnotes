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

/**
 * Voices heard for only a few seconds – a cough, a word from someone passing, two people at
 * once – are usually not real extra people, and a "Speaker 8" confuses who said what. Each of
 * their turns goes to the voice speaking around it (the longer neighbour); then the voices are
 * numbered again in the order they first speak. A voice counts as real with at least `minSeconds`
 * of speech, or `minShare` of all of it.
 */
export function mergeMinorVoices(segments: SpeakerSegment[], minSeconds = 8, minShare = 0.02): SpeakerSegment[] {
  if (!segments.length) return segments
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const talk = new Map<number, number>()
  for (const s of sorted) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start))
  const total = [...talk.values()].reduce((a, b) => a + b, 0)
  const real = new Set([...talk].filter(([, t]) => t >= minSeconds || t >= total * minShare).map(([v]) => v))
  // nobody spoke long enough to count (a short clip): leave it as it is
  if (!real.size || real.size === talk.size) return renumber(sorted)
  const out = sorted.map((s) => ({ ...s }))
  for (let i = 0; i < out.length; i++) {
    if (real.has(out[i].speaker)) continue
    // the nearest real voice before and after it
    let before = i - 1
    while (before >= 0 && !real.has(out[before].speaker)) before--
    let after = i + 1
    while (after < out.length && !real.has(out[after].speaker)) after++
    const b = before >= 0 ? out[before] : null
    const n = after < out.length ? out[after] : null
    const gap = (x: SpeakerSegment | null) => (x ? Math.max(0, x.start > out[i].start ? x.start - out[i].end : out[i].start - x.end) : Infinity)
    const pick = !n || (b && (gap(b) < gap(n) || (gap(b) === gap(n) && b.end - b.start >= n.end - n.start))) ? b : n
    if (pick) out[i].speaker = pick.speaker
  }
  // a voice's turns that now run on into each other: one turn
  const merged: SpeakerSegment[] = []
  for (const s of out) {
    const last = merged[merged.length - 1]
    if (last && last.speaker === s.speaker && s.start - last.end <= 1) last.end = Math.max(last.end, s.end)
    else merged.push(s)
  }
  return renumber(merged)
}

/** Voices numbered 0, 1, 2… in the order they first speak. */
function renumber(segments: SpeakerSegment[]): SpeakerSegment[] {
  const order = new Map<number, number>()
  return segments.map((s) => {
    if (!order.has(s.speaker)) order.set(s.speaker, order.size)
    return { ...s, speaker: order.get(s.speaker)! }
  })
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

const attendeesLine = (notes: string) => notes.match(/^\s*(?:[-*]\s*)?(?:\*\*)?attendees(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/im)?.[1] ?? ''
/** "6 people", "– 6 people", "(6 people)", "+ 4 others" on the Attendees line: how many, not who */
const COUNT = /\s*[–—-]?\s*\(?\s*(\+\s*)?(\d{1,2})\s*(?:people|persons|others?|more)\s*\)?/i

/** The people listed on the note's "Attendees:" line ("Seth, Jesse and Paul"). */
export function attendeeNames(notes: string): string[] {
  const line = attendeesLine(notes).replace(COUNT, '')
  return [
    ...new Set(
      line
        .split(/\s*(?:,|;|\band\b|&|\/)\s*/i)
        .map((n) => n.replace(/[*_[\]()]/g, '').trim())
        .filter((n) => n && n.length <= 40 && /\p{L}/u.test(n)),
    ),
  ].slice(0, 30)
}

/**
 * How many people were at the meeting, from its "Attendees:" line: the names listed, or the number
 * given ("Attendees: 6 people", "Attendees: Seth, Jesse – 6 people", "Seth, Jesse + 4 others"). 0:
 * not said. Speaker labels find at most this many voices.
 */
export function attendeeCount(notes: string): number {
  const names = attendeeNames(notes).length
  const m = attendeesLine(notes).match(COUNT)
  if (!m) return names
  const n = Number(m[2])
  return m[1] ? names + n : Math.max(names, n)
}

/** The Attendees line for these names and/or a number of people ("Seth, Jesse – 6 people", "6 people"). */
export function attendeesText(names: string[], count = 0): string {
  const list = names.join(', ')
  if (!count || count <= names.length) return list
  return list ? `${list} – ${count} people` : `${count} people`
}
