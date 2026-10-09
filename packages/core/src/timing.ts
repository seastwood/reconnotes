/**
 * Following a recording's transcript as it plays
 * ===============================================
 *
 * Whisper says when each word was said. Those words are laid onto the
 * transcript's own text (which can differ a little – punctuation, a repeat
 * taken out), so the word being said can be highlighted, and tapping a word
 * plays from there.
 */

/** Transcripts-map key holding a recording's word times (JSON: `{ v: 1, w: [word, start, end][] }`, hundredths of a second). */
export const timingKey = (attachmentId: string) => `timing:att:${attachmentId}`

/** Transcripts-map key naming who transcribed a recording ("faster-whisper-large-v3-turbo", Apple's…). */
export const heardByKey = (attachmentId: string) => `by:att:${attachmentId}`

export interface TimedWord {
  word: string
  /** seconds */
  start: number
  end: number
}

export function parseWordTimes(json: string | null | undefined): TimedWord[] | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as { v?: number; w?: [string, number, number][] }
    if (p?.v !== 1 || !Array.isArray(p.w)) return null
    return p.w.filter((x) => Array.isArray(x) && typeof x[0] === 'string').map(([word, s, e]) => ({ word, start: s / 100, end: e / 100 }))
  } catch {
    return null
  }
}

/** A word of the transcript's text: where it is (characters) and when it's said (seconds). */
export interface TimedSpan {
  from: number
  to: number
  start: number
  end: number
}

/** Word times as they're kept (see `timingKey`); null when they don't look real. */
export function encodeWordTimes(words: TimedWord[] | null | undefined): string | null {
  const ok = plausibleWordTimes(words)
  return ok ? JSON.stringify({ v: 1, w: ok.map((x) => [x.word, Math.round(x.start * 100), Math.round(x.end * 100)]) }) : null
}

/**
 * Times that can be followed: words with times that mostly go forward and
 * aren't all at the start (a recogniser that gives no real times reports 0s).
 */
export function plausibleWordTimes(words: TimedWord[] | null | undefined): TimedWord[] | null {
  const ws = (words ?? []).filter((w) => w && typeof w.word === 'string' && w.word.trim() && Number.isFinite(w.start) && Number.isFinite(w.end)).map((w) => ({ word: w.word.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }))
  if (ws.length < 2) return null
  const forward = ws.slice(1).filter((w, i) => w.start >= ws[i].start).length / (ws.length - 1)
  const timed = ws.filter((w) => w.start > 0).length / ws.length
  return forward >= 0.9 && timed >= 0.5 ? ws : null
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The transcript's words, each with its time: timed words matched in order to
 * the words of the text, skipping a few on either side where they differ.
 * A word with no match gets the time of the one before it.
 */
export function alignWordTimes(text: string, words: TimedWord[]): TimedSpan[] {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ from: m.index!, to: m.index! + m[0].length, key: norm(m[0]) }))
  const keys = words.map((w) => norm(w.word))
  const out: TimedSpan[] = []
  let j = 0
  let last: { start: number; end: number } | null = null
  for (const t of tokens) {
    let hit = -1
    if (t.key)
      for (let k = j; k < Math.min(keys.length, j + 6); k++)
        if (keys[k] === t.key || (keys[k] && (t.key.startsWith(keys[k]) || keys[k].startsWith(t.key)) && Math.min(keys[k].length, t.key.length) >= 3)) {
          hit = k
          break
        }
    if (hit >= 0) {
      last = { start: words[hit].start, end: words[hit].end }
      j = hit + 1
    }
    if (last) out.push({ from: t.from, to: t.to, start: last.start, end: last.end })
  }
  return out
}

/** The span being said at `time` (seconds): the last one started by then. */
export function spanAt(spans: TimedSpan[], time: number): number {
  let lo = 0
  let hi = spans.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].start <= time + 0.05) (at = mid), (lo = mid + 1)
    else hi = mid - 1
  }
  return at
}
