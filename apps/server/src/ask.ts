import { noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import type { MeaningIndex } from './semantic'
import { annotateDates, describeDate, dueWindow, findDates, shortDate, startOfToday, timeRange, todayLabel } from './timeRange'
import { noteFilter, type Scope } from './access'

/**
 * Ask your notes
 * ==============
 *
 * Find the notes most related to a question (full-text search over typed
 * text, recognised handwriting, picture text and transcripts), give them to
 * the "Compile notes" agents and ask for an answer that cites them.
 */

const STOP = new Set(
  'a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with would you your about any all also did didnt dont get got just know like make need should tell than want note notes wrote write written work worked working yesterday today tonight week month last past previous day days morning afternoon evening monday tuesday wednesday thursday friday saturday sunday'.split(
    ' ',
  ),
)

/** an earlier question and answer in a conversation */
export interface AskTurn {
  question: string
  answer: string
  /** the notes that answer used */
  sources?: string[]
}

export interface AskSource {
  n: number
  noteId: string
  title: string
}

// kept small: on a home GPU, reading the notes is most of the wait
const PER_NOTE = 3500
const TOTAL = 16000

/**
 * A long note cut down to the parts about the question: its first lines,
 * and the lines that share words with it (with a line either side).
 */
const heading = (l: string) => /^#{1,6}\s/.test(l)
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/

/**
 * The lines of the section a line starts or sits in: what follows it, up to a
 * gap or the next heading – but headings straight after it ("Leadership
 * Meeting" then "10/5/26") belong to it.
 */
function sectionAfter(lines: string[], i: number): number[] {
  const out: number[] = []
  let blanks = 0
  let content = false
  for (let j = i + 1; j < lines.length && j <= i + 30; j++) {
    if (!lines[j].trim()) {
      if (++blanks > 1) break
      continue
    }
    if (heading(lines[j]) && content) break
    if (!heading(lines[j])) content = true
    blanks = 0
    out.push(j)
  }
  return out
}

export function excerpt(md: string, words: string[], limit: number): string {
  if (md.length <= limit) return md
  const lines = md.split('\n')
  const hits = (l: string) => {
    const low = l.toLowerCase()
    return words.some((w) => low.includes(w))
  }
  const keep = new Set<number>([0, 1, 2])
  lines.forEach((l, i) => {
    if (!hits(l)) return
    if (i > 0) keep.add(i - 1)
    keep.add(i)
    for (const j of sectionAfter(lines, i)) keep.add(j)
  })
  let out = ''
  let last = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    const piece = (last >= 0 && i > last + 1 ? '…\n' : '') + lines[i] + '\n'
    if (out.length + piece.length > limit) break
    out += piece
    last = i
  }
  // nothing matched beyond the start: the beginning of the note
  return out.trim().length > 40 ? out : md.slice(0, limit)
}

