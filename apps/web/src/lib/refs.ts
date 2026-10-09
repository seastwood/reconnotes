import { api } from './api'
import { Store, useStore } from './store'

/**
 * A note's references: the notes "Ask about this note" also reads (the
 * manual it refers to…). Every note's, kept on the server – loaded once for
 * the counts in the list, and kept up to date as they're changed here.
 */
interface RefsState {
  all: Record<string, string[]>
  loaded: boolean
  /** the note whose references are shown in the References window */
  open: string | null
}

export const refsStore = new Store<RefsState>({ all: {}, loaded: false, open: null })

let loading: Promise<void> | null = null
export function loadRefs(force = false) {
  if (loading && !force) return loading
  loading = api<{ all: Record<string, string[]> }>('GET', '/api/ask/refs')
    .then((r) => refsStore.set({ all: r.all ?? {}, loaded: true }))
    .catch(() => {
      loading = null
    })
  return loading
}

/** A note's references (loading them all the first time). */
export function useRefs(noteId: string): string[] {
  const refs = useStore(refsStore, (s) => s.all[noteId])
  if (!refsStore.get().loaded) void loadRefs()
  return refs ?? NONE
}
const NONE: string[] = []

export function saveRefs(noteId: string, refs: string[]) {
  const next = [...new Set(refs.filter((id) => id !== noteId))]
  refsStore.set((s) => ({ all: { ...s.all, [noteId]: next } }))
  return api<{ refs: string[] }>('PUT', '/api/ask/refs', { noteId, refs: next })
    .then((r) => refsStore.set((s) => ({ all: { ...s.all, [noteId]: r.refs } })))
    .catch(() => {})
}

export const openRefs = (noteId: string) => refsStore.set({ open: noteId })
export const closeRefs = () => refsStore.set({ open: null })
