import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from './Popover'
import { ArrowUpDown, ChevronLeft, FolderInput, PanelLeft, Pin, SquarePen, RotateCcw, Trash2, LayoutTemplate } from 'lucide-react'
import {
  createNote,
  deleteNoteForever,
  effectiveFolderId,
  emptyTrash,
  getSettings,
  moveNote,
  restoreFolder,
  sortNotes,
  updateFolder,
  updateNote,
  type NoteData,
  type SortMode,
} from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { searchNotes, type SearchResult } from '../lib/search'
import { newNoteFromTemplate } from '../lib/templates'
import { SORT_LABELS, getDrag, setDrag, type View } from './Sidebar'

interface Props {
  view: View
  noteId: string | null
  onOpen: (id: string) => void
  onBack?: () => void
  /** show/hide the folders panel (iPad and desktop) */
  onToggleFolders?: () => void
  onMoveNote: (id: string) => void
}

function formatDate(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const diff = (now.getTime() - ts) / 86400000
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString()
}

export function NoteList({ view, noteId, onOpen, onBack, onToggleFolders, onMoveNote }: Props) {
  const ws = useWorkspace()
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [sortMenu, setSortMenu] = useState(false)
  const sortBtn = useRef<HTMLButtonElement>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)

  const liveFolders = useMemo(() => new Set(ws.folders.filter((f) => !f.trashedAt).map((f) => f.id)), [ws.folders])
  const folder = view.kind === 'folder' ? ws.folders.find((f) => f.id === view.folderId) : undefined
  const allSort = (getSettings(workspaceDoc).get('allSort') as SortMode) ?? 'updated'
  const sort: SortMode = folder ? folder.sort : view.kind === 'all' ? allSort : 'updated'

  useEffect(() => {
    if (view.kind !== 'search') return setResults(null)
    let alive = true
    const t = setTimeout(() => void searchNotes(view.query).then((r) => alive && setResults(r)), 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [view])

  const notes: NoteData[] = useMemo(() => {
    if (view.kind === 'trash') return sortNotes(ws.notes.filter((n) => n.trashedAt), 'updated')
    if (view.kind === 'templates') return sortNotes(ws.notes.filter((n) => !n.trashedAt && n.template), 'title')
    if (view.kind === 'folder')
      return sortNotes(
        ws.notes.filter((n) => !n.trashedAt && !n.template && effectiveFolderId(n, liveFolders) === view.folderId),
        sort === 'manual' ? 'manual' : sort,
      )
    if (view.kind === 'all') return sortNotes(ws.notes.filter((n) => !n.trashedAt && !n.template), sort)
    if (view.kind === 'tag') return sortNotes(ws.notes.filter((n) => !n.trashedAt && !n.template && n.tags.includes(view.tag)), 'updated')
    return []
  }, [ws.notes, view, sort, liveFolders])

  const title =
    view.kind === 'all'
      ? 'All Notes'
      : view.kind === 'trash'
        ? 'Recently Deleted'
        : view.kind === 'search'
          ? 'Search'
          : view.kind === 'tag'
            ? `#${view.tag}`
            : view.kind === 'templates'
              ? 'Templates'
              : (folder?.name ?? 'Folder')

  const setSort = (m: SortMode) => {
    if (folder) updateFolder(workspaceDoc, folder.id, { sort: m })
    else getSettings(workspaceDoc).set('allSort', m)
  }

  const newNote = () => {
    const id = createNote(workspaceDoc, { folderId: view.kind === 'folder' ? view.folderId : null })
    if (view.kind === 'templates') updateNote(workspaceDoc, id, { template: true })
    onOpen(id)
  }
  const templates = useMemo(() => sortNotes(ws.notes.filter((n) => !n.trashedAt && n.template), 'title'), [ws.notes])
  const [templateMenu, setTemplateMenu] = useState(false)
  const templateBtn = useRef<HTMLButtonElement>(null)
  const fromTemplate = async (templateId: string) => {
    setTemplateMenu(false)
    onOpen(await newNoteFromTemplate(templateId, view.kind === 'folder' ? view.folderId : null))
  }

  const onDropNote = (e: React.DragEvent, target: NoteData, index: number) => {
    e.preventDefault()
    setDropAt(null)
    const p = getDrag(e)
    if (p?.kind !== 'note' || p.id === target.id || view.kind !== 'folder') return
    // Dragging to reorder switches the folder to manual order.
    if (sort !== 'manual') updateFolder(workspaceDoc, view.folderId, { sort: 'manual' })
    const others = notes.filter((n) => n.id !== p.id && !n.pinned)
    const idx = Math.max(0, others.findIndex((n) => n.id === target.id))
    moveNote(workspaceDoc, p.id, view.folderId, index >= 0 ? idx : others.length)
  }

  const trashedFolders = view.kind === 'trash' ? ws.folders.filter((f) => f.trashedAt) : []

  return (
    <section className="note-list">
      <header className="list-head">
        {onBack && (
          <button className="icon" onClick={onBack} aria-label="Back to folders">
            <ChevronLeft size={22} />
          </button>
        )}
        {onToggleFolders && (
          <button className="icon" onClick={onToggleFolders} aria-label="Show folders" title="Show folders">
            <PanelLeft size={20} />
          </button>
        )}
        <h2>{title}</h2>
        {view.kind !== 'search' && view.kind !== 'trash' && view.kind !== 'templates' && view.kind !== 'tag' && (
          <div className="menu-anchor">
            <button ref={sortBtn} className="icon" onClick={() => setSortMenu(!sortMenu)} aria-label="Sort" title={`Sorted by ${SORT_LABELS[sort]}`}>
              <ArrowUpDown size={18} />
            </button>
            {sortMenu && (
              <Popover anchorRef={sortBtn} align="right" onClose={() => setSortMenu(false)}>
                <div className="menu-label">Sort notes by</div>
                {(Object.keys(SORT_LABELS) as SortMode[])
                  .filter((m) => m !== 'manual' || view.kind === 'folder')
                  .map((m) => (
                    <button key={m} className={sort === m ? 'checked' : ''} onClick={() => setSort(m)}>
                      {SORT_LABELS[m]}
                    </button>
                  ))}
              </Popover>
            )}
          </div>
        )}
        {view.kind === 'trash' ? (
          notes.length + trashedFolders.length > 0 && (
            <button className="text danger" onClick={() => confirm('Permanently delete everything in Recently Deleted?') && emptyTrash(workspaceDoc)}>
              Empty
            </button>
          )
        ) : (
          <>
            {templates.length > 0 && view.kind !== 'templates' && (
              <div className="menu-anchor">
                <button ref={templateBtn} className="icon" onClick={() => setTemplateMenu(!templateMenu)} aria-label="New from template" title="New from template">
                  <LayoutTemplate size={19} />
                </button>
                {templateMenu && (
                  <Popover anchorRef={templateBtn} align="right" onClose={() => setTemplateMenu(false)}>
                    <div className="menu-label">New note from template</div>
                    {templates.map((t) => (
                      <button key={t.id} onClick={() => void fromTemplate(t.id)}>
                        {t.title || 'Untitled template'}
                      </button>
                    ))}
                  </Popover>
                )}
              </div>
            )}
            <button className="icon primary" onClick={newNote} aria-label={view.kind === 'templates' ? 'New template' : 'New note'} title={view.kind === 'templates' ? 'New template' : 'New note'}>
              <SquarePen size={20} />
            </button>
          </>
        )}
      </header>

      <ul className="notes">
        {view.kind === 'search' &&
          results?.filter((r) => !ws.notes.find((n) => n.id === r.noteId)?.template).map((r) => (
            <li key={r.noteId} className={`note-row${r.noteId === noteId ? ' active' : ''}`} onClick={() => onOpen(r.noteId)}>
              <div className="note-title">{r.title || 'Untitled'}</div>
              <div className="note-snippet">{r.snippet}</div>
            </li>
          ))}
        {view.kind === 'search' && results && !results.length && <li className="empty-hint">No matches</li>}

        {trashedFolders.map((f) => (
          <li key={f.id} className="note-row trashed-folder">
            <div className="note-title">📁 {f.name}</div>
            <div className="row-actions">
              <button onClick={() => restoreFolder(workspaceDoc, f.id)}>
                <RotateCcw size={14} /> Restore folder
              </button>
            </div>
          </li>
        ))}

        {notes.map((n, i) => (
          <li
            key={n.id}
            className={`note-row${n.id === noteId ? ' active' : ''}${dropAt === n.id ? ' drop-before' : ''}`}
            draggable={view.kind !== 'trash'}
            onDragStart={(e) => setDrag(e, { kind: 'note', id: n.id })}
            onDragOver={(e) => {
              if (view.kind === 'folder') {
                e.preventDefault()
                setDropAt(n.id)
              }
            }}
            onDragLeave={() => setDropAt(null)}
            onDrop={(e) => onDropNote(e, n, i)}
            onClick={() => view.kind !== 'trash' && onOpen(n.id)}
          >
            <div className="note-title">
              {n.pinned && <Pin size={12} className="pin" />} {n.title || 'New Note'}
            </div>
            <div className="note-meta">
              <span className="note-date">{formatDate(n.updatedAt)}</span> <span className="note-snippet">{n.snippet || 'No additional text'}</span>
            </div>
            {view.kind === 'trash' ? (
              <div className="row-actions">
                <button onClick={() => updateNote(workspaceDoc, n.id, { trashedAt: null })}>
                  <RotateCcw size={14} /> Restore
                </button>
                <button className="danger" onClick={() => confirm('Delete this note permanently?') && deleteNoteForever(workspaceDoc, n.id)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            ) : (
              <div className="row-actions hover">
                <button onClick={(e) => (e.stopPropagation(), onMoveNote(n.id))} aria-label="Move note">
                  <FolderInput size={14} />
                </button>
                <button onClick={(e) => (e.stopPropagation(), updateNote(workspaceDoc, n.id, { pinned: !n.pinned }))} aria-label="Pin">
                  <Pin size={14} />
                </button>
                <button onClick={(e) => (e.stopPropagation(), updateNote(workspaceDoc, n.id, { trashedAt: Date.now() }))} aria-label="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </li>
        ))}
        {view.kind !== 'search' && !notes.length && !trashedFolders.length && (
          <li className="empty-hint">{view.kind === 'trash' ? 'Nothing here.' : 'No notes yet.'}</li>
        )}
        {view.kind === 'folder' && notes.length > 0 && (
          <li className="drop-end" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropNote(e, notes[notes.length - 1], -1)} />
        )}
      </ul>
    </section>
  )
}
