/**
 * Search syntax
 * =============
 *
 *   "exact phrase"        the words together, in that order
 *   -word  -"a phrase"    leave out notes with it
 *   #tag  tag:tag         notes with that tag
 *   folder:FRC  in:"To Do"  only that folder (and its subfolders)
 *   before:10/1  after:2026-09-01  before:today  after:yesterday  after:7d (days ago)
 *   has:handwriting  has:picture  has:recording  has:file  has:checklist  has:link  has:table
 *
 * Everything else is searched for as usual.
 */

export type HasKind = 'handwriting' | 'picture' | 'recording' | 'file' | 'checklist' | 'link' | 'table'
export const HAS_KINDS: HasKind[] = ['handwriting', 'picture', 'recording', 'file', 'checklist', 'link', 'table']
const HAS_ALIASES: Record<string, HasKind> = {
  handwriting: 'handwriting',
  ink: 'handwriting',
  drawing: 'handwriting',
  picture: 'picture',
  pictures: 'picture',
  image: 'picture',
  photo: 'picture',
  recording: 'recording',
  audio: 'recording',
  file: 'file',
  files: 'file',
  pdf: 'file',
  checklist: 'checklist',
  todo: 'checklist',
  todos: 'checklist',
  link: 'link',
  links: 'link',
  table: 'table',
}

export interface ParsedQuery {
  /** what's searched for (the free words and the phrases' words) */
  text: string
  phrases: string[]
  exclude: string[]
  tags: string[]
  folders: string[]
  /** notes edited before / after these times (ms) */
  before: number | null
  after: number | null
  has: HasKind[]
  /** the query uses any of the syntax */
  advanced: boolean
}

const DAY = 86_400_000

/** "10/1", "10/1/26", "2026-10-01", "today", "yesterday", "7d" → local midnight of that day */
export function parseDay(s: string, now = new Date()): number | null {
  const t = s.toLowerCase()
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (t === 'today') return midnight(now)
  if (t === 'yesterday') return midnight(now) - DAY
  let m = t.match(/^(\d+)d$/)
  if (m) return midnight(now) - Number(m[1]) * DAY
  m = t.match(/^(\d+)w$/)
  if (m) return midnight(now) - Number(m[1]) * 7 * DAY
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/)
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear()
    return new Date(y, +m[1] - 1, +m[2]).getTime()
  }
  return null
}

export function parseQuery(q: string, now = new Date()): ParsedQuery {
  const out: ParsedQuery = { text: '', phrases: [], exclude: [], tags: [], folders: [], before: null, after: null, has: [], advanced: false }
  const free: string[] = []
  // tokens: key:"value", key:value, -"phrase", "phrase", -word, #tag, word
  const re = /(-)?(?:(\w+):)?(?:"([^"]*)"?|(\S+))/g
  for (const m of q.matchAll(re)) {
    const [, neg, key, quoted, bare] = m
    const value = (quoted ?? bare ?? '').trim()
    const k = key?.toLowerCase()
    if (k === 'tag' && value) (out.tags.push(value.replace(/^#/, '').toLowerCase()), (out.advanced = true))
    else if ((k === 'folder' || k === 'in') && value) (out.folders.push(value), (out.advanced = true))
    else if (k === 'has' && HAS_ALIASES[value.toLowerCase()]) (out.has.push(HAS_ALIASES[value.toLowerCase()]), (out.advanced = true))
    else if ((k === 'before' || k === 'after') && parseDay(value, now) !== null) {
      const at = parseDay(value, now)!
      // before:10/1 = edited before that day; after:10/1 = on or after it
      if (k === 'before') out.before = at
      else out.after = at
      out.advanced = true
    } else if (k) free.push(`${key}:${value}`)
    else if (neg && value) (out.exclude.push(value.toLowerCase()), (out.advanced = true))
    else if (quoted !== undefined && value) (out.phrases.push(value), (out.advanced = true))
    else if (/^#[\p{L}\p{N}_-]+$/u.test(value)) (out.tags.push(value.slice(1).toLowerCase()), (out.advanced = true))
    else if (value) free.push(value)
  }
  out.text = [...free, ...out.phrases].join(' ').trim()
  return out
}

/** Does this note text pass the phrase / exclude filters? (case-insensitive) */
export function textPasses(text: string, p: ParsedQuery): boolean {
  const low = text.toLowerCase().replace(/\s+/g, ' ')
  return p.phrases.every((ph) => low.includes(ph.toLowerCase().replace(/\s+/g, ' '))) && p.exclude.every((x) => !low.includes(x))
}
