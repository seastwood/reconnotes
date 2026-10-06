import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export interface AttachmentRow {
  id: string
  mime: string
  name: string
  size: number
  created_at: number
  /** text extracted from the file (OCR, transcript) used for search */
  text: string | null
  text_status: 'pending' | 'done' | 'error' | 'skipped'
}

export interface VersionRow {
  id: number
  createdAt: number
  title: string
  chars: number
  label: string
}

export interface SearchHit {
  noteId: string
  title: string
  snippet: string
  rank: number
}

/**
 * All persistent server state lives in one SQLite database plus a directory of
 * immutable attachment files. Both are easy to back up.
 */
export class Store {
  readonly db: Database.Database
  readonly blobDir: string

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.blobDir = path.join(dataDir, 'blobs')
    fs.mkdirSync(this.blobDir, { recursive: true })
    this.db = new Database(path.join(dataDir, 'reconnotes.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        name TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        text TEXT,
        text_status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS note_attachments (
        note_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        PRIMARY KEY (note_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS note_attachments_att ON note_attachments(attachment_id);
      CREATE TABLE IF NOT EXISTS drawing_ocr (
        note_id TEXT NOT NULL,
        drawing_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (note_id, drawing_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '',
        state BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS versions_doc ON versions(doc_name, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        body,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `)
  }

  // --- Server settings (AI agents etc.) ----------------------------------

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // --- Yjs documents -------------------------------------------------------

  // --- Version history -------------------------------------------------

  addVersion(docName: string, v: { createdAt: number; title: string; chars: number; label?: string; state: Uint8Array }) {
    this.db
      .prepare('INSERT INTO versions (doc_name, created_at, title, chars, label, state) VALUES (?, ?, ?, ?, ?, ?)')
      .run(docName, v.createdAt, v.title, v.chars, v.label ?? '', Buffer.from(v.state))
  }

  listVersions(docName: string): VersionRow[] {
    return this.db
      .prepare('SELECT id, created_at AS createdAt, title, chars, label FROM versions WHERE doc_name = ? ORDER BY created_at DESC, id DESC')
      .all(docName) as VersionRow[]
  }

  getVersionState(docName: string, id: number): Uint8Array | null {
    const r = this.db.prepare('SELECT state FROM versions WHERE doc_name = ? AND id = ?').get(docName, id) as { state: Buffer } | undefined
    return r ? new Uint8Array(r.state) : null
  }

  deleteVersions(ids: number[]) {
    const del = this.db.prepare('DELETE FROM versions WHERE id = ?')
    this.db.transaction(() => ids.forEach((id) => del.run(id)))()
  }

  loadDocument(name: string): Uint8Array | null {
    const row = this.db.prepare('SELECT state FROM documents WHERE name = ?').get(name) as { state: Buffer } | undefined
    return row ? new Uint8Array(row.state) : null
  }

  saveDocument(name: string, state: Uint8Array) {
    this.db
      .prepare(
        `INSERT INTO documents (name, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(name, Buffer.from(state), Date.now())
  }

  listDocuments(prefix = ''): string[] {
    return (this.db.prepare('SELECT name FROM documents WHERE name LIKE ?').all(prefix + '%') as { name: string }[]).map(
      (r) => r.name,
    )
  }

  // --- Attachments ---------------------------------------------------------

  blobPath(id: string): string {
    if (!/^[a-z0-9_-]{8,64}$/i.test(id)) throw new Error('invalid attachment id')
    return path.join(this.blobDir, id.slice(-2), id)
  }

  hasBlob(id: string): boolean {
    return fs.existsSync(this.blobPath(id))
  }

  putAttachment(row: Omit<AttachmentRow, 'text' | 'text_status'>, data: Buffer, status: AttachmentRow['text_status']) {
    const p = this.blobPath(row.id)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, p)
    this.db
      .prepare(
        `INSERT INTO attachments (id, mime, name, size, created_at, text_status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(row.id, row.mime, row.name, row.size, row.created_at, status)
  }

  getAttachment(id: string): AttachmentRow | null {
    return (this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined) ?? null
  }

  setAttachmentText(id: string, text: string | null, status: AttachmentRow['text_status']) {
    this.db.prepare('UPDATE attachments SET text = ?, text_status = ? WHERE id = ?').run(text, status, id)
  }

  attachmentsWithStatus(statuses: AttachmentRow['text_status'][]): AttachmentRow[] {
    return this.db
      .prepare(`SELECT * FROM attachments WHERE text_status IN (${statuses.map(() => '?').join(',')})`)
      .all(...statuses) as AttachmentRow[]
  }

  pendingAttachments(): AttachmentRow[] {
    return this.db.prepare("SELECT * FROM attachments WHERE text_status = 'pending'").all() as AttachmentRow[]
  }

  attachmentTexts(ids: string[]): Record<string, string> {
    if (!ids.length) return {}
    const rows = this.db
      .prepare(`SELECT id, text FROM attachments WHERE id IN (${ids.map(() => '?').join(',')}) AND text IS NOT NULL`)
      .all(...ids) as { id: string; text: string }[]
    return Object.fromEntries(rows.map((r) => [r.id, r.text]))
  }

  notesReferencing(attachmentId: string): string[] {
    return (
      this.db.prepare('SELECT note_id FROM note_attachments WHERE attachment_id = ?').all(attachmentId) as {
        note_id: string
      }[]
    ).map((r) => r.note_id)
  }

  // --- Search --------------------------------------------------------------

  indexNote(noteId: string, title: string, body: string, attachments: string[]) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId)
      this.db.prepare('INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)').run(noteId, title, body)
      this.db.prepare('DELETE FROM note_attachments WHERE note_id = ?').run(noteId)
      const ins = this.db.prepare('INSERT OR IGNORE INTO note_attachments (note_id, attachment_id) VALUES (?, ?)')
      for (const a of attachments) ins.run(noteId, a)
    })
    tx()
  }

  removeNoteFromIndex(noteId: string) {
    this.db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId)
  }

  search(query: string, limit = 50): SearchHit[] {
    const fts = toFtsQuery(query)
    if (!fts) return []
    const run = (q: string) =>
      (
        this.db
          .prepare(
            `SELECT note_id, title,
                    snippet(notes_fts, 2, '[[', ']]', '…', 16) AS snippet,
                    bm25(notes_fts, 4.0, 1.0) AS rank
             FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(q, limit) as { note_id: string; title: string; snippet: string; rank: number }[]
      ).map((r) => ({ noteId: r.note_id, title: r.title, snippet: r.snippet, rank: r.rank }))
    const hits = run(fts)
    // few results: allow small spelling differences (handwriting is sometimes read
    // a letter off, and typing has typos) – "leutenant" still finds "lieutenant"
    if (hits.length < 3) {
      const fuzzy = this.fuzzyQuery(query)
      if (fuzzy && fuzzy !== fts) {
        const seen = new Set(hits.map((h) => h.noteId))
        for (const h of run(fuzzy)) if (!seen.has(h.noteId)) hits.push(h)
      }
    }
    return hits
  }

  /** Each word OR the indexed words within one or two letters of it. */
  private fuzzyQuery(query: string): string | null {
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_vocab USING fts5vocab(notes_fts, 'row')")
    const terms = query
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .slice(0, 8)
    if (!terms.length) return null
    const groups = terms.map((t) => {
      const alts = new Set([`"${t.replace(/"/g, '')}"*`])
      if (t.length >= 4) {
        const tol = t.length <= 5 ? 1 : 2
        const next = String.fromCodePoint(t.codePointAt(0)! + 1)
        const vocab = this.db.prepare('SELECT term FROM notes_fts_vocab WHERE term >= ? AND term < ? LIMIT 20000').all(t[0], next) as { term: string }[]
        for (const { term } of vocab) {
          // the index holds word stems ("lieuten"): compare with the same length of the query word
          if (term.length < 3 || term.length < t.length - 4 || term.length > t.length + 2) continue
          let d = Infinity
          for (let k = term.length - 1; k <= Math.min(t.length, term.length + 1); k++) if (k > 0) d = Math.min(d, levenshtein(t.slice(0, k), term))
          if (d <= tol) alts.add(`"${term}"*`)
          if (alts.size > 12) break
        }
      }
      return alts.size > 1 ? `(${[...alts].join(' OR ')})` : [...alts][0]
    })
    return groups.join(' AND ')
  }

  /** Notes matching ANY of the words (best first) – for "Ask your notes". */
  searchAny(words: string[], limit = 8): { noteId: string; rank: number }[] {
    const terms = words.map((w) => w.normalize('NFKC').replace(/[^\p{L}\p{N}_]+/gu, '')).filter(Boolean).slice(0, 16)
    if (!terms.length) return []
    const rows = this.db
      .prepare(`SELECT note_id, bm25(notes_fts, 4.0, 1.0) AS rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(terms.map((t) => `"${t}"*`).join(' OR '), limit) as { note_id: string; rank: number }[]
    return rows.map((r) => ({ noteId: r.note_id, rank: r.rank }))
  }

  // --- Handwriting recognition bookkeeping --------------------------------

  /** Forget which drawings were recognised (so all are read again). */
  clearDrawingHashes() {
    this.db.exec('DELETE FROM drawing_ocr')
  }

  drawingHash(noteId: string, drawingId: string): string | null {
    const row = this.db
      .prepare('SELECT hash FROM drawing_ocr WHERE note_id = ? AND drawing_id = ?')
      .get(noteId, drawingId) as { hash: string } | undefined
    return row?.hash ?? null
  }

  setDrawingHash(noteId: string, drawingId: string, hash: string) {
    this.db
      .prepare(
        `INSERT INTO drawing_ocr (note_id, drawing_id, hash, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(note_id, drawing_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
      )
      .run(noteId, drawingId, hash, Date.now())
  }

  close() {
    this.db.close()
  }
}

/**
 * Turn free text typed by a user into a safe FTS5 query: every word becomes a
 * quoted prefix term, so "meet john" matches "meeting with Johnny".
 */
/** Edit distance (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

export function toFtsQuery(q: string): string {
  const terms = q
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12)
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')
}
