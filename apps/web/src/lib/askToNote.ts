import { effectiveFolderId, folderPaths, getNotes, listFolders, readNote } from '@reconnotes/core'
import { noteFromMarkdown, type MadeLink } from './markdownNotes'
import { workspaceDoc } from './workspace'

/**
 * An Ask answer – or a whole chat – kept as a note
 * ================================================
 *
 * The answer as it reads, its [1] [2] citations links to the notes they
 * point to (each opening where its own sentence came from, as in the chat),
 * and those notes listed under it. Where it goes is yours to choose;
 * the suggestion is where the notes it came from are.
 */

export interface TurnToSave {
  question: string
  answer: string
  sources: { n: number; noteId: string; title: string; section?: string; find?: string }[]
  /** each citation in order: where its own sentence came from */
  cites?: { n: number; find?: string }[]
}

/**
 * One answer, its [1] citations made links (put in as "⟦L<i>⟧", the link `links[i]`), with the
 * notes it cites listed under it.
 */
function answerMarkdown(t: TurnToSave, links: MadeLink[]): string {
  const cited = new Set([...t.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
  let k = -1
  const answer = t.answer.trim().replace(/\[(\d+)\]/g, (m, n: string) => {
    k++
    const s = t.sources.find((x) => x.n === Number(n))
    if (!s) return m
    const cite = t.cites?.[k]
    links.push({ noteId: s.noteId, title: s.title, label: n, find: (cite?.n === s.n ? cite.find : undefined) ?? s.find })
    return `⟦L${links.length - 1}⟧`
  })
  const sources = t.sources.filter((s) => cited.has(s.n))
  const list = sources.map((s) => `- [${s.n}] [[id:${s.noteId}|${s.title.replace(/[\]|]/g, ' ')}]]${s.section ? ` › ${s.section}` : ''}`)
  return [answer, ...(list.length ? ['', '**Sources**', ...list] : [])].join('\n')
}

/** The note's text: one answer under its question, or every question and answer of a chat – and its citations' links. */
export function chatMarkdown(turns: TurnToSave[]): { markdown: string; links: MadeLink[] } {
  const links: MadeLink[] = []
  const markdown = turns.length === 1 ? answerMarkdown(turns[0], links) : turns.map((t) => `## ${t.question.replace(/\n+/g, ' ')}\n\n${answerMarkdown(t, links)}`).join('\n\n')
  return { markdown, links }
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
  const { markdown, links } = chatMarkdown(turns)
  return noteFromMarkdown(markdown, `${title.trim() || turns[0]?.question || 'Answer'}.md`, folderId, links)
}