export async function askNotes(
  store: Store,
  sync: SyncEngine,
  ai: Ai,
  question: string,
  meaning?: MeaningIndex | null,
  /** the asker's clock: their time zone (Date#getTimezoneOffset) and now */
  when: { tzOffset?: number; now?: number } = {},
  /** which folders: locked ones only if unlocked on the asking device; a chosen set of folders */
  scope: Scope = {},
  /** a follow-up: the questions and answers before it, oldest first (with the notes each used) */
  history: AskTurn[] = [],
): Promise<{ answer: string; sources: AskSource[]; agent: string }> {
  const meta = sync.noteMeta()
  const allowed = noteFilter(sync, scope)
  const now = when.now ?? Date.now()
  const tz = when.tzOffset ?? 0
  // a follow-up without a time of its own ("and the second one?") keeps the conversation's
  const range = timeRange(question, now, tz) ?? history.map((h) => timeRange(h.question, now, tz)).find(Boolean) ?? null
  const allowedEarly = noteFilter(sync, scope)
  // what's due / overdue: worked out from the dates themselves – no guessing by the AI
  if (isDueQuestion(question)) return dueAnswer(sync, meta, (id) => allowedEarly(id), question, now, tz)
  const usable = (id: string) => {
    const m = meta.get(id)
    return Boolean(m && !m.trashedAt && !m.template && allowed(id))
  }
  const wordsOf = (q: string) =>
    q
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  const ownWords = wordsOf(question)
  // a follow-up ("what about the first one?") is about what was asked before too
  const words = [...new Set([...ownWords, ...history.flatMap((h) => wordsOf(h.question))])]
  // notes that share words with the question, and notes about the same thing in
  // other words (search by meaning), merged by rank
  const byWords = store.searchAny(words, 200).map((h) => h.noteId).filter(usable).slice(0, 20)
  const meaningQuery = [...history.map((h) => h.question), question].join(' ')
  const byMeaning = meaning?.available ? (await meaning.search(meaningQuery, 200)).map((h) => h.noteId).filter(usable).slice(0, 20) : []
  const score = new Map<string, number>()
  for (const list of [byWords, byMeaning]) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (10 + i)))
  // the notes the earlier answers used come first: a follow-up is usually about them
  const earlier = [...new Set(history.flatMap((h) => h.sources ?? []))].filter(usable)
  earlier.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 - i / 100))
  let ids = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter(usable)
    .slice(0, 8)
  // a question about a time ("yesterday", "last week", "on 10/5"): the notes
  // written or edited then – those that also match its words first
  if (range) {
    const then = notesActiveIn(store, meta, range.from, range.to).filter(usable)
    ids = [...new Set([...earlier, ...then])].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || meta.get(b)!.updatedAt - meta.get(a)!.updatedAt).slice(0, 8)
  }
  // nothing matched: the latest notes
  if (!ids.length && !range)
    ids = [...meta.values()]
      .filter((n) => usable(n.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((n) => n.id)
  if (!ids.length && range) return { answer: `You didn't write or edit any notes ${range.label}.`, sources: [], agent: '' }
  if (!ids.length) return { answer: "You don't have any notes yet.", sources: [], agent: '' }

  const sources: AskSource[] = []
  const texts = new Map<number, string>()
  let context = ''
  for (const id of ids) {
    const doc = sync.getDoc(noteDocName(id))
    if (!doc) continue
    // every date explained ("5/4/26 [Mon 4 May 2026, 156 days ago]"): small models can't count days
    const md = annotateDates(excerpt(noteToMarkdown(doc, { attachmentText: true }), words, PER_NOTE), now, tz)
    if (!md.trim()) continue
    if (context.length + md.length > TOTAL) break
    const n = sources.length + 1
    const m = meta.get(id)!
    sources.push({ n, noteId: id, title: shortTitle(m.title) })
    texts.set(n, md)
    context += `\n\n=== [${n}] "${m.title || 'Untitled'}" (created ${shortDate(m.createdAt, tz)}, last edited ${shortDate(m.updatedAt, tz)}) ===\n${md}`
  }

  const prompt = `Answer the question using only the notes below (my own notes). Lines starting with ✍️ are handwriting, 📷 text from pictures and 🎙️ recordings.

- Be brief and direct. Start with the answer, not a restatement of the question.
- When the answer is several things, write a Markdown list, one item per line starting with "- ". Include every item the notes give – don't leave any out or merge them.
- When the question asks what to do (tasks, to-dos, next steps), write a checklist instead: one task per line starting with "- [ ] ".
- When asked which notes there are or what was worked on, list each note by its title with a short summary of what's in it.
- After each fact or item, cite the note it came from like [1] or [2][3].
- If the notes don't contain the answer, say so plainly – don't guess or use outside knowledge.
- Don't add details the notes don't say (dates, days, names, what happened at a meeting). Repeat items in the note's own words.
- Answer in the language of the question.

Today is ${todayLabel(now, tz)}.${range ? `\nThe question is about ${range.label}: the notes below are the ones written or edited then.` : ''}

${
    history.length
      ? `Earlier in this conversation (the new question may refer to it):\n${history.map((h) => `Q: ${h.question}\nA: ${h.answer.slice(0, 1500)}`).join('\n\n')}\n\n`
      : ''
  }${history.length ? 'Follow-up question' : 'Question'}: ${question}

Notes:${context}`

  const { text: raw, agent } = await ai.ask(prompt)
  let text = listify(raw)
  // the list items of the note sections the question is about, that the answer left out
  const missing = missingItems(text, sectionItems(texts, ownWords))
  if (missing.length && !/don't contain|do not contain|doesn't contain|no information|not (?:found|mentioned)/i.test(text)) {
    const box = /^\s*- \[ \]/m.test(text) ? '- [ ] ' : '- '
    text += `\n\nAlso in your notes:\n${missing.map((m) => `${box}${m.text} [${m.n}]`).join('\n')}`
  }
  // keep only sources the answer actually cites – or, if it cites none, the notes it plainly drew on
  const cited = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
  return { answer: text, sources: cited.size ? sources.filter((s) => cited.has(s.n)) : usedSources(text, sources, texts), agent }
}

/** A note's title for the source list: handwritten notes can have a whole paragraph as their title. */
function shortTitle(title: string): string {
  const t = (title || 'Untitled').replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t
}

const isListLine = (l: string) => /^\s*([-*+•]|\d+[.)])\s/.test(l)

