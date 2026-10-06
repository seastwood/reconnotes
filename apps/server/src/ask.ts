import { noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import type { MeaningIndex } from './semantic'

/**
 * Ask your notes
 * ==============
 *
 * Find the notes most related to a question (full-text search over typed
 * text, recognised handwriting, picture text and transcripts), give them to
 * the "Compile notes" agents and ask for an answer that cites them.
 */

const STOP = new Set(
  'a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with would you your about any all also did didnt dont get got just know like make need should tell than want'.split(
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
  lines.forEach((l, i) => {
    if (hits(l)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j)
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
): Promise<{ answer: string; sources: AskSource[]; agent: string }> {
  const meta = sync.noteMeta()
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
  // nothing matched (e.g. "what did I work on this week?"): the latest notes
  if (!ids.length)
    ids = [...meta.values()]
      .filter((n) => usable(n.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((n) => n.id)
  if (!ids.length) return { answer: "You don't have any notes yet.", sources: [], agent: '' }

  const sources: AskSource[] = []
  let context = ''
  for (const id of ids) {
    const doc = sync.getDoc(noteDocName(id))
    if (!doc) continue
    const md = excerpt(noteToMarkdown(doc, { attachmentText: true }), words, PER_NOTE)
    if (!md.trim()) continue
    if (context.length + md.length > TOTAL) break
    const n = sources.length + 1
    const m = meta.get(id)!
    sources.push({ n, noteId: id, title: m.title || 'Untitled' })
    const updated = new Date(m.updatedAt).toISOString().slice(0, 10)
    context += `\n\n=== [${n}] "${m.title || 'Untitled'}" (last edited ${updated}) ===\n${md}`
  }

  const prompt = `Answer the question using only the notes below (my own notes). Lines starting with ✍️ are handwriting, 📷 text from pictures and 🎙️ recordings.

- Be brief and direct. Use short bullet points when listing several things.
- After each fact, cite the note it came from like [1] or [2][3].
- If the notes don't contain the answer, say so plainly – don't guess or use outside knowledge.
- Answer in the language of the question.

Question: ${question}

Notes:${context}`

  const { text, agent } = await ai.ask(prompt)
  // keep only sources the answer actually cites (or all, if it cites none)
  const cited = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
  return { answer: text, sources: cited.size ? sources.filter((s) => cited.has(s.n)) : sources, agent }
}
