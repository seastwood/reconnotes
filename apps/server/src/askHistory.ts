import type { Store } from './store'
import type { AskCite, AskSource } from './ask'

/**
 * Ask conversations, kept
 * =======================
 *
 * Every question asked – about a note, a folder or all your notes – and its
 * answer are kept as a conversation (follow-ups added to it), apart from
 * the job list (which forgets old jobs). "Ask about this note" lists the
 * conversations about that note, to read again or carry on.
 */

export interface AskTurnSaved {
  question: string
  answer: string
  sources: AskSource[]
  /** each citation's line in its source, in order */
  cites?: AskCite[]
  /** what was read to answer it (sections, or notes) */
  read?: string[]
  /** answered by the AI itself, not from the notes ("Anything" in the chat) */
  general?: boolean
  at: number
}

export interface Conversation {
  /** the first question's job id (follow-ups point to it) */
  id: string
  /** what it was asked about: one note, folders, or everything ('') */
  scope: string
  turns: AskTurnSaved[]
  createdAt: number
  updatedAt: number
}

function table(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS ask_history (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    turns TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ask_history_scope ON ask_history (scope, updated_at)`)
}

/** What a question was about, as a key: "note:<id>", "folders:<ids>", or "" for everything. */
export function scopeKey(input: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).sort() : [])
  const notes = list(input.notes)
  if (notes.length === 1) return `note:${notes[0]}`
  if (notes.length) return `notes:${notes.join(',')}`
  const folders = list(input.folders)
  return folders.length ? `folders:${folders.join(',')}` : ''
}

/** Keep a question and its answer: a new conversation, or the next turn of one. */
export function saveTurn(store: Store, jobId: string, input: Record<string, unknown>, turn: AskTurnSaved) {
  table(store)
  const id = typeof input.thread === 'string' && input.thread ? input.thread : jobId
  const row = store.db.prepare('SELECT turns FROM ask_history WHERE id = ?').get(id) as { turns: string } | undefined
  if (row) {
    const turns = JSON.parse(row.turns) as AskTurnSaved[]
    // asked again (Try again): the newer answer replaces the older
    const same = turns.findIndex((t) => t.question === turn.question)
    if (same >= 0 && same === turns.length - 1) turns[same] = turn
    else turns.push(turn)
    store.db.prepare('UPDATE ask_history SET turns = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(turns), turn.at, id)
  } else {
    store.db.prepare('INSERT INTO ask_history (id, scope, turns, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, scopeKey(input), JSON.stringify([turn]), turn.at, turn.at)
  }
}

export function listConversations(store: Store, scope: string, limit = 50): Conversation[] {
  table(store)
  const rows = store.db.prepare('SELECT * FROM ask_history WHERE scope = ? ORDER BY updated_at DESC LIMIT ?').all(scope, limit) as {
    id: string
    scope: string
    turns: string
    created_at: number
    updated_at: number
  }[]
  return rows.map((r) => ({ id: r.id, scope: r.scope, turns: JSON.parse(r.turns), createdAt: r.created_at, updatedAt: r.updated_at }))
}

export function deleteConversation(store: Store, id: string) {
  table(store)
  store.db.prepare('DELETE FROM ask_history WHERE id = ?').run(id)
}

/** The notes "Ask about this note" also reads for a note (that it refers to). */
export function askRefs(store: Store, noteId: string): string[] {
  return store.getSetting<Record<string, string[]>>('askRefs')?.[noteId] ?? []
}

export function setAskRefs(store: Store, noteId: string, refs: string[]) {
  const all = { ...(store.getSetting<Record<string, string[]>>('askRefs') ?? {}) }
  const list = [...new Set(refs.filter((id) => id !== noteId))].slice(0, 8)
  if (list.length) all[noteId] = list
  else delete all[noteId]
  store.setSetting('askRefs', all)
}
