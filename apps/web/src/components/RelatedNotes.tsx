import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { apiUrl, authHeaders, isSyncConfigured } from '../lib/settings'
import { useFolderAccess } from '../lib/folderLock'

interface Related {
  noteId: string
  title: string
  passage: string
}

// the answers per note while the app is open (they only change as notes are re-read)
const cache = new Map<string, { at: number; list: Related[] }>()

/**
 * "Related notes": notes about the same things as this one, found by meaning
 * (needs an embedding model, e.g. nomic-embed-text, in Settings › AI agents).
 * Shown under the note, next to "Linked from".
 */
export function RelatedNotes({ noteId, onOpen }: { noteId: string; onOpen: (id: string) => void }) {
  const unlocked = useFolderAccess().unlockedIds.join(',')
  const key = `${noteId}|${unlocked}`
  const [list, setList] = useState<Related[]>(() => cache.get(key)?.list ?? [])

  useEffect(() => {
    setList(cache.get(key)?.list ?? [])
    if (!isSyncConfigured()) return
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < 5 * 60_000) return
    const ctrl = new AbortController()
    // a moment after opening: the note itself loads first
    const t = setTimeout(() => {
      fetch(apiUrl(`/api/notes/${noteId}/related?unlocked=${encodeURIComponent(unlocked)}`), { headers: authHeaders(), signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { related: [] }))
        .then((r: { related: Related[] }) => {
          cache.set(key, { at: Date.now(), list: r.related ?? [] })
          setList(r.related ?? [])
        })
        .catch(() => {})
    }, 600)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [key, noteId, unlocked])

  if (!list.length) return null
  return (
    <aside className="linked-from related-notes">
      <h4>Related notes</h4>
      {list.map((n) => (
        <button key={n.noteId} onClick={() => onOpen(n.noteId)} title={n.passage}>
          <Sparkles size={14} /> {n.title || 'Untitled'}
        </button>
      ))}
    </aside>
  )
}
