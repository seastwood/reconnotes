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
  const has = (low: string, t: string) => (t.length > 5 ? low.includes(STEM(t)) : new RegExp(`(^|[^\\p{L}\\p{N}])${t}`, 'u').test(low))
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
