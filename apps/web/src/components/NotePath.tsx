import { ChevronRight, FileText, Folder, FolderMinus, Inbox } from 'lucide-react'
import { useMemo } from 'react'
import { useWorkspace } from '../lib/workspace'
import type { View } from './Sidebar'

/**
 * Where a note is, as breadcrumbs – All Notes › Work › Meetings › this note – at the top of it:
 * a note opened from search, Ask or a link otherwise doesn't say. Tapping a crumb shows that
 * folder (or all notes), with this note in its list.
 */
export function NotePath({ noteId, folderId, onShow }: { noteId: string; folderId: string | null; onShow: (view: View) => void }) {
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
  const title = ws.allNotes.find((n) => n.id === noteId)?.title.trim() || 'Untitled'
  const sep = <ChevronRight size={12} className="note-path-sep" aria-hidden />
  return (
    <nav className="note-path" aria-label="Where this note is">
      <button title="Show all notes" onClick={() => onShow({ kind: 'all' })}>
        <Inbox size={13} aria-hidden /> All Notes
      </button>
      {sep}
      {path.length ? (
        path.map((f) => (
          <span key={f.id} className="note-path-part">
            <button title={`Show the folder “${f.name}”`} onClick={() => onShow({ kind: 'folder', folderId: f.id })}>
              <Folder size={13} aria-hidden /> <span className="note-path-name">{f.name}</span>
            </button>
            {sep}
          </span>
        ))
      ) : (
        <span className="note-path-part">
          <button title="Show the notes in no folder" onClick={() => onShow({ kind: 'unfiled' })}>
            <FolderMinus size={13} aria-hidden /> Not in a folder
          </button>
          {sep}
        </span>
      )}
      <span className="note-path-here" aria-current="page">
        <FileText size={13} aria-hidden /> <span className="note-path-name">{title}</span>
      </span>
    </nav>
  )
}
