/**
 * Sections of long notes
 * ======================
 *
 * A manual imported as notes has pages of many rules each. To answer a
 * question from it, the right *section* matters more than the right page: a
 * note is split at its headings (long sections at their paragraphs), each
 * section is scored against the question, and the best few – from any of
 * the notes – are what the AI reads and cites, by section.
 *
 * Rule numbers (G301, R104, H203…) count most: a question naming one always
 * gets the section that defines it.
 */

export interface Section {
  noteId: string
  /** the headings it's under, outermost first ("6 Game Rules › 6.4 Scoring") */
  path: string[]
  text: string
  /** where it is in the note's Markdown (for keeping a note's sections in order) */
  index: number
}

const STEM = (w: string) => (w.length > 5 ? w.slice(0, w.length - 2) : w)

/** Rule numbers in a text: G301, R104, H203, SG12… (letters then 2–4 digits, as one word). */
export const RULE_ID = /\b([A-Z]{1,3})(\d{2,4})\b/g

/** The rule numbers a question asks about ("what is g301" → G301). */
export function ruleIds(question: string): string[] {
  return [...new Set([...question.matchAll(/\b([a-z]{1,3})[- ]?(\d{2,4})\b/gi)].filter((m) => /[a-z]/i.test(m[1]) && !/^(am|pm|th|st|nd|rd|kg|lb|mm|cm|in|ft|v|a|w|hz)$/i.test(m[1])).map((m) => `${m[1].toUpperCase()}${m[2]}`))]
}

/** Where a rule is written as the start of its own line, heading or bold lead-in – its definition. */
export function definesRule(text: string, id: string): boolean {
  return new RegExp(`(^|\\n)\\s*(?:#{1,6}\\s*|[-*]\\s+|\\*\\*|\\*|>\\s*)*${id}\\b`).test(text)
}

const MAX = 1800