/**
 * Small models often list things as plain lines ("After the meeting you need to:"
 * then one line per task). Make those a proper Markdown list; "•" and "*" bullets too.
 */
export function listify(text: string): string {
  const lines = text.replace(/^(\s*)[•*]\s+/gm, '$1- ').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    if (!/:\s*$/.test(lines[i])) continue
    // the plain lines after "…:" (until a blank line), if there are at least two
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const run: string[] = []
    while (j < lines.length && lines[j].trim() && !isListLine(lines[j]) && !/^#/.test(lines[j])) run.push(lines[j++])
    if (run.length < 2 || (j < lines.length && lines[j].trim())) continue
    out.push('', ...run.map((l) => `- ${l.trim()}`))
    i = j - 1
  }
  return out.join('\n')
}

/** Sources for an answer that cites none: the notes sharing the most words with it. */
function usedSources(answer: string, sources: AskSource[], texts: Map<number, string>): AskSource[] {
  const words = new Set(answer.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)?.filter((w) => !STOP.has(w)) ?? [])
  if (!words.size) return sources
  const scored = sources.map((s) => {
    const have = new Set(texts.get(s.n)?.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
    let n = 0
    for (const w of words) if (have.has(w)) n++
    return { s, n }
  })
  const best = Math.max(...scored.map((x) => x.n))
  if (!best) return sources.slice(0, 3)
  return scored
    .filter((x) => x.n >= Math.ceil(best * 0.5))
    .slice(0, 4)
    .map((x) => x.s)
}

/** Notes created or edited between `from` and `to` (from their dates and the version history). */
function notesActiveIn(store: Store, meta: Map<string, { id: string; createdAt: number; updatedAt: number }>, from: number, to: number): string[] {
  const ids = new Set<string>()
  for (const m of meta.values()) if ((m.updatedAt >= from && m.updatedAt < to) || (m.createdAt >= from && m.createdAt < to)) ids.add(m.id)
  // snapshots are taken while a note is being edited: a note worked on then, edited again since
  const rows = store.db.prepare("SELECT DISTINCT doc_name FROM versions WHERE created_at >= ? AND created_at < ? AND doc_name LIKE 'note:%'").all(from, to) as { doc_name: string }[]
  for (const r of rows) ids.add(r.doc_name.slice('note:'.length))
  return [...ids].filter((id) => meta.has(id))
}

const significant = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w))

/**
 * List items under the lines that are plainly what the question is about
 * (a line with two of its words, e.g. a "Leadership Meeting" heading).
 */
export function sectionItems(texts: Map<number, string>, words: string[]): { n: number; text: string }[] {
  const need = Math.min(2, new Set(words).size)
  if (!need) return []
  const out: { n: number; text: string }[] = []
  const seen = new Set<string>()
  for (const [n, md] of texts) {
    const lines = md.split('\n')
    lines.forEach((l, i) => {
      const low = l.toLowerCase()
      if (new Set(words.filter((w) => low.includes(w))).size < need || LIST_ITEM.test(l)) return
      for (const j of sectionAfter(lines, i)) {
        const item = lines[j].match(LIST_ITEM)?.[1]?.trim()
        const key = item?.toLowerCase().replace(/\W+/g, ' ').trim()
        if (item && key && !seen.has(key)) {
          seen.add(key)
          out.push({ n, text: item.replace(/\s*\[\d+\]$/, '') })
        }
      }
    })
  }
  return out.slice(0, 30)
}

/** Items whose words mostly don't appear in the answer (stems: "returning" ≈ "return"). */
export function missingItems(answer: string, items: { n: number; text: string }[]): { n: number; text: string }[] {
  const said = significant(answer).map((w) => w.slice(0, 5))
  const has = (w: string) => said.includes(w.slice(0, 5))
  return items.filter((it) => {
    const ws = significant(it.text)
    if (!ws.length) return false
    return ws.filter(has).length / ws.length < 0.5
  })
}

// --- what's due -------------------------------------------------------------------

