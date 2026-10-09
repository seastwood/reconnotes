/**
 * A meeting read by meaning
 * =========================
 *
 * The embedding model behind search by meaning (e.g. nomic-embed-text) turns a
 * stretch of text into a vector: stretches about the same thing point the same
 * way. Used on a meeting's own transcript, three ways:
 *
 * - **Parts cut where the talk changes subject.** A long meeting is read in
 *   parts; cut at fixed lengths, a topic that runs across a cut is written up
 *   twice, in halves. Cut where one stretch stops resembling the next, each
 *   part holds whole topics.
 * - **What a point says, found where it was said** – even in other words
 *   ("switch to LEDs" for "put the new lights in"): the ▶ links, and…
 * - **…the check against inventions**: a point worded nothing like the
 *   transcript, but meaning what was said, is kept.
 *
 * Without an embedding model, all of this falls back to the words they share.
 */

/** texts → vectors: as a passage of what was said ('document'), or as what's looked for ('query') */
export type Embed = (texts: string[], as: 'document' | 'query') => Promise<number[][]>

export interface Stretch {
  /** where it is in the transcript (characters) */
  from: number
  to: number
  text: string
}

export const cosine = (a: number[], b: number[]) => {
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * (b[i] ?? 0)
    na += a[i] * a[i]
    nb += (b[i] ?? 0) * (b[i] ?? 0)
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0
}

const mean = (vs: number[][]) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)

/**
 * The transcript in stretches of about `size` characters (some 15 seconds of talk), each ending at
 * the end of a turn or a sentence – the places a part can be cut.
 */
export function stretches(text: string, size = 300): Stretch[] {
  const out: Stretch[] = []
  let from = 0
  while (from < text.length) {
    let to = Math.min(text.length, from + size)
    if (to < text.length) {
      // the next turn or sentence end after `size`
      const rest = text.slice(to)
      const turn = rest.indexOf('\n')
      const sentence = rest.search(/[.!?](\s|$)/)
      const cut = turn >= 0 && turn < 300 ? turn + 1 : sentence >= 0 && sentence < 300 ? sentence + 1 : -1
      to = cut >= 0 ? to + cut : to
    }
    const piece = text.slice(from, to)
    if (piece.trim()) out.push({ from, to, text: piece.trim() })
    from = to
  }
  return out
}

/**
 * Where to cut a long transcript into parts of about `size` characters: at the stretch boundaries
 * where the talk changes subject most – what was said just before resembles least what's said just
 * after – within reach of the length wanted (no part under 60% or over 140% of it).
 */
export function topicCuts(text: string, parts: Stretch[], vecs: number[][], size: number): number[] {
  // the talk on either side: a few stretches (about a minute), so one aside doesn't look like a new subject
  const k = 4
  // how much the subject changes at each boundary (before stretch i): 1 − likeness of the talk around it
  const change = parts.map((_, i) => {
    if (i < 1 || i >= parts.length) return 0
    const before = vecs.slice(Math.max(0, i - k), i)
    const after = vecs.slice(i, i + k)
    return 1 - cosine(mean(before), mean(after))
  })
  const cuts: number[] = []
  let start = 0
  while (text.length - start > size * 1.4) {
    let best = -1
    for (let i = 1; i < parts.length; i++) {
      const at = parts[i].from
      if (at < start + size * 0.6 || at > start + size * 1.4 || text.length - at < size * 0.5) continue
      // the biggest change of subject; among equals, nearest the length wanted
      const score = change[i] - Math.abs(at - start - size) / (size * 50)
      if (best < 0 || score > change[best] - Math.abs(parts[best].from - start - size) / (size * 50)) best = i
    }
    if (best < 0) break
    cuts.push(parts[best].from)
    start = parts[best].from
  }
  return cuts
}

/** The text cut at those places. */
export function cutAt(text: string, cuts: number[]): string[] {
  const out: string[] = []
  let from = 0
  for (const c of [...cuts, text.length]) {
    const piece = text.slice(from, c).trim()
    if (piece) out.push(piece)
    from = c
  }
  return out
}

/** A note's line, as what it says: no bullet, checkbox, bold label marks, ▶ links or due dates. */
export function pointText(line: string): string {
  return line
    .replace(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/\s*\[▶[^\]]*\]\(listen:[^)]*\)/g, '')
    .replace(/\s*!\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\*\*/g, '')
    .trim()
}

/**
 * Where a point is most like the transcript, and whether it stands out there: its best likeness,
 * and how far that is above its likeness to a typical stretch (the median). Embedding models
 * differ in how alike unrelated texts look (nomic's baseline is high), so both count: a vague
 * point ("discussed the project") is fairly like everything and stands out nowhere.
 */
export function peak(sims: number[]): { at: number; best: number; standsOut: number } {
  if (!sims.length) return { at: -1, best: 0, standsOut: 0 }
  let at = 0
  for (let i = 1; i < sims.length; i++) if (sims[i] > sims[at]) at = i
  const sorted = [...sims].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return { at, best: sims[at], standsOut: sims[at] - median }
}

/** said there, in other words: close enough, and standing out from the rest of the meeting */
export const isMeant = (sims: number[], best = 0.55, standsOut = 0.08) => {
  const p = peak(sims)
  return p.best >= best && (sims.length < 4 || p.standsOut >= standsOut)
}

/** How like each stretch each point is: for every point, its likeness to every stretch. */
export async function likeness(points: string[], stretchVecs: number[][], embed: Embed): Promise<number[][]> {
  if (!points.length || !stretchVecs.length) return points.map(() => [])
  const q = await embed(points, 'query')
  return q.map((v) => stretchVecs.map((s) => cosine(v, s)))
}