/** A note's Markdown in sections: at each heading; a long section at its paragraphs. */
export function splitSections(noteId: string, title: string, md: string): Section[] {
  const out: Section[] = []
  const stack: { level: number; text: string }[] = []
  let cur: string[] = []
  let path: string[] = []
  let index = 0
  const push = () => {
    const text = cur.join('\n').trim()
    cur = []
    if (!text.replace(/^#{1,6}\s.*$/gm, '').trim() && !out.length && text) {
      // only a heading (the title): it leads the next section instead
      cur = [text]
      return
    }
    if (!text) return
    if (text.length <= MAX) {
      out.push({ noteId, path, text, index: index++ })
      return
    }
    // too long: at its paragraphs, each piece knowing its heading
    const head = /^#{1,6}\s.*$/m.exec(text)?.[0]
    let piece = ''
    for (const para of text.split(/\n\s*\n/)) {
      if (piece && piece.length + para.length > MAX) {
        out.push({ noteId, path, text: piece.trim(), index: index++ })
        piece = head && !piece.startsWith(head) ? `${head} (continued)\n\n` : ''
      }
      piece += para + '\n\n'
    }
    if (piece.trim()) out.push({ noteId, path, text: piece.trim(), index: index++ })
  }
  for (const line of md.split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      push()
      const level = h[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: h[2].replace(/[*_`[\]]/g, '').trim() })
      path = stack.map((s) => s.text).filter((t) => t && t !== title)
    }
    cur.push(line)
  }
  push()
  return out
}

/**
 * Words a manual says the same thing with: "max height" is "no taller than",
 * "size" a "sizing box". A question word matches any of its group.
 */
const GROUPS: string[][] = [
  ['height', 'tall', 'taller', 'tallest', 'high', 'vertical'],
  ['width', 'wide', 'wider'],
  ['length', 'long', 'longer'],
  ['max', 'maximum', 'exceed', 'exceeds', 'limit', 'larger than', 'no more than', 'up to', 'no taller', 'no larger'],
  ['min', 'minimum', 'least', 'fewer than', 'at least'],
  ['size', 'sizes', 'sizing', 'dimension', 'footprint', 'volume', 'fit within', 'fits within', 'starting configuration'],
  ['weight', 'weigh', 'weighs', 'heavy', 'heavier', 'mass', 'lbs', 'pounds', 'kg'],
  ['robot', 'robots'],
  ['time', 'duration', 'seconds', 'minutes', 'timer'],
  ['cost', 'costs', 'price', 'budget', 'spend'],
  ['score', 'scoring', 'scored', 'points', 'point'],
  ['penalty', 'penalties', 'foul', 'fouls', 'violation'],
  ['start', 'starting', 'begin', 'beginning'],
  ['allowed', 'legal', 'permitted', 'prohibited', 'illegal', 'must not'],
  ['battery', 'batteries', 'power'],
  ['motor', 'motors', 'actuator', 'actuators'],
]
const GROUP_OF = new Map(GROUPS.flatMap((g) => g.filter((w) => !w.includes(' ')).map((w) => [w, g] as const)))
/** A question word and the words that mean the same in a manual. */
export const variantsOf = (t: string): string[] => GROUP_OF.get(t) ?? GROUP_OF.get(t.replace(/s$/, '')) ?? [t]
/** A word (or phrase) in lower-case text: at the start of a word; a long word by its stem. */
const holds = (low: string, t: string) =>
  t.includes(' ') ? low.includes(t) : t.length > 5 ? low.includes(STEM(t)) : new RegExp(`(^|[^\\p{L}\\p{N}])${t}`, 'u').test(low)
/** Any of the words that mean the same. */
const holdsAny = (low: string, t: string) => variantsOf(t).some((v) => holds(low, v))

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

export interface Scored extends Section {
  score: number
}

/**
 * Score sections against the question's words (rarer words count more; in
 * a heading, more again), its rule numbers, the meaning search's best
 * passages, and how highly their note ranked.
 */
export function scoreSections(
  sections: Section[],
  words: string[],
  rules: string[],
  opts: { noteRank?: Map<string, number>; passages?: { noteId: string; score: number; passage: string }[] } = {},
): Scored[] {
  const terms = [...new Set(words.filter((w) => w.length >= 3))]
  const lows = sections.map((s) => s.text.toLowerCase())
  const has = holdsAny
  const df = new Map(terms.map((t) => [t, lows.filter((l) => has(l, t)).length]))
  const n = sections.length || 1
  return sections.map((s, i) => {
    const low = lows[i]
    const head = s.path.join(' ').toLowerCase() + ' ' + (/^#{1,6}\s.*$/m.exec(s.text)?.[0] ?? '').toLowerCase()
    let score = 0
    for (const t of terms) {
      if (!has(low, t)) continue
      const idf = Math.log(1 + n / (df.get(t) || 1))
      score += idf * (has(head, t) ? 1.6 : 1)
    }
    // two of the question's words side by side: a phrase it's about
    const own = wordsOf(low)
    for (let k = 0; k + 1 < terms.length; k++) if (own.some((w, j) => w.startsWith(STEM(terms[k])) && own[j + 1]?.startsWith(STEM(terms[k + 1])))) score += 0.8
    for (const r of rules) {
      if (definesRule(s.text, r)) score += 12
      else if (new RegExp(`\\b${r}\\b`).test(s.text)) score += 3
    }
    // the meaning search's passages: a section holding one is about the question
    for (const p of opts.passages ?? []) {
      if (p.noteId !== s.noteId) continue
      const pw = wordsOf(p.passage.replace(/^[^:\n]{0,120}:\s/, '')).filter((w) => w.length >= 4)
      if (pw.length < 3) continue
      const inside = pw.filter((w) => low.includes(w)).length / pw.length
      if (inside >= 0.7) score += 4 * p.score
    }
    // a note the search ranked higher: a little extra, so ties go its way
    const rank = opts.noteRank?.get(s.noteId)
    if (rank !== undefined) score += 1 / (2 + rank)
    return { ...s, score }
  })
}

/** A line of Markdown as it reads in the note (no markers, link targets or formatting). */
const plainLine = (t: string) =>
  t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!\d{4}-\d{2}-\d{2}\S*/g, '')
    .replace(/\s*\[[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}[^\]]*\]/g, '')
    .replace(/[*_`~|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A note's lines as the find bar can match them: a table row is cells apart
 * in the note (text can't be found across them), so each cell is a line.
 */
function findableLines(text: string): string[] {
  return text.split('\n').flatMap((l) =>
    /^\s*\|/.test(l)
      ? l
          .split('|')
          .filter((c) => c.trim() && !/^[\s:-]+$/.test(c))
          // a list in a cell ("- one - two"): each item is a paragraph of its own in the note
          .flatMap((c) => c.split(/\s+-\s+(?=[\p{Lu}(\d])|<br\s*\/?>/u))
      : [l],
  )
}

/**
 * Where in a note (or section) the answer to a question is: a few words of
 * the line that has the most of the question's words (or its rule number) –
 * what the find bar looks for when the source is opened, so it lands there.
 */
export function findIn(text: string, words: string[], rules: string[] = []): string | null {
  const terms = [...new Set(words.filter((w) => w.length >= 3))]
  let best: { line: string; score: number } | null = null
  let first = true
  for (const raw of findableLines(text)) {
    const line = plainLine(raw)
    if (line.length < 4) continue
    const low = line.toLowerCase()
    let score = terms.filter((t) => holdsAny(low, t)).length
    if (rules.some((r) => new RegExp(`\\b${r}\\b`).test(line))) score += definesRuleLine(raw, rules) ? 5 : 2
    // the note's title (its first line) only when nothing below it says as much
    if (score && first) score -= 0.5
    first = false
    if (score > 0 && (!best || score > best.score)) best = { line, score }
  }
  if (!best) return null
  // a few words from where it starts being about the question (a phrase the find bar can match)
  const ws = best.line.split(' ')
  const at = Math.max(
    0,
    ws.findIndex((w) => terms.some((t) => holdsAny(w.toLowerCase(), t)) || rules.some((r) => w.includes(r))),
  )
  const from = Math.max(0, Math.min(at - 2, ws.length - 6))
  return ws.slice(from, from + 6).join(' ').replace(/[.,;:]$/, '')
}

const definesRuleLine = (raw: string, rules: string[]) => rules.some((r) => definesRule(raw, r))

/** Text to find in the note when the source is opened: the section's heading, else its first words. */
export function findTextOf(s: Section): string {
  const head = /^#{1,6}\s+(.*)$/m.exec(s.text)?.[1]
  const plain = (t: string) =>
    t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~>#|\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  if (head && !/\(continued\)$/.test(head)) return plain(head).slice(0, 80)
  const first = s.text.split('\n').map(plain).find((l) => l.length >= 8 && !/\(continued\)$/.test(l)) ?? ''
  return first.split(' ').slice(0, 8).join(' ')
}

/**
 * Where in a source an answer's sentence came from: the line sharing the most
 * of its words – numbers most of all ("40” tall", "125 lbs") – as the first
 * words of that line, for the find bar. Null when nothing is shared.
 */
export function findForClaim(text: string, claim: string): string | null {
  return claimMatch(text, claim)?.find ?? null
}

/** findForClaim, with how much the line shares with the sentence. */
export function claimMatch(text: string, claim: string): { find: string; score: number } | null {
  // words, numbers ("36", "10.5") and rule numbers ("r01") – as written
  const tokens = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+(?:\.\d+)?/gu) ?? []
  const weight = (w: string) => (/^\d+(?:\.\d+)?$/.test(w) ? (w.length >= 2 ? 3 : 1) : /^[a-z]{1,3}\d{2,4}$/.test(w) ? 3 : 1)
  const own = tokens(claim).filter((w) => (w.length >= 3 || /\d/.test(w)) && !CLAIM_STOP.has(w))
  if (!own.length) return null
  // the words a note says the same with ("height" in the answer, "tall" in the rule)
  const want = new Map<string, number>()
  for (const w of own) {
    want.set(w, weight(w))
    for (const v of variantsOf(w)) if (!v.includes(' ') && !want.has(v)) want.set(v, 0.5)
  }
  let best: { line: string; score: number } | null = null
  for (const raw of findableLines(text)) {
    const line = plainLine(raw)
    if (line.length < 4) continue
    const have = new Set(tokens(line))
    let score = 0
    let shared = 0
    for (const [w, n] of want) if (have.has(w)) (score += n), shared++
    if (shared >= 2 && score > (best?.score ?? 0)) best = { line, score }
  }
  // a word or two in common is chance, not where it came from
  if (!best || best.score < 4) return null
  const ws = best.line.split(' ')
  let from = 0
  // a long line (a table cell listing many things): from where it says it – a rule's own line from its start
  if (best.line.length > 160 && !/^[A-Z]{1,3}\d{2,4}\b/.test(best.line)) {
    const at = (strong: boolean) => ws.findIndex((w) => tokens(w).some((t) => (want.get(t) ?? 0) >= (strong ? 3 : 1)))
    const i = at(true) >= 0 ? at(true) : at(false)
    from = Math.max(0, Math.min(i - 2, ws.length - 6))
  }
  return { find: ws.slice(from, from + 6).join(' ').replace(/[.,;:]$/, ''), score: best.score }
}

const CLAIM_STOP = new Set(
  'the and for are was were with that this from have has had not but can will its into than then they their there which what when where who how all any per also must may should note notes section'.split(' '),
)