const OVERDUE = /\bover ?due\b|\bpast[- ]due\b|\blate\b|\bmissed\b|\bbehind\b/i
const UPCOMING = /\bupcoming\b|\bcoming up\b|\bsoon\b|\bnext\b/i
export const isDueQuestion = (q: string) => /\bdue\b|\bover ?due\b|\bdeadlines?\b|\bpast[- ]due\b|\bupcoming\b/i.test(q)

/**
 * The to-dos with dates – due dates set in the app, and unticked checklist
 * items or "due / by …" lines with a date written in them – sorted into
 * overdue, today and coming up, from today's date where you are.
 */
export function dueAnswer(
  sync: SyncEngine,
  meta: Map<string, { id: string; title: string; trashedAt: number | null; template: boolean; due: { date: string; text: string; done: boolean }[] }>,
  allowed: (id: string) => boolean,
  question: string,
  now: number,
  tz: number,
): { answer: string; sources: AskSource[]; agent: string } {
  const today = startOfToday(now, tz)
  const items: { noteId: string; title: string; text: string; at: number }[] = []
  for (const m of meta.values()) {
    if (m.trashedAt || m.template || !allowed(m.id)) continue
    const seen = new Set<string>()
    for (const d of m.due) {
      const at = findDates(d.date, now, tz)[0]?.at
      if (d.done || at === undefined) continue
      seen.add(d.text.trim().toLowerCase())
      items.push({ noteId: m.id, title: m.title, text: d.text.trim() || 'Untitled to-do', at })
    }
    const doc = sync.getDoc(noteDocName(m.id))
    if (!doc) continue
    for (const line of noteToMarkdown(doc).split('\n')) {
      const open = line.match(/^\s*[-*+]\s+\[ \]\s+(.+)$/)
      const plain = !open && line.match(/^\s*(?:[-*+•]\s+)?(.*\b(?:due|by|deadline|until)\b.*)$/i)
      const text = (open?.[1] ?? (plain ? plain[1] : '')).replace(/\s*!\d{4}-\d{2}-\d{2}/g, '').trim()
      if (!text || seen.has(text.toLowerCase())) continue
      const at = findDates(open?.[1] ?? text, now, tz)[0]?.at
      if (at === undefined || /!\d{4}-\d{2}-\d{2}/.test(line)) continue
      seen.add(text.toLowerCase())
      items.push({ noteId: m.id, title: m.title, text, at })
    }
  }
  const window = dueWindow(question, now, tz)
  const onlyOverdue = OVERDUE.test(question)
  const onlyUpcoming = !onlyOverdue && UPCOMING.test(question)
  const pick = items.filter((i) => (window ? i.at >= window.from && i.at < window.to : onlyOverdue ? i.at < today : onlyUpcoming ? i.at >= today : true))
  const sources: AskSource[] = []
  const cite = (noteId: string, title: string) => {
    let s = sources.find((x) => x.noteId === noteId)
    if (!s) sources.push((s = { n: sources.length + 1, noteId, title: shortTitle(title) }))
    return s.n
  }
  const line = (i: (typeof items)[number]) => `- [ ] ${i.text} — ${describeDate(i.at, now, tz)} [${cite(i.noteId, i.title)}]`
  const overdue = pick.filter((i) => i.at < today).sort((a, b) => a.at - b.at)
  const dueToday = pick.filter((i) => i.at >= today && i.at < today + 86_400_000)
  const later = pick.filter((i) => i.at >= today + 86_400_000).sort((a, b) => a.at - b.at)
  const parts: string[] = []
  if (overdue.length) parts.push(`**Overdue**\n${overdue.map(line).join('\n')}`)
  if (dueToday.length) parts.push(`**Due today**\n${dueToday.map(line).join('\n')}`)
  if (later.length) parts.push(`**Coming up**\n${later.slice(0, 20).map(line).join('\n')}`)
  let answer = parts.join('\n\n')
  if (!answer) {
    const next = items.filter((i) => i.at >= today).sort((a, b) => a.at - b.at)[0]
    answer = `${window ? `Nothing is due ${window.label}.` : onlyOverdue ? 'Nothing is overdue.' : onlyUpcoming ? 'Nothing is coming up.' : 'None of your to-dos have a date.'}${
      next && !onlyUpcoming ? `\n\nNext up: ${next.text} — ${describeDate(next.at, now, tz)} [${cite(next.noteId, next.title)}]` : ''
    }`
  }
  return { answer: `Today is ${todayLabel(now, tz)}.\n\n${answer}`, sources, agent: 'Worked out from your notes' }
}
