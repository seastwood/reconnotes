import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Popover } from './Popover'
import { SearchResults, SearchSuggestions } from './SearchResults'
import { ErrorBoundary } from './ErrorBoundary'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Search,
  FolderMinus,
  PanelLeftClose,
  Settings as SettingsIcon,
  Trash2,
  Hash,
  LayoutTemplate,
  CalendarDays,
  CalendarCheck,
  ListChecks,
  SearchCheck,
  CloudDownload,
  Command as CommandIcon,
  Activity,
  Loader2,
  X,
  Lock,
  LockOpen,
  SearchX,
  Users,
  PenOff,
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
  effectiveFolderId,
} from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { isKeptOffline, setKeepOffline, useOffline } from '../lib/offline'
import { moveNotes, trashNotes } from '../lib/noteActions'
import { SyncBadge } from './SyncBadge'
import { useJobs } from '../lib/jobs'
import { isSyncConfigured } from '../lib/settings'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { lockFolder, useFolderAccess } from '../lib/folderLock'
import { setSearchFolders, toggleSearchFolder, useSearchScope } from '../lib/searchScope'
import { useSavedSearches } from '../lib/searchHistory'
import { openDailyNote } from '../lib/daily'
import { PasswordDialog, type PasswordMode } from './PasswordDialog'
import { openAskChat } from '../lib/askChat'
import { checkForUpdates } from '../lib/webImport'
import { refreshShares, useShares } from '../lib/shares'
import { ShareFolderDialog } from './ShareFolderDialog'
import { setFolderReadOnly } from '../lib/readOnly'
import { folderRules } from '@reconnotes/core'

export type View =
  | { kind: 'all' }
  /** notes in no folder */
  | { kind: 'unfiled' }
  | { kind: 'trash' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'templates' }
  | { kind: 'due' }
  | { kind: 'tasks' }
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
  /** the search text: while there is some, matching notes show here instead of the folders */
  search: string
  onSearch: (query: string) => void
  /** a search result was tapped */
  onOpenResult: (noteId: string, findText?: string) => void
  activeNoteId: string | null
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

/** the Tags section's folded state, kept with the folders' */
const TAGS_KEY = '__tags'
/** tags shown before "Show all" */
const TOP_TAGS = 5

