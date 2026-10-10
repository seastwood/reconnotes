import { ChevronRight, Folder, Inbox } from 'lucide-react'
import { useMemo } from 'react'
import { useWorkspace } from '../lib/workspace'
import type { View } from './Sidebar'

/**
 * Where a note is: its folder and the folders that one is in (Work › Meetings), at the top of
 * the note – a note opened from search, Ask or a link otherwise doesn't say. Tapping a folder
 * shows it, with this note in its list.
 */
export function NotePath({ folderId, onShow }: { folderId: string | null; onShow: (view: View) => void }) {
  const ws = useWorkspace()
  const path = useMemo(() => {
    const byId = new Map(ws.folders.filter((f) => !f.trashedAt).map((f) => [f.id, f]))
    const out: { id: string; name: string }[] = []
    const seen = new Set<string>()
    for (let f = folderId ? byId.get(folderId) : undefined; f && !seen.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
      seen.add(f.id)
      out.unshift({ id: f.id, name: f.name || 'Untitled folder' })
    }
    return out
  }, [ws.folders, folderId])
  return (
    <nav className="note-path" aria-label="Where this note is">
      {path.length ? (
        <>
          <Folder size={13} aria-hidden />
          {path.map((f, i) => (
            <span key={f.id} className="note-path-part">
              {i > 0 && <ChevronRight size={12} aria-hidden />}
              <button title={`Show the folder “${f.name}”`} onClick={() => onShow({ kind: 'folder', folderId: f.id })}>
                {f.name}
              </button>
            </span>
          ))}
        </>
      ) : (
        <>
          <Inbox size={13} aria-hidden />
          <button title="Show the notes in no folder" onClick={() => onShow({ kind: 'unfiled' })}>
            Not in a folder
          </button>
        </>
      )}
    </nav>
  )
}
