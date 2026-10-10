import { effectiveFolderId, folderPaths, getNotes, listFolders, readNote } from '@reconnotes/core'
import { noteFromMarkdown } from './markdownNotes'
import { workspaceDoc } from './workspace'

/**
 * An Ask answer – or a whole chat – kept as a note
 * ================================================
 *
 * The answer as it reads, its [1] [2] citations kept, with the notes they
 * point to listed (and linked) under it. Where it goes is yours to choose;
 * the suggestion is where the notes it came from are.
 */

export interface TurnToSave {
  question: string
  answer: string
  sources: { n: number; noteId: string; title: string; section?: string }[]
}

/** One answer, with the notes it cites linked under it. */
function answerMarkdown(t: TurnToSave): string {
  const cited = new Set([...t.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
  const sources = t.sources.filter((s) => cited.has(s.n))
  const list = sources.map((s) => `- [${s.n}] [[id:${s.noteId}|${s.title.replace(/[\]|]/g, ' ')}]]${s.section ? ` › ${s.section}` : ''}`)
  return [t.answer.trim(), ...(list.length ? ['', '**Sources**', ...list] : [])].join('\n')
}

/** The note's text: one answer under its question, or every question and answer of a chat. */
export function chatMarkdown(turns: TurnToSave[]): string {
  if (turns.length === 1) return answerMarkdown(turns[0])
  return turns.map((t) => `## ${t.question.replace(/\n+/g, ' ')}\n\n${answerMarkdown(t)}`).join('\n\n')
}

/**
 * Where the note would fit: the folder the chat is about (a note's, a folder's), else the folder
 * most of the answer's citations point into. null: not in a folder.
 */
export function suggestFolder(turns: TurnToSave[], about: { noteId?: string; folderId?: string }): string | null {
  const live = new Set(listFolders(workspaceDoc).filter((f) => !f.trashedAt).map((f) => f.id))
  const notes = getNotes(workspaceDoc)
  const folderOf = (id: string) => {
    const m = notes.get(id)
    return m ? effectiveFolderId(readNote(m), live) : null
  }
  if (about.folderId && live.has(about.folderId)) return about.folderId
  if (about.noteId) return folderOf(about.noteId)
  const count = new Map<string, number>()
  for (const t of turns)
    for (const m of t.answer.matchAll(/\[(\d+)\]/g)) {
      const src = t.sources.find((s) => s.n === Number(m[1]))
      const f = src ? folderOf(src.noteId) : null
      if (f) count.set(f, (count.get(f) ?? 0) + 1)
    }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** A folder's place, for showing: "FRC Robotics › 2026-2027". */
export function folderLabel(folderId: string | null): string {
  if (!folderId) return 'Not in a folder'
  return folderPaths(listFolders(workspaceDoc)).get(folderId)?.join(' › ') ?? 'Folder'
}

/** Make the note. Returns its id. */
export function saveChatAsNote(turns: TurnToSave[], title: string, folderId: string | null): Promise<string> {
  return noteFromMarkdown(chatMarkdown(turns), `${title.trim() || turns[0]?.question || 'Answer'}.md`, folderId)
}