/** A quick, smooth scroll (a quarter of a second, easing out) – quicker than the browser's own. */
function scrollSmoothly(el: HTMLElement, to: number, ms = 260) {
  const from = el.scrollTop
  if (Math.abs(to - from) < 2) return
  const start = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms)
    el.scrollTop = from + (to - from) * (1 - Math.pow(1 - t, 3))
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export function Sidebar({ overlay, onClose, view, onView, onSettings, onCommands, onMoveFolder, search, onSearch, onOpenResult, activeNoteId }: Props) {
  // saved searches shown here (pin them in the search suggestions)
  const smart = useSavedSearches().filter((s) => s.pinned)
  const ws = useWorkspace()
  // the folders search looks in (chosen with "Search in this folder…" or the filter): shown before you type
  const scope = useSearchScope()
  const scopeName = (id: string) => (id === 'none' ? 'Not in a folder' : (ws.folders.find((f) => f.id === id)?.name ?? 'Folder'))
  const scopeLabel = scope.length === 1 ? `Search in ${scopeName(scope[0])}` : scope.length ? `Search in ${scope.length} folders` : 'Search everything'
  const tree = useMemo(() => buildTree(ws.folders, ws.rootSort), [ws.folders, ws.rootSort])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => safeLocalGet('reconnotes.collapsed', {}))
  const searchBox = useRef<HTMLTextAreaElement>(null)
  /** the search box has the cursor: show saved and recent searches under it */
  const [searchFocus, setSearchFocus] = useState(false)
  // the box grows with a long search (a question), up to a few lines
  useLayoutEffect(() => {
    const el = searchBox.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [search])
  const [renaming, setRenaming] = useState<string | null>(null)
  const access = useFolderAccess()
  /** asking for a folder's password */
  const [pw, setPw] = useState<{ folderId: string; mode: PasswordMode; then?: () => void } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // folders shared with others (marked, and shared from the folder's menu)
  const [sharing, setSharing] = useState<string | null>(null)
  // read-only folders: set on it, or on a folder it's in
  const readOnlyBy = useMemo(() => {
    const rules = folderRules(ws.folders)
    return (id: string) => rules.get(id)?.readOnlyBy ?? null
  }, [ws.folders])
  const shareLinks = useShares((s) => s.shares)
  const sharedWith = useMemo(() => {
    const by = new Map<string, string[]>()
    for (const l of shareLinks) if (l.folderId) by.set(l.folderId, [...(by.get(l.folderId) ?? []), l.name || 'a link'])
    return by
  }, [shareLinks])
  useEffect(() => void refreshShares(), [])
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
  const liveFolderIds = new Set(ws.folders.filter((f) => !f.trashedAt).map((f) => f.id))
  const unfiledCount = ws.notes.filter((n) => !n.trashedAt && !n.template && !effectiveFolderId(n, liveFolderIds)).length
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
  const tagsFolded = Boolean(collapsed[TAGS_KEY])
  /** the folder "Ask this folder…" is open for */
  /** this folder holds pages imported from the web (they can be checked for updates) */
  const hasSource = (folderId: string) => ws.notes.some((n) => n.source && !n.trashedAt && n.folderId === folderId)
  const [allTags, setAllTags] = useState(false)
  // the most-used few (and the one being looked at), in A–Z order
  const shownTags = useMemo(() => {
    if (allTags || tags.length <= TOP_TAGS) return tags
    const top = new Set([...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TAGS).map(([t]) => t))
    if (view.kind === 'tag') top.add(view.tag)
    return tags.filter(([t]) => top.has(t))
  }, [tags, allTags, view])

  // what you're looking at, in view – a folder (or the folder it's in, when that's folded), All
  // Notes, Tasks… – when it changes (a quick, smooth scroll), or when the folders show again (back
  // on a phone: straight there, the panel is sliding in)
  const folderList = useRef<HTMLElement>(null)
  const viewKey = view.kind === 'folder' ? `folder:${view.folderId}` : view.kind === 'tag' ? `tag:${view.tag}` : view.kind
  const searching = Boolean(search.trim())
  const shownOnce = useRef(false)
  useLayoutEffect(() => {
    const list = folderList.current
    if (!list) return
    let row: HTMLElement | null = null
    if (view.kind === 'folder') {
      const byId = new Map(ws.folders.map((f) => [f.id, f]))
      for (let id: string | null = view.folderId, n = 0; id && !row && n < 50; id = byId.get(id)?.parentId ?? null, n++)
        row = list.querySelector<HTMLElement>(`[data-folder="${CSS.escape(id)}"]`)
    } else row = list.querySelector<HTMLElement>('.folder-row.active')
    const smooth = shownOnce.current
    shownOnce.current = true
    if (!row) return
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    // already in view: left where it is
    if (top >= list.scrollTop && top + row.offsetHeight <= list.scrollTop + list.clientHeight) return
    const to = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, top - list.clientHeight / 3))
    if (smooth) scrollSmoothly(list, to)
    else list.scrollTop = to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, searching, ws.loaded])

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
      const locked = access.lockedFolder(f.id)
      const owner = access.lockOwner(f.id)
      // a locked folder shows no subfolders until it's unlocked
      const open = !collapsed[f.id] && !locked
      const active = view.kind === 'folder' && view.folderId === f.id
      const hint = dropHint?.id === f.id ? dropHint.where : null
      return (
        <li key={f.id}>
          <div
            className={`folder-row${active ? ' active' : ''}${hint ? ` drop-${hint}` : ''}`}
            data-folder={f.id}
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
            onClick={() =>
              locked && owner
                ? setPw({ folderId: owner, mode: 'unlock', then: () => onView({ kind: 'folder', folderId: f.id }) })
                : onView({ kind: 'folder', folderId: f.id })
            }
          >
            <button
              className="twisty"
              onClick={(e) => {
                e.stopPropagation()
                toggle(f.id)
              }}
              style={{ visibility: node.children.length && !locked ? 'visible' : 'hidden' }}
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {f.lock ? (
              locked ? (
                <Lock size={16} className="folder-icon" aria-label="Locked" />
              ) : (
                <LockOpen size={16} className="folder-icon" aria-label="Unlocked" />
              )
            ) : (
              <Folder size={16} className="folder-icon" />
            )}
            {renaming === f.id ? (
              <input
                className="rename"
                autoFocus
                defaultValue={f.name}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => {
                  e.target.select()
                  // a new folder can land anywhere in the list: bring its name into view,
                  // and again once the keyboard has opened (it takes up the bottom half)
                  const el = e.target
                  const show = () => el.isConnected && el.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  show()
                  setTimeout(show, 350)
                }}
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
            {f.readOnly && (
              <span className="folder-flag" title="Read only – its notes (and its subfolders’) can’t be changed by accident">
                <PenOff size={13} />
              </span>
            )}
            {sharedWith.has(f.id) && (
              <span className="folder-flag shared" title={`Shared with ${sharedWith.get(f.id)!.join(', ')}`}>
                <Users size={13} />
              </span>
            )}
            {f.noSearch && (
              <span className="folder-flag" title="Left out of search">
                <SearchX size={13} />
              </span>
            )}
            <span className="count">{locked ? '' : (counts[f.id] ?? '')}</span>
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
                {locked && owner ? (
                  <button onClick={() => (setMenuFor(null), setPw({ folderId: owner, mode: 'unlock' }))}>
                    <Lock size={14} /> Unlock…
                  </button>
                ) : (
                  <>
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
                <div className="menu-sep" />
                <button
                  onClick={() => {
                    setMenuFor(null)
                    setSearchFolders([f.id])
                    searchBox.current?.focus()
                  }}
                >
                  Search in this folder…
                </button>
                <button onClick={() => (setMenuFor(null), openAskChat({ folderId: f.id, title: f.name }))} title="A question answered from this folder’s notes (and its subfolders’) – even if it’s left out of search">
                  Ask this folder…
                </button>
                {isSyncConfigured() && !owner && (
                  <button onClick={() => (setMenuFor(null), setSharing(f.id))} title="A read-only link to everything in this folder, for someone you choose">
                    <Users size={14} /> {sharedWith.has(f.id) ? 'Sharing…' : 'Share folder…'}
                  </button>
                )}
                {hasSource(f.id) && (
                  <button
                    onClick={() => {
                      setMenuFor(null)
                      void checkForUpdates({ folderId: f.id })
                    }}
                    title="Fetch its imported web pages again and bring the changed ones up to date"
                  >
                    Check for updates
                  </button>
                )}
                {readOnlyBy(f.id) && readOnlyBy(f.id) !== f.id ? (
                  <button disabled title="A folder it’s in is read only">
                    <PenOff size={14} /> Read only (like “{ws.folders.find((x) => x.id === readOnlyBy(f.id))?.name ?? 'its folder'}”)
                  </button>
                ) : (
                  <button
                    className={f.readOnly ? 'checked' : ''}
                    title="Its notes (and its subfolders’) open read only, so nothing in them changes by accident – a note can still be made editable on its own"
                    onClick={() => (setMenuFor(null), setFolderReadOnly(f.id, !f.readOnly))}
                  >
                    <PenOff size={14} /> Read only
                  </button>
                )}
                <button
                  className={f.noSearch ? 'checked' : ''}
                  title="Its notes (and its subfolders’) don’t show up in search or “Ask your notes” – unless you search this folder on purpose"
                  onClick={() => updateFolder(workspaceDoc, f.id, { noSearch: !f.noSearch })}
                >
                  Leave out of search
                </button>
                {f.lock ? (
                  <>
                    <button onClick={() => (setMenuFor(null), lockFolder(f.id))}>
                      <Lock size={14} /> Lock now
                    </button>
                    <button onClick={() => (setMenuFor(null), setPw({ folderId: f.id, mode: 'change' }))}>Change password…</button>
                    <button onClick={() => (setMenuFor(null), setPw({ folderId: f.id, mode: 'remove' }))}>Remove password…</button>
                  </>
                ) : (
                  !owner && (
                    <button onClick={() => (setMenuFor(null), setPw({ folderId: f.id, mode: 'set' }))}>
                      <Lock size={14} /> Lock with password…
                    </button>
                  )
                )}
                <button className="danger" onClick={() => trashFolder(workspaceDoc, f.id)}>
                  Delete folder
                </button>
                  </>
                )}
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
      <div className="search-wrap">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault()
            // put the keyboard away to see the results
            searchBox.current?.blur()
          }}
        >
          <Search size={16} />
          <textarea
            ref={searchBox}
            rows={1}
            enterKeyHint="search"
            placeholder={scopeLabel}
            aria-label={scopeLabel}
            value={search}
            autoCapitalize="off"
            onChange={(e) => onSearch(e.target.value.replace(/\n/g, ' '))}
            onFocus={() => setSearchFocus(true)}
            onBlur={() => setSearchFocus(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (onSearch(''), searchBox.current?.blur())
              // Return searches (puts the keyboard away) instead of adding a line
              if (e.key === 'Enter') (e.preventDefault(), searchBox.current?.blur())
            }}
          />
          {search ? (
            <button type="button" className="search-commands" onClick={() => (onSearch(''), searchBox.current?.focus())} aria-label="Clear search" title="Clear search">
              <X size={15} />
            </button>
          ) : (
            onCommands && (
              <button type="button" className="search-commands" onClick={onCommands} aria-label="Commands" title="Commands and quick jump (⌘K)">
                <CommandIcon size={15} />
              </button>
            )
          )}
        </form>
        {search && (
          <button className="text search-cancel" onClick={() => (onSearch(''), searchBox.current?.blur())}>
            Cancel
          </button>
        )}
      </div>
      {!search.trim() && scope.length > 0 && (
        <div className="search-chips search-scope" onPointerDown={(e) => e.preventDefault()}>
          <span className="muted">Searching in</span>
          {scope.map((id) => (
            <span key={id} className="search-chip">
              <Folder size={12} /> {scopeName(id)}
              <button aria-label={`Stop searching only in ${scopeName(id)}`} onClick={() => toggleSearchFolder(id)}>
                <X size={12} />
              </button>
            </span>
          ))}
          <button className="text" onClick={() => setSearchFolders([])}>
            Everywhere
          </button>
        </div>
      )}
      {!search.trim() && searchFocus && (
        <SearchSuggestions
          onPick={(q, folders) => {
            if (folders) setSearchFolders(folders)
            onSearch(q)
          }}
        />
      )}
      {search.trim() ? (
        <div className="folders sidebar-results">
          <ErrorBoundary inline resetKey={search}>
            <SearchResults query={search} activeNoteId={activeNoteId} onOpen={onOpenResult} />
          </ErrorBoundary>
        </div>
      ) : (
      <nav className="folders" ref={folderList}>
        <div className={`folder-row special${view.kind === 'all' ? ' active' : ''}`} onClick={() => onView({ kind: 'all' })}>
          <Inbox size={16} /> <span className="folder-name">All Notes</span>
          <span className="count">{liveCount}</span>
        </div>
        {(unfiledCount > 0 || view.kind === 'unfiled') && (
          <div className={`folder-row special${view.kind === 'unfiled' ? ' active' : ''}`} onClick={() => onView({ kind: 'unfiled' })} title="Notes that aren’t in any folder">
            <FolderMinus size={16} /> <span className="folder-name">Not in a folder</span>
            <span className="count">{unfiledCount}</span>
          </div>
        )}
        {dueOpen.length > 0 && (
          <div className={`folder-row special${view.kind === 'due' ? ' active' : ''}`} onClick={() => onView({ kind: 'due' })}>
            <CalendarDays size={16} /> <span className="folder-name">Due</span>
            <span className={`count${dueNow ? ' due-now' : ''}`} title={dueNow ? `${dueNow} due today or overdue` : undefined}>
              {dueNow || dueOpen.length}
            </span>
          </div>
        )}
        <div className="folder-row special" onClick={() => void openDailyNote().then((id) => onOpenResult(id))} title="Today’s daily note – made for you the first time, with yesterday’s unfinished to-dos">
          <CalendarCheck size={16} /> <span className="folder-name">Today</span>
        </div>
        {isSyncConfigured() && (
          <div className={`folder-row special${view.kind === 'tasks' ? ' active' : ''}`} onClick={() => onView({ kind: 'tasks' })} title="Every checklist item in every note">
            <ListChecks size={16} /> <span className="folder-name">Tasks</span>
          </div>
        )}
        {isSyncConfigured() && <JobsRow active={view.kind === 'jobs'} onClick={() => onView({ kind: 'jobs' })} />}
        {smart.length > 0 && (
          <>
            <div className="section-label">Smart folders</div>
            {smart.map((s) => (
              <div
                key={s.id}
                className="folder-row special"
                onClick={() => {
                  setSearchFolders(s.folders)
                  onSearch(s.query)
                }}
                title={`Search: ${s.query}`}
              >
                <SearchCheck size={16} /> <span className="folder-name">{s.query}</span>
              </div>
            ))}
          </>
        )}
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
            {/* folds away (remembered); open, the most-used few – the rest a tap away */}
            <button className="section-label section-toggle" onClick={() => toggle(TAGS_KEY)} aria-expanded={!tagsFolded}>
              <ChevronRight size={14} className={`section-chevron${tagsFolded ? '' : ' open'}`} /> Tags
              <span className="section-count">{tags.length}</span>
            </button>
            {!tagsFolded && (
              <ul className="tag-list">
                {shownTags.map(([tag, count]) => (
                  <li
                    key={tag}
                    className={`folder-row tag-row${view.kind === 'tag' && view.tag === tag ? ' active' : ''}`}
                    onClick={() => onView({ kind: 'tag', tag })}
                  >
                    <Hash size={15} /> <span className="folder-name">{tag}</span>
                    <span className="count">{count}</span>
                  </li>
                ))}
                {tags.length > TOP_TAGS && (
                  <li className="folder-row tag-more" onClick={() => setAllTags(!allTags)}>
                    <span className="folder-name">{allTags ? 'Show fewer' : `Show all ${tags.length} tags`}</span>
                  </li>
                )}
              </ul>
            )}
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
      )}
      {sharing && <ShareFolderDialog folderId={sharing} name={ws.folders.find((x) => x.id === sharing)?.name ?? 'Folder'} onClose={() => setSharing(null)} />}
      {pw && (
        <PasswordDialog
          folderId={pw.folderId}
          folderName={ws.folders.find((x) => x.id === pw.folderId)?.name ?? 'Folder'}
          mode={pw.mode}
          onClose={() => setPw(null)}
          onDone={pw.then}
        />
      )}
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
