import { noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'

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

const PER_NOTE = 6000
const TOTAL = 30000

export async function askNotes(store: Store, sync: SyncEngine, ai: Ai, question: string): Promise<{ answer: string; sources: AskSource[]; agent: string }> {
  const meta = sync.noteMeta()
  const usable = (id: string) => {
    const m = meta.get(id)
    return m && !m.trashedAt && !m.template
  }
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
  let ids = store
    .searchAny(words, 20)
    .map((h) => h.noteId)
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
    const md = noteToMarkdown(doc, { attachmentText: true }).slice(0, PER_NOTE)
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
