import { noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import type { MeaningIndex } from './semantic'
import { shortDate, timeRange, todayLabel } from './timeRange'

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
export function excerpt(md: string, words: string[], limit: number): string {
  if (md.length <= limit) return md
  const lines = md.split('\n')
  const hits = (l: string) => {
    const low = l.toLowerCase()
    return words.some((w) => low.includes(w))
  }
  const keep = new Set<number>([0, 1, 2])
  const heading = (l: string) => /^#{1,6}\s/.test(l)
  lines.forEach((l, i) => {
    if (!hits(l)) return
    if (i > 0) keep.add(i - 1)
    keep.add(i)
    // and the section it starts or sits in: the lines after it, up to a gap or the next heading
    let blanks = 0
    for (let j = i + 1; j < lines.length && j <= i + 25; j++) {
      if (!lines[j].trim()) {
        if (++blanks > 1) break
        continue
      }
      if (heading(lines[j])) break
      blanks = 0
      keep.add(j)
    }
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
): Promise<{ answer: string; sources: AskSource[]; agent: string }> {
  const meta = sync.noteMeta()
  const now = when.now ?? Date.now()
  const tz = when.tzOffset ?? 0
  const range = timeRange(question, now, tz)
  const usable = (id: string) => {
    const m = meta.get(id)
    return m && !m.trashedAt && !m.template
  }
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
  // notes that share words with the question, and notes about the same thing in
  // other words (search by meaning), merged by rank
  const byWords = store.searchAny(words, 20).map((h) => h.noteId)
  const byMeaning = meaning?.available ? (await meaning.search(question, 20)).map((h) => h.noteId) : []
  const score = new Map<string, number>()
  for (const list of [byWords, byMeaning]) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (10 + i)))
  let ids = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter(usable)
    .slice(0, 8)
  // a question about a time ("yesterday", "last week", "on 10/5"): the notes
  // written or edited then – those that also match its words first
  if (range) {
    const then = notesActiveIn(store, meta, range.from, range.to).filter(usable)
    ids = then.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || meta.get(b)!.updatedAt - meta.get(a)!.updatedAt).slice(0, 8)
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
    const md = excerpt(noteToMarkdown(doc, { attachmentText: true }), words, PER_NOTE)
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
- Answer in the language of the question.

Today is ${todayLabel(now, tz)}.${range ? `\nThe question is about ${range.label}: the notes below are the ones written or edited then.` : ''}

Question: ${question}

Notes:${context}`

  const { text: raw, agent } = await ai.ask(prompt)
  const text = listify(raw)
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
