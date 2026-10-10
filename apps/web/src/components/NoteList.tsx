import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from './Popover'
import { ExpandButton } from './ExpandButton'
import { LockedScreen } from './LockedScreen'
import { useFolderAccess } from '../lib/folderLock'
import { ArrowUpDown, ChevronLeft, Copy, Globe, FolderInput, PanelLeft, Pin, SquarePen, RotateCcw, Trash2, LayoutTemplate, Sparkles, Paperclip, FileText, CircleCheck, Hash, Users, BookOpen, MoreHorizontal, PinOff, MessageCircleQuestion, CheckSquare } from 'lucide-react'
import {
  createNote,
  deleteNoteForever,
  effectiveFolderId,
  emptyTrash,
  getNotes,
  getSettings,
  moveNote,
  readNote,
  restoreFolder,
  sortNotes,
  updateFolder,
  updateNote,
  type NoteData,
  type SortMode,
} from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { newNoteFromTemplate } from '../lib/templates'
import { startMeeting } from '../lib/meeting'
import { DueList } from './DueList'
import { TasksList } from './TasksList'
import { useProgressive } from '../lib/progressive'
import { addFilesToFolder, fileKind, formatSize } from '../lib/files'
import { SORT_LABELS, getDrag, setDrag, type View } from './Sidebar'
import { NoteRow } from './NoteRow'
import { moveNotes, pinNotes, restoreNotes, tagNotes, trashNotes } from '../lib/noteActions'
import { duplicateNote, saveAsTemplate } from '../lib/templates'
import { openAskChat } from '../lib/askChat'
import { WebImportDialog } from './WebImportDialog'
import { useStore } from '../lib/store'
import { loadRefs, openRefs, refsStore } from '../lib/refs'

interface Props {
  view: View
  noteId: string | null
  /** `find`: where in the note to land (a due item's or a to-do's text) */
  onOpen: (id: string, find?: string) => void
  onBack?: () => void
  /** show/hide the folders panel (iPad and desktop) */
  onToggleFolders?: () => void
  /** iPad / computer: the column is widened over the note area */
  expanded?: boolean
  onToggleExpand?: () => void
  onMoveNote: (id: string) => void
  /** move several notes (pick a folder) */
  onMoveNotes: (ids: string[]) => void
}

function formatDate(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const diff = (now.getTime() - ts) / 86400000
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString()
}

