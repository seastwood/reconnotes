import type { Store } from './store'
import { levenshtein } from './store'

/**
 * Your words
 * ==========
 *
 * Names and terms that appear in your notes (Klai, Doug, Lieutenant…) are
 * given to every handwriting reading and clean-up, so they come out right.
 * The list grows by itself: when you correct a word in converted text
 * ("Leutenant" → "Lieutenant"), the correction is remembered and passed on
 * too ("often misread: Leutenant → Lieutenant").
 */

export interface Learned {
  from: string
  to: string
  count: number
  at: number
  /** misheard by speech-to-text (fixed in a transcript): fixed in new transcripts as they come */
  heard?: boolean
  /** …in this group's recordings (its top-level folder; '' outside any): not in another group's */
  group?: string
}

interface Saved {
  words: string[]
  learned: Learned[]
}

const KEY = 'vocabulary'
const MAX_LEARNED = 200

export class Vocabulary {
  constructor(private store: Store) {}

  private load(): Saved {
    const s = this.store.getSetting<Partial<Saved>>(KEY) ?? {}
    return { words: s.words ?? [], learned: s.learned ?? [] }
  }

  get(): Saved {
    return this.load()
  }

  setWords(words: string[]) {
    const clean = [...new Set(words.map((w) => w.trim()).filter((w) => w && w.length <= 60))].slice(0, 500)
    this.store.setSetting(KEY, { ...this.load(), words: clean })
  }

  forget(from: string, to: string) {
    const s = this.load()
    this.store.setSetting(KEY, { ...s, learned: s.learned.filter((l) => !(l.from === from && l.to === to)) })
  }

  /** Remember that the AI read `from` where you meant `to` (`heard`: speech-to-text misheard it). */
  learn(from: string, to: string, heard = false, group?: string) {
    const s = this.load()
    const hit = s.learned.find((l) => l.from.toLowerCase() === from.toLowerCase() && l.to === to && (l.group ?? '') === (group ?? ''))
    if (hit) {
      hit.count++
      hit.at = Date.now()
      if (heard) hit.heard = true
    } else s.learned.push({ from, to, count: 1, at: Date.now(), ...(heard ? { heard } : {}), ...(group !== undefined ? { group } : {}) })
    s.learned.sort((a, b) => b.at - a.at)
    this.store.setSetting(KEY, { ...s, learned: s.learned.slice(0, MAX_LEARNED) })
  }

  /** What speech-to-text has misheard before (you fixed it in a transcript): [from, to]. */
  /** (`group`: a recording's group – its own fixes, and the ones from before groups; not another group's) */
  heardFixes(group = ''): [string, string][] {
    return this.load()
      .learned.filter((l) => l.heard && (l.group === undefined || l.group === group))
      .map((l) => [l.from, l.to])
  }

  /** The words to tell the AI about ('' when there are none). */
  /**
   * For speech-to-text (Whisper's "prompt"): your names and terms, as text it has "already heard" –
   * it then spells them like that. Short: Whisper only reads the last ~220 tokens of it.
   */
  /** `extra`: names for this one recording (a meeting's attendees) – first, so they're never cut off */
  speechPrompt(extra: string[] = [], group = ''): string {
    const s = this.load()
    // (a misheard word fixed in another group's recordings isn't this one's)
    const learned = s.learned.filter((l) => !l.heard || l.group === undefined || l.group === group)
    const words = [...new Set([...extra.map((w) => w.trim()).filter(Boolean), ...learned.map((l) => l.to), ...s.words])].filter((w) => w.length <= 30)
    let out = ''
    for (const w of words) {
      if (out.length + w.length + 2 > 600) break
      out += (out ? ', ' : '') + w
    }
    return out ? `${out}.` : ''
  }

  hint(): string {
    const s = this.load()
    const words = [...new Set([...s.words, ...s.learned.map((l) => l.to)])].slice(0, 150)
    const misreads = s.learned.slice(0, 40).map((l) => `${l.from} → ${l.to}`)
    const parts: string[] = []
    if (words.length) parts.push(`Names and words that appear in these notes (spell them like this): ${words.join(', ')}.`)
    if (misreads.length) parts.push(`Words that have been misread before: ${misreads.join('; ')}.`)
    return parts.join('\n')
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** the words, whole (not inside another word), any case, any spacing between them */
export const heardPattern = (from: string) => new RegExp(`(?<![\\p{L}\\p{N}])${from.trim().split(/\s+/).map(escape).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu')

/** `to` in place of `from`, capitalised where what it replaces was (a sentence's first word). */
export function replaceHeard(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(heardPattern(from), (m) => {
    count++
    return /^\p{Lu}/u.test(m) && /^\p{Ll}/u.test(to) ? to[0].toUpperCase() + to.slice(1) : to
  })
  return { text: out, count }
}

/** A transcript with the fixes you've made before (misheard words): text and word times. */
export function fixHeard<W extends { word: string }>(text: string, words: W[] | undefined, fixes: [string, string][]): { text: string; words: W[] | undefined } {
  for (const [from, to] of fixes) {
    text = replaceHeard(text, from, to).text
    if (words && !/\s/.test(from.trim()) && !/\s/.test(to.trim())) words = words.map((w) => ({ ...w, word: replaceHeard(w.word, from, to).text }))
  }
  return { text, words }
}

const tokens = (s: string) => s.match(/[\p{L}\p{N}'’-]+/gu) ?? []
const isWord = (s: string) => /\p{L}/u.test(s) && s.length >= 3

/**
 * Corrections between what the AI wrote and what the text says now: a word
 * (or two) replaced by a similar-looking word (or two). Rewording – a word
 * swapped for a different one – isn't a misreading and is ignored.
 */
export function corrections(before: string, after: string): { from: string; to: string }[] {
  const a = tokens(before)
  const b = tokens(after)
  if (!a.length || !b.length || a.length > 2000 || b.length > 2000) return []
  // longest common subsequence of words
  const n = a.length
  const m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].toLowerCase() === b[j].toLowerCase() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { from: string; to: string }[] = []
  let i = 0
  let j = 0
  const flush = (oldWords: string[], newWords: string[]) => {
    if (!oldWords.length || !newWords.length || oldWords.length > 2 || newWords.length > 2) return
    const from = oldWords.join(' ')
    const to = newWords.join(' ')
    if (!newWords.every(isWord) || from.toLowerCase() === to.toLowerCase()) return
    const d = levenshtein(from.toLowerCase().replace(/\s/g, ''), to.toLowerCase().replace(/\s/g, ''))
    if (d <= Math.max(2, Math.floor(to.length / 3))) out.push({ from, to })
  }
  let oldRun: string[] = []
  let newRun: string[] = []
  while (i < n || j < m) {
    if (i < n && j < m && a[i].toLowerCase() === b[j].toLowerCase()) {
      flush(oldRun, newRun)
      oldRun = []
      newRun = []
      i++
      j++
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) newRun.push(b[j++])
    else oldRun.push(a[i++])
  }
  flush(oldRun, newRun)
  return out
}

/** Words the clean-up pass changed from what the reader saw: worth a second look. */
export function guessedWords(raw: string, tidied: string): Set<string> {
  const seen = new Set(tokens(raw).map((t) => t.toLowerCase()))
  const out = new Set<string>()
  for (const t of tokens(tidied)) if (isWord(t) && !seen.has(t.toLowerCase())) out.add(t)
  return out
}
