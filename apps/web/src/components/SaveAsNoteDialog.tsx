import { useMemo, useState } from 'react'
import { Check, FilePlus2, Folder, Inbox, Sparkles, X } from 'lucide-react'
import { buildTree, type TreeNode } from '@reconnotes/core'
import { useWorkspace } from '../lib/workspace'
import { folderLabel, saveChatAsNote, suggestFolder, type TurnToSave } from '../lib/askToNote'
import { showActionToast, showToast } from '../lib/toast'

/**
 * Save an Ask answer (or the whole chat) as a note: its title, and where it goes – the folder
 * suggested (where the notes it came from are) chosen to start with; any other a tap away.
 */
export function SaveAsNoteDialog({
  turns,
  about,
  onClose,
  onOpen,
}: {
  turns: TurnToSave[]
  /** what the chat was about (its note or folder): the note goes with it by default */
  about: { noteId?: string; folderId?: string }
  onClose: () => void
  onOpen: (noteId: string) => void
}) {
  const ws = useWorkspace()
  const tree = useMemo(() => buildTree(ws.folders, ws.rootSort), [ws.folders, ws.rootSort])
  const suggested = useMemo(() => suggestFolder(turns, about), [turns, about])
  const [folder, setFolder] = useState<string | null>(suggested)
  const [title, setTitle] = useState(() => turns[0]?.question.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      const id = await saveChatAsNote(turns, title, folder)
      onClose()
      showActionToast(`Saved to ${folderLabel(folder)}`, 'Open', () => onOpen(id))
    } catch (e) {
      setBusy(false)
      showToast(`Couldn’t save it: ${(e as Error).message}`)
    }
  }

  const row = (id: string | null, name: string, depth: number, icon: React.ReactNode) => (
    <button key={id ?? 'none'} className={`move-row${folder === id ? ' chosen' : ''}`} style={{ paddingLeft: 12 + depth * 18 }} onClick={() => setFolder(id)} aria-pressed={folder === id}>
      {icon} <span className="move-row-name">{name}</span>
      {id === suggested && (
        <span className="move-row-hint">
          <Sparkles size={12} /> Suggested
        </span>
      )}
      {folder === id && <Check size={16} className="move-row-check" />}
    </button>
  )
  const render = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.folder.id}>
        {row(n.folder.id, n.folder.name, depth, <Folder size={16} />)}
        {render(n.children, depth + 1)}
      </div>
    ))

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog save-note-dialog" role="dialog" aria-label="Save as a note" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{turns.length > 1 ? 'Save the chat as a note' : 'Save the answer as a note'}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <label className="save-note-field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && void save()} />
        </label>
        <p className="hint save-note-where">
          {suggested ? (
            <>
              <Sparkles size={13} /> Suggested: <b>{folderLabel(suggested)}</b>
              {about.noteId || about.folderId ? ' – where this chat’s note is.' : ' – where the notes it came from are.'} Pick another below.
            </>
          ) : (
            'Pick where it goes:'
          )}
        </p>
        <div className="move-list">
          {row(null, 'Not in a folder', 0, <Inbox size={16} />)}
          {render(tree, 0)}
        </div>
        <footer className="save-note-actions">
          <span className="hint">
            In <b>{folderLabel(folder)}</b>
          </span>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            <FilePlus2 size={16} /> Save note
          </button>
        </footer>
      </div>
    </div>
  )
}
