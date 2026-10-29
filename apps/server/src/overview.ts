import { createHash } from 'node:crypto'
import { noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import type { Ai } from './ai'
import { outline, splitSections } from './sections'

/**
 * A long note's overview, made ahead
 * ==================================
 *
 * Ask reads a dozen passages of a manual – not enough to know what the whole
 * thing is and how it works (how a match is scored, that penalties go in a
 * table, what's a requirement and what's an FAQ). So each long note gets an
 * overview of a few sentences, written by your AI once – in the background,
 * behind anything you ask for, after the note has been quiet a while – and
 * again when it changes. Ask gives it with the note's outline: the big
 * picture, at no cost when you ask.
 */

/** a note this long gets an overview (a few pages of a manual) */
export const OVERVIEW_MIN = 6000
/** what's given to the AI to write it: the outline and each part's opening */
const INPUT_MAX = 9000

function table(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS note_overviews (
    note_id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`)
}

const hashOf = (md: string) => createHash('sha1').update(md).digest('hex')

/** The overview kept for a note (made from an earlier version of it, if it changed since – close enough). */
export function overviewOf(store: Store, noteId: string): string | null {
  table(store)
  return (store.db.prepare('SELECT text FROM note_overviews WHERE note_id = ?').get(noteId) as { text: string } | undefined)?.text ?? null
}

export function forgetOverview(store: Store, noteId: string) {
  table(store)
  store.db.prepare('DELETE FROM note_overviews WHERE note_id = ?').run(noteId)
}

/** The note as it's summed up (its text, with the text in its pictures and files). */
function markdownOf(sync: SyncEngine, noteId: string): string {
  const doc = sync.getDoc(noteDocName(noteId))
  return doc ? noteToMarkdown(doc, { attachmentText: true, attachmentTextLimit: 2_000_000 }) : ''
}

/** Does the note need a (new) overview: long enough, and none for its text as it is now? */
export function needsOverview(store: Store, sync: SyncEngine, noteId: string): boolean {
  const m = sync.noteMeta().get(noteId)
  if (!m || m.trashedAt || m.template) return false
  const md = markdownOf(sync, noteId)
  if (md.length < OVERVIEW_MIN) return false
  table(store)
  const row = store.db.prepare('SELECT hash FROM note_overviews WHERE note_id = ?').get(noteId) as { hash: string } | undefined
  return row?.hash !== hashOf(md)
}

/** What the AI reads to write it: the outline, then each part's opening lines. */
export function overviewInput(title: string, md: string): string {
  const sections = splitSections('', title, md)
  const map = outline(sections, new Set(), 2500)
  let out = map ? `Outline:\n${map}\n\nHow each part starts:\n` : ''
  const seen = new Set<string>()
  for (const sec of sections) {
    const path = sec.path.join(' › ')
    // one opening per part (a long part is in pieces – the first with words in it)
    if (seen.has(path)) continue
    const body = sec.text
      .replace(/^#{1,6}\s.*$/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!body) continue
    seen.add(path)
    const piece = `\n[${path || title}] ${body.slice(0, 280)}${body.length > 280 ? '…' : ''}`
    if (out.length + piece.length > INPUT_MAX) break
    out += piece
  }
  return out.trim()
}

/** Write (or rewrite) a note's overview. Resolves to it, or null when the note doesn't need one. */
export async function makeOverview(store: Store, sync: SyncEngine, ai: Ai, noteId: string): Promise<{ text: string; agent: string } | null> {
  const m = sync.noteMeta().get(noteId)
  if (!m || m.trashedAt) return null
  const md = markdownOf(sync, noteId)
  if (md.length < OVERVIEW_MIN) return (forgetOverview(store, noteId), null)
  const title = m.title || 'Untitled'
  const prompt = `Below is the outline of a long document, "${title}", and how each of its parts starts. Write an overview of it for someone who will answer questions about it from a few passages at a time – so they know what the whole thing is and how it works.

In 120 to 200 words, plain sentences (no headings, no lists):
- what the document is and what it's for
- its main parts, and what kind of content each has (rules, requirements, penalties, scoring, definitions, FAQ, schedules, examples…)
- how it fits together: e.g. how points are scored and how penalties are applied, what's required and what's optional, and any other document it relies on
Use only what's below – don't guess at what isn't there. Use the document's own terms.

${overviewInput(title, md)}`
  const { text, agent } = await ai.overview(prompt)
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  if (!clean) return null
  table(store)
  store.db
    .prepare('INSERT INTO note_overviews (note_id, hash, text, at) VALUES (?, ?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET hash = excluded.hash, text = excluded.text, at = excluded.at')
    .run(noteId, hashOf(md), clean.slice(0, 2000), Date.now())
  return { text: clean, agent }
}
