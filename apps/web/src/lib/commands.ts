import { useSyncExternalStore } from 'react'

/**
 * Commands for the ⌘K window. Parts of the app register what they can do
 * while they're on screen (the open note adds note commands), so the window
 * only offers what makes sense right now.
 */
export interface Command {
  id: string
  label: string
  section: string
  /** extra words to match ("delete" also finds "trash") */
  keywords?: string
  shortcut?: string
  run: () => void
}

const groups = new Map<string, Command[]>()
const listeners = new Set<() => void>()
let all: Command[] = []

function changed() {
  all = [...groups.values()].flat()
  listeners.forEach((l) => l())
}

/** Offer these commands until the returned function is called. */
export function registerCommands(owner: string, commands: Command[]): () => void {
  groups.set(owner, commands)
  changed()
  return () => {
    if (groups.get(owner) === commands) {
      groups.delete(owner)
      changed()
    }
  }
}

export function useCommands(): Command[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => all,
  )
}

/**
 * How well `query` matches `text`: higher is better, 0 is no match. Whole
 * words and word starts beat letters scattered through the text.
 */
export function matchScore(text: string, query: string): number {
  const t = text.toLocaleLowerCase()
  const q = query.toLocaleLowerCase().trim()
  if (!q) return 1
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  const at = t.indexOf(q)
  if (at > 0 && /[\s\-_/#·]/.test(t[at - 1])) return 60
  if (at >= 0) return 40
  // every word of the query appears somewhere
  const words = q.split(/\s+/)
  if (words.length > 1 && words.every((w) => t.includes(w))) return 30
  // the letters in order (e.g. "nn" → "new note"), favouring word starts
  let i = 0
  let score = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      score += j === 0 || /[\s\-_/]/.test(t[j - 1]) ? 3 : 1
      i++
    }
  }
  return i === q.length ? Math.min(25, 5 + score) : 0
}
