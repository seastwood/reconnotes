import { noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { RULE_ID, definesRule } from './sections'
import { askRefs } from './askHistory'
import { listImports, unwrapLink } from './webImport'

/**
 * What a note refers to, and where it is
 * ======================================
 *
 * A note (a game manual) can point to other documents for details: a link
 * ("constructed as in the [FRC 2025 Game Manual](…2025GameManual.pdf)"), a
 * document by name ("the 2025 Game Manual"), and rules it uses without
 * saying them (R402). Each is looked for among your notes – a note imported
 * from that address (or that same PDF), a note with that name, a note that
 * defines the rule – and what isn't found is missing: a link can be
 * imported, the rest added by hand.
 */

export interface DocumentRef {
  /** how the note names it */
  name: string
  url?: string
  /** your notes that are it */
  found: { noteId: string; title: string }[]
}

export interface RuleRef {
  id: string
  /** your notes that define it */
  definedIn: { noteId: string; title: string }[]
}

export interface Suggestion {
  noteId: string
  title: string
  /** why: "linked as “FRC 2025 Game Manual”", "defines R402, R403" */
  reasons: string[]
}

export interface References {
  documents: DocumentRef[]
  rules: RuleRef[]
  /** notes to read with it (not already chosen), best first */
  suggestions: Suggestion[]
  /** documents linked to but not in your notes (can be imported) */
  missing: DocumentRef[]
  /** rules it uses that no note defines */
  missingRules: string[]
}

/** A document's kind of name: what makes a link or a phrase a reference to read, not any web page. */
const DOC_WORD = /\b(manual|guide|handbook|rule ?book|rules|specification|spec|standard|datasheet|data sheet|reference|documentation|instructions)\b/i

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length > 1 && !/^(the|of|and|for|a|an)$/.test(w)) ?? []