export function NoteList({ view, noteId, onOpen, onBack, onToggleFolders, expanded, onToggleExpand, onMoveNote, onMoveNotes }: Props) {
  // how many references each note has (the notes Ask reads with it)
  const allRefs = useStore(refsStore, (s) => s.all)
  useEffect(() => void loadRefs(), [])
  const liveRef = (id: string) => {
    const m = getNotes(workspaceDoc).get(id)
    return Boolean(m && !readNote(m).trashedAt)
  }
  const ws = useWorkspace()
  const [sortMenu, setSortMenu] = useState(false)
  const sortBtn = useRef<HTMLButtonElement>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  /** select mode: several notes at once */
  const [selecting, setSelecting] = useState(false)
  // the ••• menu of a note in the list
  const [menuFor, setMenuFor] = useState<{ id: string; anchor: { current: HTMLElement | null } } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastPicked = useRef<string | null>(null)
  const stopSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  // a different list: start over
  useEffect(() => stopSelecting(), [view.kind, view.kind === 'folder' ? view.folderId : view.kind === 'tag' ? view.tag : ''])
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stopSelecting()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  const liveFolders = useMemo(() => new Set(ws.folders.filter((f) => !f.trashedAt).map((f) => f.id)), [ws.folders])
  const folder = view.kind === 'folder' ? ws.folders.find((f) => f.id === view.folderId) : undefined
  const access = useFolderAccess()
  const lockedBy = view.kind === 'folder' && access.lockedFolder(view.folderId) ? access.lockOwner(view.folderId) : null
  const allSort = (getSettings(workspaceDoc).get('allSort') as SortMode) ?? 'updated'
  const sort: SortMode = folder ? folder.sort : view.kind === 'all' || view.kind === 'unfiled' ? allSort : 'updated'

  const notes: NoteData[] = useMemo(() => {
    if (view.kind === 'trash') return sortNotes(ws.notes.filter((n) => n.trashedAt), 'updated')
    if (view.kind === 'templates') return sortNotes(ws.notes.filter((n) => !n.trashedAt && n.template), 'title')
    if (view.kind === 'folder')
      return sortNotes(
        ws.notes.filter((n) => !n.trashedAt && !n.template && effectiveFolderId(n, liveFolders) === view.folderId),
        sort === 'manual' ? 'manual' : sort,
      )
    if (view.kind === 'all') return sortNotes(ws.notes.filter((n) => !n.trashedAt && !n.template), sort)
    if (view.kind === 'unfiled') return sortNotes(ws.notes.filter((n) => !n.trashedAt && !n.template && !effectiveFolderId(n, liveFolders)), sort)
    if (view.kind === 'tag') return sortNotes(ws.notes.filter((n) => !n.trashedAt && !n.template && n.tags.includes(view.tag)), 'updated')
    return []
  }, [ws.notes, view, sort, liveFolders])

  const title =
    view.kind === 'all'
      ? 'All Notes'
      : view.kind === 'unfiled'
        ? 'Not in a folder'
      : view.kind === 'trash'
        ? 'Recently Deleted'
        : view.kind === 'tag'
            ? `#${view.tag}`
            : view.kind === 'templates'
              ? 'Templates'
              : view.kind === 'due'
                ? 'Due'
              : view.kind === 'tasks'
                ? 'Tasks'
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
  // Add files straight into the folder (each becomes an item holding the file)
  const filesInput = useRef<HTMLInputElement>(null)
  const canAddFiles = view.kind === 'folder' || view.kind === 'all' || view.kind === 'unfiled'
  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const ids = await addFilesToFolder(files, view.kind === 'folder' ? view.folderId : null)
    if (ids.length === 1) onOpen(ids[0])
  }
  const [fileDrop, setFileDrop] = useState(false)
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

  const [webImport, setWebImport] = useState(false)
  const trashedFolders = view.kind === 'trash' ? ws.folders.filter((f) => f.trashedAt) : []
  // big folders: rows in pieces as you scroll (the open note always shown)
  const shown = useProgressive(notes.length, JSON.stringify(view), notes.findIndex((n) => n.id === noteId))
  const canSelect = notes.length > 0 && view.kind !== 'due' && view.kind !== 'tasks'
  const ids = [...selected].filter((id) => notes.some((n) => n.id === id))

  const clickRow = (e: React.MouseEvent, n: NoteData) => {
    const toggle = selecting || e.metaKey || e.ctrlKey
    if (e.shiftKey && (selecting || noteId)) {
      // a range, from the last picked (or open) note to this one
      const from = notes.findIndex((x) => x.id === (lastPicked.current ?? noteId))
      const to = notes.findIndex((x) => x.id === n.id)
      if (from >= 0 && to >= 0) {
        const next = new Set(selected)
        for (const x of notes.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x.id)
        setSelected(next)
        setSelecting(true)
        lastPicked.current = n.id
        return
      }
    }
    if (toggle) {
      const next = new Set(selected)
      // ⌘-click with nothing selected yet: start from the open note too
      if (!selecting && noteId && noteId !== n.id && notes.some((x) => x.id === noteId)) next.add(noteId)
      if (next.has(n.id)) next.delete(n.id)
      else next.add(n.id)
      setSelected(next)
      setSelecting(true)
      lastPicked.current = n.id
      return
    }
    if (view.kind !== 'trash') onOpen(n.id)
  }

  return (
    <section
      className={`note-list${fileDrop ? ' file-drop' : ''}`}
      onDragOver={(e) => {
        if (canAddFiles && e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setFileDrop(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDrop(false)
      }}
      onDrop={(e) => {
        if (!canAddFiles || !e.dataTransfer.files.length) return
        e.preventDefault()
        setFileDrop(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
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
        <span className="list-head-gap" />
        {onToggleExpand && <ExpandButton expanded={Boolean(expanded)} onToggle={onToggleExpand} />}
        {canSelect && (
          <button
            className={`icon${selecting ? ' on' : ''}`}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            aria-label={selecting ? 'Done selecting' : 'Select notes'}
            title={selecting ? 'Done (Esc)' : 'Select several notes (or ⌘-click / Shift-click)'}
          >
            <CircleCheck size={19} />
          </button>
        )}
        {view.kind !== 'trash' && view.kind !== 'templates' && view.kind !== 'tag' && view.kind !== 'due' && view.kind !== 'tasks' && (
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
            {canAddFiles && (
              <>
                <button className="icon" onClick={() => filesInput.current?.click()} aria-label="Add files" title="Add files (PDFs, documents, spreadsheets…)">
                  <Paperclip size={19} />
                </button>
                <input
                  ref={filesInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? [])
                    e.target.value = ''
                    void addFiles(files)
                  }}
                />
              </>
            )}
            {view.kind !== 'templates' && (
              <button className="icon" onClick={() => setWebImport(true)} aria-label="Import a web page" title="Import a web page – a guide, manual or article, with its pictures">
                <Globe size={19} />
              </button>
            )}
            {view.kind !== 'templates' && (
              <button className="icon" onClick={() => void startMeeting(view.kind === 'folder' ? view.folderId : null).then(onOpen)} aria-label="New meeting" title="New meeting – records, then writes a summary, decisions and action items">
                <Users size={19} />
              </button>
            )}
            <button className="icon primary" onClick={newNote} aria-label={view.kind === 'templates' ? 'New template' : 'New note'} title={view.kind === 'templates' ? 'New template' : 'New note'}>
              <SquarePen size={20} />
            </button>
          </>
        )}
      </header>
      {/* the folder's name on a line of its own, under the buttons – not squeezed between them */}
      <h2 className="list-title">{selecting ? (selected.size ? `${selected.size} selected` : 'Select notes') : title}</h2>

      {lockedBy && <LockedScreen folderId={lockedBy} what="folder" />}
      <ul className="notes" hidden={Boolean(lockedBy)}>
        {view.kind === 'due' && <DueList activeNoteId={noteId} onOpen={onOpen} />}
        {view.kind === 'tasks' && <TasksList activeNoteId={noteId} onOpen={onOpen} />}

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

        {notes.slice(0, shown.limit).map((n, i) => (
          <NoteRow
            key={n.id}
            id={n.id}
            className={`note-row${n.id === noteId && !selecting ? ' active' : ''}${dropAt === n.id ? ' drop-before' : ''}`}
            pinned={n.pinned}
            selecting={selecting}
            selected={selected.has(n.id)}
            draggable={view.kind !== 'trash'}
            onClick={(e) => clickRow(e, n)}
            onPin={() => pinNotes([n.id], !n.pinned)}
            onMove={() => onMoveNote(n.id)}
            onDelete={() => (view.kind === 'trash' ? confirm('Delete this note permanently?') && deleteNoteForever(workspaceDoc, n.id) : trashNotes([n.id]))}
            liProps={{
              onDragStart: (e) => setDrag(e, { kind: 'note', id: n.id, ids: selected.has(n.id) && selected.size > 1 ? ids : undefined }),
              onDragOver: (e) => {
                if (view.kind === 'folder') {
                  e.preventDefault()
                  setDropAt(n.id)
                }
              },
              onDragLeave: () => setDropAt(null),
              onDrop: (e) => onDropNote(e, n, i),
            }}
          >
            <div className="note-title">
              {n.pinned && <Pin size={12} className="pin" />} {n.file && <FileText size={14} className="file-mark" />}
              {view.kind !== 'trash' && (allRefs[n.id]?.filter(liveRef).length ?? 0) > 0 && (
                <button
                  className="ref-badge"
                  title="References – the notes Ask reads with this one"
                  aria-label={`${allRefs[n.id].filter(liveRef).length} references`}
                  onClick={(e) => (e.stopPropagation(), openRefs(n.id))}
                >
                  <BookOpen size={12} /> {allRefs[n.id].filter(liveRef).length}
                </button>
              )}
              {n.title || 'New Note'}
            </div>
            <div className="note-meta">
              <span className="note-date">{formatDate(n.updatedAt)}</span>{' '}
              <span className="note-snippet">
                {n.file
                  ? [fileKind(n.file.name, n.file.mime), formatSize(n.file.size), n.snippet && n.snippet !== n.file.name ? n.snippet : ''].filter(Boolean).join(' · ')
                  : n.snippet || 'No additional text'}
              </span>
            </div>
            {selecting ? null : view.kind === 'trash' ? (
              <div className="row-actions">
                <button onClick={(e) => (e.stopPropagation(), restoreNotes([n.id]))}>
                  <RotateCcw size={14} /> Restore
                </button>
                <button className="danger" onClick={(e) => (e.stopPropagation(), confirm('Delete this note permanently?') && deleteNoteForever(workspaceDoc, n.id))}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            ) : (
              <button
                className={`row-more${menuFor?.id === n.id ? ' open' : ''}`}
                aria-label="Note actions"
                title="More"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuFor(menuFor?.id === n.id ? null : { id: n.id, anchor: { current: e.currentTarget } })
                }}
              >
                <MoreHorizontal size={18} />
              </button>
            )}
          </NoteRow>
        ))}
        {shown.limit < notes.length && <li ref={shown.sentinel} className="empty-hint">Loading more notes…</li>}
        {view.kind !== 'due' && view.kind !== 'tasks' && !notes.length && !trashedFolders.length && (
          <li className="empty-hint">{view.kind === 'trash' ? 'Nothing here.' : 'No notes yet.'}</li>
        )}
        {view.kind === 'folder' && notes.length > 0 && (
          <li className="drop-end" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropNote(e, notes[notes.length - 1], -1)} />
        )}
      </ul>
      {menuFor &&
        (() => {
          const n = notes.find((x) => x.id === menuFor.id)
          if (!n) return null
          const act = (f: () => unknown) => () => {
            setMenuFor(null)
            void Promise.resolve(f()).catch((e) => alert((e as Error).message))
          }
          return (
            <Popover anchorRef={menuFor.anchor} align="right" onClose={() => setMenuFor(null)}>
              <div className="menu-label">{n.title || 'New Note'}</div>
              <button onClick={act(() => openAskChat({ noteId: n.id, title: n.title }))}>
                <MessageCircleQuestion size={16} /> Ask about this note
              </button>
              <button onClick={act(() => openRefs(n.id))}>
                <BookOpen size={16} /> References…
              </button>
              <div className="menu-sep" />
              <button onClick={act(() => pinNotes([n.id], !n.pinned))}>
                {n.pinned ? <PinOff size={16} /> : <Pin size={16} />} {n.pinned ? 'Unpin' : 'Pin to top'}
              </button>
              <button onClick={act(() => onMoveNote(n.id))}>
                <FolderInput size={16} /> Move to folder…
              </button>
              <button onClick={act(async () => onOpen(await duplicateNote(n.id)))}>
                <Copy size={16} /> Duplicate
              </button>
              {!n.template && (
                <button onClick={act(() => saveAsTemplate(n.id))}>
                  <LayoutTemplate size={16} /> Save as template
                </button>
              )}
              <button
                onClick={act(() => {
                  setSelecting(true)
                  setSelected(new Set([n.id]))
                })}
              >
                <CheckSquare size={16} /> Select notes…
              </button>
              <div className="menu-sep" />
              <button className="danger" onClick={act(() => trashNotes([n.id]))}>
                <Trash2 size={16} /> Move to Trash
              </button>
            </Popover>
          )
        })()}
      {selecting && (
        <div className="select-bar">
          <button className="text" onClick={() => setSelected(selected.size === notes.length ? new Set() : new Set(notes.map((n) => n.id)))}>
            {selected.size === notes.length ? 'Select none' : 'Select all'}
          </button>
          <span className="spacer" />
          {view.kind === 'trash' ? (
            <>
              <button disabled={!ids.length} onClick={() => (restoreNotes(ids), stopSelecting())}>
                <RotateCcw size={16} /> Restore
              </button>
              <button
                className="danger"
                disabled={!ids.length}
                onClick={() => {
                  if (!confirm(`Permanently delete ${ids.length} note${ids.length === 1 ? '' : 's'}?`)) return
                  ids.forEach((id) => deleteNoteForever(workspaceDoc, id))
                  stopSelecting()
                }}
              >
                <Trash2 size={16} /> Delete
              </button>
            </>
          ) : (
            <>
              <button disabled={!ids.length} onClick={() => (onMoveNotes(ids), stopSelecting())} title="Move to a folder">
                <FolderInput size={16} /> Move
              </button>
              <button
                disabled={!ids.length}
                onClick={() => {
                  const allPinned = ids.every((id) => notes.find((n) => n.id === id)?.pinned)
                  pinNotes(ids, !allPinned)
                }}
              >
                <Pin size={16} /> {ids.length && ids.every((id) => notes.find((n) => n.id === id)?.pinned) ? 'Unpin' : 'Pin'}
              </button>
              <button
                disabled={!ids.length}
                onClick={() => {
                  const tag = prompt('Add a tag to the selected notes', '')
                  if (tag) void tagNotes(ids, tag)
                }}
              >
                <Hash size={16} /> Tag
              </button>
              <button disabled={!ids.length} onClick={() => void Promise.all(ids.map(duplicateNote)).then(stopSelecting)} title="Make a copy of each">
                <Copy size={16} /> Duplicate
              </button>
              <button className="danger" disabled={!ids.length} onClick={() => (trashNotes(ids), stopSelecting())}>
                <Trash2 size={16} /> Delete
              </button>
            </>
          )}
        </div>
      )}
      {webImport && <WebImportDialog folderId={view.kind === 'folder' ? view.folderId : null} onClose={() => setWebImport(false)} onOpen={onOpen} />}
    </section>
  )
}
