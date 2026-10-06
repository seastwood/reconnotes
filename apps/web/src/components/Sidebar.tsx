import { useMemo, useRef, useState } from 'react'
import { Popover } from './Popover'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Search,
  PanelLeftClose,
  Settings as SettingsIcon,
  Trash2,
  Hash,
  LayoutTemplate,
  CalendarDays,
  CloudDownload,
  Command as CommandIcon,
  Activity,
  Loader2,
} from 'lucide-react'
import {
  buildTree,
  createFolder,
  getSettings,
  moveFolder,
  moveNote,
  trashFolder,
  updateFolder,
  type SortMode,
  type TreeNode,
  daysUntil,
} from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { isKeptOffline, setKeepOffline, useOffline } from '../lib/offline'
import { moveNotes, trashNotes } from '../lib/noteActions'
import { SyncBadge } from './SyncBadge'
import { useJobs } from '../lib/jobs'
import { isSyncConfigured } from '../lib/settings'
import { safeLocalGet, safeLocalSet } from '../lib/store'

export type View =
  | { kind: 'all' }
  | { kind: 'trash' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'search'; query: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'templates' }
  | { kind: 'due' }
  | { kind: 'jobs' }

interface Props {
  /** shown floating over the notes list (medium screens) */
  overlay?: boolean
  /** hide the folders panel */
  onClose?: () => void
  view: View
  onView: (v: View) => void
  onSettings: () => void
  /** open the ⌘K command window */
  onCommands?: () => void
  onMoveFolder: (folderId: string) => void
}

export const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Manual (drag to reorder)',
  title: 'Title',
  created: 'Date created',
  updated: 'Date edited',
}

const DND_TYPE = 'application/x-reconnotes'

export interface DragPayload {
  kind: 'folder' | 'note'
  id: string
  /** several selected notes dragged together */
  ids?: string[]
}

export function setDrag(e: React.DragEvent, p: DragPayload) {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(p))
  e.dataTransfer.effectAllowed = 'move'
}

export function getDrag(e: React.DragEvent): DragPayload | null {
  try {
    return JSON.parse(e.dataTransfer.getData(DND_TYPE)) as DragPayload
  } catch {
    return null
  }
}