/** An address, compared: no scheme, "www.", query, fragment or trailing slash. */
const sameAddress = (u: string) => {
  try {
    const x = new URL(u)
    return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`.toLowerCase()
  } catch {
    return u.toLowerCase()
  }
}
const fileName = (u: string) => {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').pop() ?? '').toLowerCase()
  } catch {
    return ''
  }
}

/** How well a title matches a document's name: the share of the name's words in it (its years must be). */
function nameMatch(name: string, title: string): number {
  const n = words(name)
  const t = new Set(words(title))
  if (!n.length) return 0
  const years = n.filter((w) => /^(19|20)\d\d$/.test(w))
  if (years.some((y) => !t.has(y))) return 0
  return n.filter((w) => t.has(w)).length / n.length
}

export function findReferences(store: Store, sync: SyncEngine, noteId: string): References {
  const meta = sync.noteMeta()
  const doc = sync.getDoc(noteDocName(noteId))
  const md = doc ? noteToMarkdown(doc) : ''
  const own = meta.get(noteId)
  // not this note, nor a copy of it (imported from the same place)
  const others = [...meta.values()].filter((m) => m.id !== noteId && !m.trashedAt && !m.template && !(own?.source && m.source && sameAddress(m.source) === sameAddress(own.source)))
  const live = new Set(others.map((o) => o.id))
  const imports = listImports(store)
  const titleOf = (id: string) => meta.get(id)?.title || 'Untitled'

  // 1. documents it links to (a PDF, or a link named like a manual)
  const documents = new Map<string, DocumentRef>()
  for (const m of md.matchAll(/\[([^\]]+)\]\(<?(https?:\/\/[^)\s>]+)>?\)/g)) {
    const text = m[1]
    // a link copied out of a Google Doc or an email goes through a redirect first
    const url = unwrapLink(m[2])
    if (!/\.pdf$/i.test(new URL(url).pathname) && !DOC_WORD.test(text)) continue
    const key = sameAddress(url)
    if (documents.has(key)) continue
    const file = fileName(url)
    const found = others
      .filter((o) => {
        if (!o.source) return false
        // imported from that address – or that same PDF, uploaded from a device
        return sameAddress(o.source) === key || (file.endsWith('.pdf') && fileName(o.source) === file)
      })
      .map((o) => ({ noteId: o.id, title: o.title || 'Untitled' }))
    // imported from it, and the page it led to has another address (a short link, a redirect)
    for (const r of imports)
      if (sameAddress(unwrapLink(r.url)) === key)
        for (const id of [...Object.values(r.pages).map((p) => p.noteId), ...(r.contentsNoteId ? [r.contentsNoteId] : [])])
          if (live.has(id) && !found.some((f) => f.noteId === id)) found.push({ noteId: id, title: titleOf(id) })
    // not imported from it: a note with its name
    if (!found.length)
      for (const o of others) if (nameMatch(text, o.title) >= 0.75) found.push({ noteId: o.id, title: o.title || 'Untitled' })
    documents.set(key, { name: text.replace(/[*_`]/g, '').trim(), url, found })
  }
  // 2. documents named without a link ("the 2025 FRC Game Manual")
  const linked = [...documents.values()].map((d) => d.name.toLowerCase())
  // its own cover ("MinneTrials … 2026 GAME MANUAL"): a name there is the note itself
  const cover = md
    .split('\n')
    .filter((l) => !/^\W*From\b/.test(l))
    .join('\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .slice(0, 400)
  for (const m of md.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').matchAll(/\b((?:[A-Z0-9][\w&'’-]*\s+){1,5}(?:Game\s+)?(?:Manual|Guide|Handbook|Rulebook|Specification|Datasheet))\b/g)) {
    const name = m[1].replace(/\s+/g, ' ').trim()
    if (linked.some((l) => l.includes(name.toLowerCase()) || name.toLowerCase().includes(l))) continue
    // the note's own title ("Minnetrials Manual") is the note itself
    if (nameMatch(name, titleOf(noteId)) >= 0.75 || nameMatch(name, cover) === 1) continue
    const key = `name:${name.toLowerCase()}`
    if (documents.has(key)) continue
    const found = others.filter((o) => nameMatch(name, o.title) >= 0.75).map((o) => ({ noteId: o.id, title: o.title || 'Untitled' }))
    documents.set(key, { name, found })
  }

  // 3. rules it uses without saying them, and the notes that do
  const all = [...new Set([...md.matchAll(RULE_ID)].map((m) => m[0]))]
  // rule families the note itself writes rules in (R, G…): not model numbers like "NEO550"
  const families = new Set(all.filter((r) => definesRule(md, r)).map((r) => r.replace(/\d+$/, '')))
  const used = all.filter((r) => !definesRule(md, r))
  const texts = new Map<string, string>()
  const textOf = (id: string) => {
    if (!texts.has(id)) {
      const d = sync.getDoc(noteDocName(id))
      texts.set(id, d ? noteToMarkdown(d) : '')
    }
    return texts.get(id)!
  }
  const rules: RuleRef[] = used.slice(0, 80).map((id) => {
    const hits = store
      .searchAny([id.toLowerCase()], 20)
      .map((h) => h.noteId)
      .filter((n) => n !== noteId && meta.get(n) && !meta.get(n)!.trashedAt)
    return { id, definedIn: hits.filter((n) => definesRule(textOf(n), id)).map((n) => ({ noteId: n, title: titleOf(n) })) }
  }).filter((r) => r.definedIn.length || families.has(r.id.replace(/\d+$/, '')))

  // 4. what to read with it: those notes, with the reasons
  const chosen = new Set(askRefs(store, noteId))
  const reasons = new Map<string, string[]>()
  const why = (id: string, r: string) => reasons.set(id, [...(reasons.get(id) ?? []), r])
  // what a chosen note already covers needs no other note
  const covered = (found: { noteId: string }[]) => found.some((f) => chosen.has(f.noteId))
  for (const d of documents.values())
    if (!covered(d.found)) for (const f of d.found) why(f.noteId, d.url ? `linked as “${d.name}”` : `named “${d.name}”`)
  const byNote = new Map<string, string[]>()
  for (const r of rules) if (!covered(r.definedIn)) for (const f of r.definedIn) byNote.set(f.noteId, [...(byNote.get(f.noteId) ?? []), r.id])
  for (const [id, ids] of byNote) why(id, `defines ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ` and ${ids.length - 4} more` : ''}`)
  const suggestions = [...reasons]
    .filter(([id]) => !chosen.has(id))
    .map(([id, r]) => ({ noteId: id, title: titleOf(id), reasons: r, weight: r.length + (byNote.get(id)?.length ?? 0) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map(({ weight: _w, ...s }) => s)

  const docs = [...documents.values()]
  return {
    documents: docs,
    rules,
    suggestions,
    missing: docs.filter((d) => d.url && !d.found.length),
    missingRules: rules.filter((r) => !r.definedIn.length).map((r) => r.id),
  }
}
