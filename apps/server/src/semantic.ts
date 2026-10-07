import { createHash } from 'node:crypto'
import type { Store } from './store'
import type { AgentRegistry } from './agents'
import { log } from './log'
import { STOP } from './ask'

/**
 * Search by meaning
 * =================
 *
 * Each note's text (typed text, recognised handwriting, text in pictures,
 * transcripts) is split into passages, and an embedding model (e.g.
 * nomic-embed-text on Ollama, ~300 MB) turns each passage into a vector that
 * captures what it's about. A search turns the query into a vector too and
 * finds the passages pointing the same way – so "safety equipment" finds a
 * note about "safety glasses", even with no word in common.
 *
 * Vectors are kept per passage with a hash of its text, so editing a note
 * only re-embeds the passages that changed.
 */

const CHUNK = 700
const MAX_CHUNKS = 40

export interface MeaningHit {
  noteId: string
  score: number
  /** the passage that matched best */
  passage: string
}

/** A note's text in passages of about CHUNK characters, split at paragraph and sentence ends. */
export function passages(title: string, text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const para of `${title}\n\n${text}`.split(/\n\s*\n+/)) {
    const pieces = para.length > CHUNK ? (para.match(/[^.!?\n]+[.!?]*\s*/g) ?? [para]) : [para]
    for (const piece of pieces) {
      if (cur && cur.length + piece.length > CHUNK) {
        out.push(cur.trim())
        cur = ''
      }
      cur += (cur ? '\n' : '') + piece
    }
  }
  if (cur.trim()) out.push(cur.trim())
  // every passage carries the title, so it keeps its context
  return out
    .filter((p) => p.replace(/\W/g, '').length >= 3)
    .slice(0, MAX_CHUNKS)
    .map((p, i) => (i === 0 || !title ? p : `${title}: ${p}`))
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex')

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

interface Row {
  note_id: string
  chunk: number
  text_hash: string
  model: string
  passage: string
  vec: Buffer
}

/** words that say nothing about what a note is about (on top of the question words) */
const FILLER = new Set(
  'yeah okay right mean think thing things something really maybe going sure good great much many some more most very well here time times also only even still then each every other another first second third same new old because there their these those were been being have having make made take want said says saying testing test'.split(' '),
)
const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]{3,}/gu) ?? []).filter((w) => !STOP.has(w) && !FILLER.has(w)))

/** too little text to say what a note is about */
const MIN_RELATED_TEXT = 60
const MIN_RELATED_PASSAGE = 25

export class MeaningIndex {
  /** all vectors in memory (a few thousand passages is a few MB), loaded on first search */
  private cache: { noteId: string; passage: string; vec: Float32Array }[] | null = null