export function Sidebar({ overlay, onClose, view, onView, onSettings, onCommands, onMoveFolder }: Props) {
  const ws = useWorkspace()
  const tree = useMemo(() => buildTree(ws.folders, ws.rootSort), [ws.folders, ws.rootSort])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => safeLocalGet('reconnotes.collapsed', {}))
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const offlineFolders = useOffline((s) => s.folders)
  const offlineProgress = useOffline((s) => s.progress)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const openMenu = (id: string, el: HTMLElement) => {
    menuAnchor.current = el
    setMenuFor(menuFor === id ? null : id)
  }
  const [dropHint, setDropHint] = useState<{ id: string; where: 'before' | 'inside' | 'after' } | null>(null)

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const n of ws.notes) if (!n.trashedAt && n.folderId) c[n.folderId] = (c[n.folderId] ?? 0) + 1
    return c
  }, [ws.notes])
  const liveCount = ws.notes.filter((n) => !n.trashedAt && !n.template).length
  const templateCount = ws.notes.filter((n) => !n.trashedAt && n.template).length
  // open due items, and how many are due today or overdue
  const dueOpen = ws.notes.filter((n) => !n.trashedAt && !n.template).flatMap((n) => n.due.filter((d) => !d.done))
  const dueNow = dueOpen.filter((d) => daysUntil(d.date) <= 0).length
  const trashCount = ws.notes.filter((n) => n.trashedAt).length
  // #tags used in notes, with how many notes use each
  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of ws.notes) if (!n.trashedAt && !n.template) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]))
  }, [ws.notes])

  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] }
    setCollapsed(next)
    safeLocalSet('reconnotes.collapsed', next)
  }

  const newFolder = (parentId: string | null) => {
    const id = createFolder(workspaceDoc, { name: 'New Folder', parentId })
    if (parentId && collapsed[parentId]) toggle(parentId)
    setRenaming(id)
  }

  const onDrop = (e: React.DragEvent, node: TreeNode, where: 'before' | 'inside' | 'after', siblings: TreeNode[]) => {
    e.preventDefault()
    setDropHint(null)
    const p = getDrag(e)
    if (!p) return
    if (p.kind === 'note') return moveNotes(p.ids ?? [p.id], node.folder.id)
    if (p.id === node.folder.id) return
    if (where === 'inside') return void moveFolder(workspaceDoc, p.id, node.folder.id)
    // reorder among siblings: switch the parent to manual sort
    const parentId = node.folder.parentId
    const others = siblings.filter((s) => s.folder.id !== p.id)
    const idx = others.findIndex((s) => s.folder.id === node.folder.id) + (where === 'after' ? 1 : 0)
    if (parentId) updateFolder(workspaceDoc, parentId, { sort: 'manual' })
    else getSettings(workspaceDoc).set('rootSort', 'manual')
    moveFolder(workspaceDoc, p.id, parentId, idx)
  }

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const f = node.folder
      const open = !collapsed[f.id]
      const active = view.kind === 'folder' && view.folderId === f.id
      const hint = dropHint?.id === f.id ? dropHint.where : null
      return (
        <li key={f.id}>
          <div
            className={`folder-row${active ? ' active' : ''}${hint ? ` drop-${hint}` : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            draggable={renaming !== f.id}
            onDragStart={(e) => setDrag(e, { kind: 'folder', id: f.id })}
            onDragOver={(e) => {
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              const y = (e.clientY - r.top) / r.height
              setDropHint({ id: f.id, where: y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside' })
            }}
            onDragLeave={() => setDropHint(null)}
            onDrop={(e) => onDrop(e, node, hint ?? 'inside', nodes)}
            onClick={() => onView({ kind: 'folder', folderId: f.id })}
          >
            <button
              className="twisty"
              onClick={(e) => {
                e.stopPropagation()
                toggle(f.id)
              }}
              style={{ visibility: node.children.length ? 'visible' : 'hidden' }}
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <Folder size={16} className="folder-icon" />
            {renaming === f.id ? (
              <input
                className="rename"
                autoFocus
                defaultValue={f.name}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => {
                  updateFolder(workspaceDoc, f.id, { name: e.target.value.trim() || 'Untitled folder' })
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span className="folder-name" onDoubleClick={() => setRenaming(f.id)}>
                {f.name}
              </span>
            )}
            {offlineFolders.includes(f.id) && (
              <span className={`offline-mark${offlineProgress ? ' busy' : ''}`} title={offlineProgress ? `Downloading for offline: ${offlineProgress.done} of ${offlineProgress.total}` : 'Kept offline on this device'}>
                <CloudDownload size={13} />
              </span>
            )}
            <span className="count">{counts[f.id] ?? ''}</span>
            <button
              className="row-menu"
              aria-label="Folder actions"
              onClick={(e) => {
                e.stopPropagation()
                openMenu(f.id, e.currentTarget)
              }}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuFor === f.id && (
              <Popover anchorRef={menuAnchor} align="right" onClose={() => setMenuFor(null)}>
                <button onClick={() => newFolder(f.id)}>New subfolder</button>
                <button onClick={() => setRenaming(f.id)}>Rename</button>
                <button onClick={() => onMoveFolder(f.id)}>Move to…</button>
                {isKeptOffline(f.id) !== 'parent' && (
                  <button
                    className={offlineFolders.includes(f.id) ? 'checked' : ''}
                    title="Download every picture, recording and file in this folder to this device, so they open without a connection"
                    onClick={() => {
                      setKeepOffline(f.id, !offlineFolders.includes(f.id))
                      setMenuFor(null)
                    }}
                  >
                    Keep offline on this device
                  </button>
                )}
                <div className="menu-label">Sort subfolders &amp; notes by</div>
                {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                  <button key={m} className={f.sort === m ? 'checked' : ''} onClick={() => updateFolder(workspaceDoc, f.id, { sort: m })}>
                    {SORT_LABELS[m]}
                  </button>
                ))}
                <button className="danger" onClick={() => trashFolder(workspaceDoc, f.id)}>
                  Delete folder
                </button>
              </Popover>
            )}
          </div>
          {open && node.children.length > 0 && <ul>{renderNodes(node.children, depth + 1)}</ul>}
        </li>
      )
    })

  return (
    <aside className={`sidebar${overlay ? ' overlay' : ''}`}>
      <header className="sidebar-head">
        <h1>ReconNotes</h1>
        <SyncBadge />
        <button className="icon" onClick={onSettings} aria-label="Settings">
          <SettingsIcon size={18} />
        </button>
        {onClose && (
          <button className="icon" onClick={onClose} aria-label="Hide folders" title="Hide folders">
            <PanelLeftClose size={18} />
          </button>
        )}
      </header>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault()
          if (query.trim()) onView({ kind: 'search', query })
        }}
      >
        <Search size={16} />
        <input
          type="search"
          placeholder="Search everything"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            if (e.target.value.trim()) onView({ kind: 'search', query: e.target.value })
            else if (view.kind === 'search') onView({ kind: 'all' })
          }}
        />
        {onCommands && (
          <button type="button" className="search-commands" onClick={onCommands} aria-label="Commands" title="Commands and quick jump (⌘K)">
            <CommandIcon size={15} />
          </button>
        )}
      </form>
      <nav className="folders">
        <div className={`folder-row special${view.kind === 'all' ? ' active' : ''}`} onClick={() => onView({ kind: 'all' })}>
          <Inbox size={16} /> <span className="folder-name">All Notes</span>
          <span className="count">{liveCount}</span>
        </div>
        {dueOpen.length > 0 && (
          <div className={`folder-row special${view.kind === 'due' ? ' active' : ''}`} onClick={() => onView({ kind: 'due' })}>
            <CalendarDays size={16} /> <span className="folder-name">Due</span>
            <span className={`count${dueNow ? ' due-now' : ''}`} title={dueNow ? `${dueNow} due today or overdue` : undefined}>
              {dueNow || dueOpen.length}
            </span>
          </div>
        )}
        {isSyncConfigured() && <JobsRow active={view.kind === 'jobs'} onClick={() => onView({ kind: 'jobs' })} />}
        <div className="section-label">
          Folders
          <div className="menu-anchor">
            <button className="icon" onClick={(e) => openMenu('root', e.currentTarget)} aria-label="Folder sort">
              <MoreHorizontal size={14} />
            </button>
            {menuFor === 'root' && (
              <Popover anchorRef={menuAnchor} align="right" onClose={() => setMenuFor(null)}>
                <div className="menu-label">Sort folders by</div>
                {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                  <button key={m} className={ws.rootSort === m ? 'checked' : ''} onClick={() => getSettings(workspaceDoc).set('rootSort', m)}>
                    {SORT_LABELS[m]}
                  </button>
                ))}
              </Popover>
            )}
          </div>
          <button className="icon" onClick={() => newFolder(null)} aria-label="New folder" title="New folder">
            <FolderPlus size={16} />
          </button>
        </div>
        <ul
          className="tree"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // dropped on empty space: move folder to the top level
            const p = getDrag(e)
            if (p?.kind === 'folder' && e.target === e.currentTarget) moveFolder(workspaceDoc, p.id, null)
          }}
        >
          {renderNodes(tree, 0)}
        </ul>
        {!tree.length && ws.loaded && <p className="empty-hint">No folders yet. Create one with the + button.</p>}
        {tags.length > 0 && (
          <>
            <div className="section-label">Tags</div>
            <ul className="tag-list">
              {tags.map(([tag, count]) => (
                <li
                  key={tag}
                  className={`folder-row tag-row${view.kind === 'tag' && view.tag === tag ? ' active' : ''}`}
                  onClick={() => onView({ kind: 'tag', tag })}
                >
                  <Hash size={15} /> <span className="folder-name">{tag}</span>
                  <span className="count">{count}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {templateCount > 0 && (
          <div className={`folder-row special${view.kind === 'templates' ? ' active' : ''}`} onClick={() => onView({ kind: 'templates' })}>
            <LayoutTemplate size={16} /> <span className="folder-name">Templates</span>
            <span className="count">{templateCount}</span>
          </div>
        )}
        <div
          className={`folder-row special${view.kind === 'trash' ? ' active' : ''}`}
          onClick={() => onView({ kind: 'trash' })}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const p = getDrag(e)
            if (p?.kind === 'folder') trashFolder(workspaceDoc, p.id)
            else if (p?.kind === 'note') trashNotes(p.ids ?? [p.id])
          }}
        >
          <Trash2 size={16} /> <span className="folder-name">Recently Deleted</span>
          <span className="count">{trashCount || ''}</span>
        </div>
      </nav>
    </aside>
  )
}

/** "Jobs" in the sidebar: how many are running or waiting, or that one failed since you last looked. */
function JobsRow({ active, onClick }: { active: boolean; onClick: () => void }) {
  const counts = useJobs((s) => s.counts)
  const lastFailed = useJobs((s) => Math.max(0, ...s.jobs.filter((j) => j.status === 'failed' && j.origin !== 'auto').map((j) => j.finishedAt ?? 0)))
  const [seen, setSeen] = useState(() => safeLocalGet<number>('reconnotes.jobsSeen', 0))
  if (active && lastFailed > seen) {
    setSeen(lastFailed)
    safeLocalSet('reconnotes.jobsSeen', lastFailed)
  }
  const waiting = counts.queued + counts.paused + counts.running
  return (
    <div className={`folder-row special${active ? ' active' : ''}`} onClick={onClick}>
      {counts.running ? <Loader2 size={16} className="spin" /> : <Activity size={16} />} <span className="folder-name">Jobs</span>
      {waiting > 0 ? (
        <span className="count" title={`${counts.running} running, ${counts.queued} waiting${counts.paused ? `, ${counts.paused} paused` : ''}`}>
          {waiting}
        </span>
      ) : (
        lastFailed > seen && (
          <span className="count due-now" title="A job failed">
            !
          </span>
        )
      )}
    </div>
  )
}
