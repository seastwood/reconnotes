import MiniSearch from 'minisearch'
import { metaDb } from './db'
import { apiUrl, authHeaders, isSyncConfigured } from './settings'

/**
 * Search works offline: every note's text (typed text, handwriting
 * transcripts, text extracted from images/PDFs/audio by the server) is kept
 * in a local full-text index. When online, server results are merged in.
 */

const index = new MiniSearch<{ id: string; title: string; text: string }>({
  fields: ['title', 'text'],
  storeFields: ['title', 'text'],
  searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
})

const ready = (async () => {
  try {
    const db = await metaDb()
    index.addAll(await db.getAll('texts'))
  } catch {
    /* IndexedDB unavailable – search falls back to the server */
  }
})()

export async function saveNoteText(id: string, title: string, text: string) {
  await ready
  const doc = { id, title, text }
  if (index.has(id)) index.replace(doc)
  else index.add(doc)
  try {
    await (await metaDb()).put('texts', doc)
  } catch {
    /* ignore */
  }
}

export interface SearchResult {
  noteId: string
  title: string
  snippet: string
  /** found by meaning (related), not by its words */
  meaning?: boolean
  /** in a folder the search names ("FRC wiring" → the FRC folder) */
  inFolder?: boolean
  /** where it matched: typed text, handwriting, a picture, a recording, a file – and the line */
  where?: { kind: 'text' | 'handwriting' | 'picture' | 'recording' | 'file'; line: string }
}

/** A note's searchable text on this device (typed text, handwriting, transcripts…), if indexed here. */
export function localText(noteId: string): string | null {
  const doc = index.getStoredFields(noteId) as { title?: string; text?: string } | undefined
  return doc ? `${doc.title ?? ''}\n${doc.text ?? ''}` : null
}

function snippetFor(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase())
    if (at >= 0) break
  }
  const start = Math.max(0, at - 60)
  const s = text.slice(start, start + 180).replace(/\s+/g, ' ')
  return (start > 0 ? '…' : '') + s + (start + 180 < text.length ? '…' : '')
}

/** where to look: chosen folders (none = everywhere), and the locked folders unlocked here */
export interface SearchWhere {
  folders?: string[]
  unlocked?: string[]
  /** has:handwriting / picture / … – the server knows what's in each note */
  has?: string[]
}

export async function searchNotes(query: string, where: SearchWhere = {}): Promise<SearchResult[]> {
  await ready
  const q = query.trim()
  const has = where.has ?? []
  if (!q && !has.length) return []
  // all the words; if nothing has them all, any of them
  let found = q ? index.search(q) : []
  if (!found.length && q.includes(' ')) found = index.search(q, { combineWith: 'OR' })
  const local: SearchResult[] = found.map((r) => ({
    noteId: r.id as string,
    title: r.title as string,
    snippet: snippetFor(r.text as string, r.terms),
  }))
  if (!isSyncConfigured() || !navigator.onLine) return local
  let all = local

  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    const params = new URLSearchParams({ q })
    if (where.folders?.length) params.set('folders', where.folders.join(','))
    if (where.unlocked?.length) params.set('unlocked', where.unlocked.join(','))
    if (has.length) params.set('has', has.join(','))
    const res = await fetch(apiUrl(`/api/search?${params}`), { headers: authHeaders(), signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return local
    const { hits } = (await res.json()) as { hits: { noteId: string; title: string; snippet: string; trashed: boolean; meaning?: boolean; where?: SearchResult['where'] }[] }
    const server = new Map(hits.map((h) => [h.noteId, h]))
    // has: only the server knows what's in each note
    if (has.length) all = local.filter((r) => server.has(r.noteId))
    const seen = new Set(all.map((r) => r.noteId))
    // the server says where each matched
    for (const r of all) if (server.get(r.noteId)?.where) r.where = server.get(r.noteId)!.where
    for (const h of hits) {
      if (!seen.has(h.noteId) && !h.trashed) {
        all.push({ noteId: h.noteId, title: h.title, snippet: h.snippet.replace(/\[\[|\]\]/g, ''), meaning: h.meaning, where: h.where })
      }
    }
    // word matches first, then notes related by meaning
    all.sort((a, b) => Number(Boolean(a.meaning)) - Number(Boolean(b.meaning)))
    return all
  } catch {
    /* offline or slow – local results are enough */
  }
  return local
}