  constructor(
    private store: Store,
    private agents: AgentRegistry,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS note_vectors (
        note_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        text_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        passage TEXT NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (note_id, chunk)
      );
    `)
  }

  /** Is there an embedding model to use? */
  get available(): boolean {
    return this.agents.available('embed')
  }

  private modelKey(): string | null {
    const a = this.agents.chain('embed')[0]
    return a ? `${a.kind}|${a.baseUrl}|${a.model}` : null
  }

  private async embed(texts: string[]): Promise<{ vectors: number[][]; model: string }> {
    const { result, agent } = await this.agents.run('embed', async (backend, agent) => {
      if (!backend.embed) throw new Error(`${agent.name} can't make embeddings – use an embedding model such as nomic-embed-text`)
      // nomic-embed-text and friends want a task prefix
      const prefixed = /nomic/i.test(agent.model) ? texts.map((t) => `search_document: ${t}`) : texts
      return backend.embed(prefixed)
    })
    return { vectors: result, model: `${agent.kind}|${agent.baseUrl}|${agent.model}` }
  }

  /** Bring a note's vectors up to date (only changed passages are embedded). Returns how many were embedded. */
  async indexNote(noteId: string, title: string, text: string): Promise<number> {
    const model = this.modelKey()
    if (!model) return 0
    const parts = passages(title, text)
    const existing = new Map(
      (this.store.db.prepare('SELECT * FROM note_vectors WHERE note_id = ?').all(noteId) as Row[]).filter((r) => r.model === model).map((r) => [r.text_hash, r]),
    )
    const missing = parts.map((p, i) => ({ p, i, h: hash(p) })).filter((x) => !existing.has(x.h))
    let made: number[][] = []
    let usedModel = model
    if (missing.length) {
      const r = await this.embed(missing.map((m) => m.p))
      made = r.vectors
      usedModel = r.model
    }
    const fresh = new Map(missing.map((m, k) => [m.h, made[k]]))
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare('DELETE FROM note_vectors WHERE note_id = ?').run(noteId)
      const ins = this.store.db.prepare('INSERT INTO note_vectors (note_id, chunk, text_hash, model, passage, vec) VALUES (?, ?, ?, ?, ?, ?)')
      parts.forEach((p, i) => {
        const h = hash(p)
        const vec = fresh.get(h) ? Buffer.from(new Float32Array(fresh.get(h)!).buffer) : existing.get(h)?.vec
        if (vec) ins.run(noteId, i, h, fresh.get(h) ? usedModel : existing.get(h)!.model, p, vec)
      })
    })
    tx()
    this.cache = null
    return missing.length
  }

  removeNote(noteId: string) {
    this.store.db.prepare('DELETE FROM note_vectors WHERE note_id = ?').run(noteId)
    this.cache = null
  }

  /** Notes that don't have vectors from the current model yet. */
  notesNeedingVectors(noteIds: string[]): string[] {
    const model = this.modelKey()
    if (!model) return []
    const have = new Set((this.store.db.prepare('SELECT DISTINCT note_id FROM note_vectors WHERE model = ?').all(model) as { note_id: string }[]).map((r) => r.note_id))
    return noteIds.filter((id) => !have.has(id))
  }

  private vectors(model: string) {
    this.cache ??= (this.store.db.prepare('SELECT note_id, passage, vec, model FROM note_vectors').all() as Row[])
      .filter((r) => r.model === model)
      .map((r) => ({ noteId: r.note_id, passage: r.passage, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4) }))
    return this.cache
  }

  /**
   * Notes about the same things as this one, closest first: each note's best
   * passage against the gist of this note (the average of its passages).
   * Uses the vectors already made for search – no AI call.
   *
   * Embedding models rate almost any two notes as somewhat alike (0.5–0.65
   * is usual for unrelated text), so a note only counts as related when it's
   * clearly closer than that: above `minScore`, and – in a library big
   * enough to tell – well above how alike notes typically are to this one.
   * Very short notes (a title, a line) say too little to compare.
   */
  related(noteId: string, limit = 5, minScore = 0.7): MeaningHit[] {
    const model = this.modelKey()
    if (!model) return []
    const all = this.vectors(model)
    const own = all.filter((c) => c.noteId === noteId)
    if (!own.length || own.reduce((n, c) => n + c.passage.length, 0) < MIN_RELATED_TEXT) return []
    const gist = new Float32Array(own[0].vec.length)
    for (const c of own) for (let i = 0; i < gist.length; i++) gist[i] += c.vec[i] / own.length
    const best = new Map<string, MeaningHit>()
    for (const c of all) {
      if (c.noteId === noteId || c.passage.length < MIN_RELATED_PASSAGE) continue
      const score = cosine(gist, c.vec)
      const cur = best.get(c.noteId)
      if (!cur || score > cur.score) best.set(c.noteId, { noteId: c.noteId, score, passage: c.passage })
    }
    // how alike notes usually are to this one (all of them, before the word check below)
    const scores = [...best.values()].map((h) => h.score)
    // and they must share what they're about in so many words: at least two
    // uncommon words (in at most a few notes; a #tag counts as its word). Similar "feel" alone
    // (two rambling recordings, two to-do lists) isn't related.
    const textOf = new Map<string, string>()
    for (const c of all) textOf.set(c.noteId, `${textOf.get(c.noteId) ?? ''}\n${c.passage}`)
    const wordSets = new Map([...textOf].map(([id, t]) => [id, wordsOf(t)]))
    const df = new Map<string, number>()
    for (const ws of wordSets.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1)
    const rare = Math.max(3, Math.ceil(wordSets.size * 0.08))
    const mine = wordSets.get(noteId) ?? new Set<string>()
    const sharesTopic = (id: string) => {
      const theirs = wordSets.get(id) ?? new Set<string>()
      let shared = 0
      for (const w of mine) if (theirs.has(w) && (df.get(w) ?? 0) <= rare) shared++
      return shared >= 2
    }
    for (const id of [...best.keys()]) if (!sharesTopic(id)) best.delete(id)

    let floor = minScore
    if (scores.length >= 8) {
      // how alike notes usually are to this one: related ones stand out from that
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length
      const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length)
      floor = Math.max(floor, mean + 2 * sd)
    }
    const ranked = [...best.values()].filter((h) => h.score >= floor).sort((a, b) => b.score - a.score)
    // and close to the best one (not a long tail of maybes)
    return ranked.filter((h) => h.score >= ranked[0].score - 0.1).slice(0, limit)
  }

  /**
   * Notes whose passages are closest in meaning to the query, best first.
   * Asked straight away (not through the job queue) with a short timeout:
   * a search shouldn't wait – without an answer it's plain word search.
   */
  async search(query: string, limit = 12): Promise<MeaningHit[]> {
    const model = this.modelKey()
    if (!model || !query.trim()) return []
    let q: number[]
    try {
      const a = this.agents.chain('embed')[0]!
      const text = /nomic/i.test(a.model) ? `search_query: ${query}` : query
      const r = await Promise.race([
        this.agents.run('embed', (backend) => backend.embed!([text])),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 4000)),
      ])
      q = r.result[0]
    } catch (err) {
      log.warn(`search by meaning skipped: ${(err as Error).message}`)
      return []
    }
    const qv = new Float32Array(q)
    const best = new Map<string, MeaningHit>()
    for (const c of this.vectors(model)) {
      const score = cosine(qv, c.vec)
      const cur = best.get(c.noteId)
      if (!cur || score > cur.score) best.set(c.noteId, { noteId: c.noteId, score, passage: c.passage })
    }
    const ranked = [...best.values()].sort((a, b) => b.score - a.score)
    if (!ranked.length) return []
    // keep the clearly related ones: close to the best match and above a floor
    const top = ranked[0].score
    return ranked.filter((h) => h.score >= Math.max(0.45, top - 0.15)).slice(0, limit)
  }
}
