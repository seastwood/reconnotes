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

export async function searchNotes(query: string): Promise<SearchResult[]> {
  await ready
  const q = query.trim()
  if (!q) return []
  // all the words; if nothing has them all, any of them
  let found = index.search(q)
  if (!found.length && q.includes(' ')) found = index.search(q, { combineWith: 'OR' })
  const local: SearchResult[] = found.map((r) => ({
    noteId: r.id as string,
    title: r.title as string,
    snippet: snippetFor(r.text as string, r.terms),
  }))
  if (!isSyncConfigured() || !navigator.onLine) return local

  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}`), { headers: authHeaders(), signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return local
    const { hits } = (await res.json()) as { hits: { noteId: string; title: string; snippet: string; trashed: boolean; meaning?: boolean }[] }
    const seen = new Set(local.map((r) => r.noteId))
    for (const h of hits) {
      if (!seen.has(h.noteId) && !h.trashed) {
        local.push({ noteId: h.noteId, title: h.title, snippet: h.snippet.replace(/\[\[|\]\]/g, ''), meaning: h.meaning })
      }
    }
    // word matches first, then notes related by meaning
    local.sort((a, b) => Number(Boolean(a.meaning)) - Number(Boolean(b.meaning)))
  } catch {
    /* offline or slow – local results are enough */
  }
  return local
}
