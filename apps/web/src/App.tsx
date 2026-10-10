import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, PanelLeft, X } from 'lucide-react'
import { getNotes, readNote } from '@reconnotes/core'
import { Sidebar, type View } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { JobsPanel } from './components/JobsPanel'
import { setJobNavigator } from './lib/jobs'
import { SETTINGS_TABS, SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { MoveDialog, type MoveTarget } from './components/MoveDialog'
import { NoteEditor } from './editor/Editor'
import { useNoteDoc, useWorkspace, workspaceDoc } from './lib/workspace'
import { settings, useSettings } from './lib/settings'
import { usePencilInteractions } from './drawing/PencilPalette'
import { safeLocalGet, safeLocalSet, useStore } from './lib/store'
import { askChat } from './lib/askChat'
import { startReminders } from './lib/reminders'
import { startPush } from './lib/push'
import { resumeRecording } from './lib/recorder'
import { RecordingPill } from './components/RecordingPill'
import { LockedScreen } from './components/LockedScreen'
import { WebImportDialog } from './components/WebImportDialog'
import { AskChatHost } from './components/AskChat'
import { ReferencesHost } from './components/References'
import { useFolderAccess } from './lib/folderLock'
import { startShareInbox } from './lib/shareInbox'
import { Toaster } from './components/Toaster'
import { HideKeyboardButton } from './components/HideKeyboardButton'
import { Panel } from './components/Panel'
import { ImageViewerHost } from './components/ImageViewer'
import { CommandPalette } from './components/CommandPalette'
import { Tour, shouldShowTour } from './components/Tour'
import { registerCommands } from './lib/commands'
import { createFolder, createNote, listNotes, updateNote } from '@reconnotes/core'
import { pinNotes, trashNotes } from './lib/noteActions'
import { newNoteFromTemplate } from './lib/templates'
import { isKeptOffline, setKeepOffline } from './lib/offline'
import { quickAction, startAppLinks, type LinkAction } from './lib/appLinks'
import * as Y from 'yjs'
import { getContent, noteDocName } from '@reconnotes/core'
import { sync } from './lib/sync'
import { startMeeting } from './lib/meeting'
import { openDailyNote } from './lib/daily'

function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

function useTheme() {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMedia('(prefers-color-scheme: dark)')
  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
    // Safari (and the home-screen app) colour the status bar and toolbar areas with
    // the theme colour: follow the app's appearance, not just the phone's
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    if (!bg) return
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
    metas.slice(1).forEach((m) => m.remove())
    const meta = metas[0] ?? document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }))
    meta.removeAttribute('media')
    meta.content = bg
  }, [theme, systemDark])
}

/**
 * Horizontal swipes with a finger: in from the left screen edge (→ onLeftEdge),
 * in from the right edge (→ onRightEdge), or leftwards starting on a side panel
 * (→ onClose). Pencil and mouse are ignored, and so are mostly-vertical moves
 * (scrolling).
 */
function useEdgeSwipe(onLeftEdge: () => void, onRightEdge: () => void, onClose: () => void) {
  const handlers = useRef({ onLeftEdge, onRightEdge, onClose })
  handlers.current = { onLeftEdge, onRightEdge, onClose }
  useEffect(() => {
    const EDGE = 28
    let start: { x: number; y: number; fromEdge: boolean; fromRight: boolean; onPanel: boolean; t: number } | null = null
    const touchType = (t: Touch) => (t as Touch & { touchType?: string }).touchType
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0]
      if (e.touches.length !== 1 || touchType(t) === 'stylus') {
        start = null
        return
      }
      const target = e.target as Element
      if (target.closest?.('.image-viewer')) return void (start = null) // the viewer has its own gestures
      start = {
        x: t.clientX,
        y: t.clientY,
        fromEdge: t.clientX <= EDGE,
        fromRight: t.clientX >= window.innerWidth - EDGE,
        onPanel: Boolean(target.closest?.('.sidebar, .list-col')) && !target.closest?.('input, textarea, [contenteditable="true"], .swipe-row'),
        t: Date.now(),
      }
      if (!start.fromEdge && !start.fromRight && !start.onPanel) start = null
    }
    const onEnd = (e: TouchEvent) => {
      if (!start) return
      const t = e.changedTouches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      const quick = Date.now() - start.t < 800
      const horizontal = Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6
      if (quick && horizontal) {
        if (start.fromEdge && dx > 0) handlers.current.onLeftEdge()
        else if (start.fromRight && dx < 0) handlers.current.onRightEdge()
        else if (start.onPanel && dx < 0) handlers.current.onClose()
      }
      start = null
    }
    const onCancel = () => (start = null)
    window.addEventListener('touchstart', onStart, { passive: true, capture: true })
    window.addEventListener('touchend', onEnd, { passive: true, capture: true })
    window.addEventListener('touchcancel', onCancel, { passive: true, capture: true })
    return () => {
      window.removeEventListener('touchstart', onStart, { capture: true })
      window.removeEventListener('touchend', onEnd, { capture: true })
      window.removeEventListener('touchcancel', onCancel, { capture: true })
    }
  }, [])
}

interface Nav {
  view: View
  noteId: string | null
}

export function App() {
  useTheme()
  usePencilInteractions()
  const ws = useWorkspace()
  const narrow = useMedia('(max-width: 699px)')
  // tablets and computers: folders, notes and the note side by side (the
  // columns get narrower on smaller screens); phones show one at a time
  const wide = !narrow
  const [nav, setNavState] = useState<Nav>(() => safeLocalGet<Nav>('reconnotes.nav', { view: { kind: 'all' }, noteId: null }))
  const [pane, setPane] = useState<'folders' | 'list' | 'note'>(nav.noteId ? 'note' : 'folders')
  /** iPad/desktop: 3 = folders + notes + note, 2 = notes + note, 1 = note only (full screen) */
  const [layout, setLayoutState] = useState<1 | 2 | 3>(() => safeLocalGet<{ v: 1 | 2 | 3 }>('reconnotes.layout', { v: 3 }).v)
  const setLayout = (v: 1 | 2 | 3) => {
    setLayoutState(v)
    safeLocalSet('reconnotes.layout', { v })
  }
  /** medium screens: the folder list slides over the notes */
  const [overlay, setOverlay] = useState(false)
  // open: on the category you were last in (true), or a given one
  const [settingsOpen, setSettingsOpen] = useState<boolean | SettingsTab>(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Import a web page (from ⌘K): the folder it goes in */
  const [webImport, setWebImport] = useState<{ folderId: string | null } | null>(null)
  const [tourOpen, setTourOpen] = useState(shouldShowTour)
  const [moving, setMoving] = useState<MoveTarget | null>(null)

  const setNav = (n: Nav) => {
    setNavState(n)
    safeLocalSet('reconnotes.nav', n)
  }

  // If the open note was deleted (here or on another device), close it.
  const meta = nav.noteId ? getNotes(workspaceDoc).get(nav.noteId) : undefined
  const note = meta ? readNote(meta) : null
  useEffect(() => {
    if (!ws.loaded || !nav.noteId || (note && !note.trashedAt)) return
    // back to the list of the folder it was in
    const folder = note?.folderId ? ws.folders.find((f) => f.id === note.folderId && !f.trashedAt) : undefined
    const view: View = !note ? nav.view : folder ? { kind: 'folder', folderId: folder.id } : nav.view.kind === 'folder' ? { kind: 'all' } : nav.view
    setNav({ ...nav, view, noteId: null })
    if (narrow && pane === 'note') setPane('list')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, nav.noteId])

  // iOS app: reminders for due items; tapping one opens its note
  const openFromReminder = useRef<(id: string, find?: string) => void>(() => undefined)
  openFromReminder.current = (id, find) => {
    // (at the item it's about, when it says – a due item's text)
    const q = find?.trim()
    setFindOnOpen((f) => (q ? { noteId: id, query: q, n: (f?.n ?? 0) + 1 } : null))
    setNav({ ...nav, noteId: id })
    setPane('note')
  }
  useEffect(() => startReminders((id, find) => openFromReminder.current(id, find)), [])
  // iOS app: a recording still running (the page was reloaded) shows again
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => resumeRecording(nav.noteId), [])
  // iOS app: tapping a notification from the server opens what it's about
  useEffect(() => startPush({ note: (id) => openFromReminder.current(id), search: (q) => appRef.current.showSearch(q) }), [])
  // iOS app: things shared to ReconNotes become notes
  useEffect(() => startShareInbox((id) => openFromReminder.current(id)), [])
  // widget, Siri / Shortcuts and home-screen shortcuts: new note, record, scan…
  const onLink = useRef<(a: LinkAction) => void>(() => undefined)
  onLink.current = (a) => {
    if (a.kind === 'open') return openFromReminder.current(a.noteId, a.find)
    if (a.kind === 'search') return showSearch(a.query)
    const id = createNote(workspaceDoc, { folderId: nav.view.kind === 'folder' ? nav.view.folderId : null })
    if (a.text) {
      const { handle, close } = sync.open(noteDocName(id))
      void handle.loaded.then(() => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText(a.text!)])
        getContent(handle.doc).insert(0, [p])
        close()
      })
    }
    if (a.then) quickAction.set({ noteId: id, action: a.then })
    openFromReminder.current(id)
  }
  useEffect(() => startAppLinks((a) => onLink.current(a)), [])

  // a note in a locked folder (opened from a link, a reminder…) asks for the password first
  const access = useFolderAccess()
  const noteLockedBy = note && access.noteHidden(note) ? access.lockOwner(note.folderId!) : null
  const noteDoc = useNoteDoc(note && !note.trashedAt && !noteLockedBy ? nav.noteId : null)

  /** a note opened from search results opens with the find bar on the search text */
  const [findOnOpen, setFindOnOpen] = useState<{ noteId: string; query: string; n: number } | null>(null)
  /**
   * Notes reached by following links, like a browser's history: swipe in from
   * the left edge to go back, from the right edge to go forward. Opening a note
   * any other way (the list, search, a new note) starts over.
   */
  const [trail, setTrail] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] })
  /** the search text in the folders panel (its results show there) */
  const [search, setSearch] = useState('')
  /** the open note came from the search results: going back returns to them */
  const [fromSearch, setFromSearch] = useState(false)
  const openNote = (id: string, query?: string) => {
    const q = query?.trim()
    setFindOnOpen((f) => (q ? { noteId: id, query: q, n: (f?.n ?? 0) + 1 } : null))
    setFromSearch(Boolean(q))
    setListExpanded(false)
    setNav({ ...nav, noteId: id })
    setPane('note')
    setTrail({ back: [], forward: [] })
  }
  /** search from elsewhere (⌘K, a Shortcut): the folders panel shows the results */
  const showSearch = (query: string) => {
    setSearch(query)
    if (narrow) setPane('folders')
    else if (wide) setLayout(3)
    else setOverlay(true)
  }
  /** follow a link in a note – to a place in the note it points to, when it says ("G206") */
  const followLink = (id: string, find?: string) => {
    const q = find?.trim()
    setFindOnOpen((f) => (q ? { noteId: id, query: q, n: (f?.n ?? 0) + 1 } : null))
    if (id === nav.noteId) return
    if (nav.noteId) setTrail({ back: [...trail.back, nav.noteId].slice(-100), forward: [] })
    setNav({ ...nav, noteId: id })
    setPane('note')
  }
  /** links followed from inside a note: the places to come back to (the note, and how far down it was) */
  const [backTo, setBackTo] = useState<{ noteId: string; scroll: number }[]>([])
  const viaLink = useRef(false)
  // "Back to chat" is showing: the link's way back goes above it
  const chatAside = useStore(askChat, (s) => Boolean(s.target && s.hidden))
  const restoreScroll = useRef<number | null>(null)
  const followFromNote = (id: string, find?: string) => {
    if (nav.noteId) {
      const scroll = document.querySelector('.editor-col .editor-scroll')?.scrollTop ?? 0
      setBackTo((b) => [...b, { noteId: nav.noteId!, scroll }].slice(-30))
      // to another note: that change of note isn't one that forgets the way back
      viaLink.current = id !== nav.noteId
    }
    followLink(id, find)
  }
  const goBackTo = () => {
    const last = backTo.at(-1)
    if (!last) return
    setBackTo((b) => b.slice(0, -1))
    setFindOnOpen(null)
    restoreScroll.current = last.scroll
    if (last.noteId === nav.noteId) return void scrollBack()
    if (!isOpenable(last.noteId)) return
    viaLink.current = true
    setNav({ ...nav, noteId: last.noteId })
    setPane('note')
  }
  /** back where it was: once the note has drawn (a long one takes a moment) */
  const scrollBack = () => {
    const to = restoreScroll.current
    if (to === null) return
    let tries = 0
    const go = () => {
      const el = document.querySelector('.editor-col .editor-scroll')
      if (el && (el.scrollHeight - el.clientHeight >= to || tries > 40)) {
        el.scrollTop = to
        restoreScroll.current = null
      } else if (tries++ <= 40) requestAnimationFrame(go)
    }
    requestAnimationFrame(go)
  }
  // opened some other way (the list, search): the way back is forgotten
  useEffect(() => {
    if (viaLink.current) viaLink.current = false
    else setBackTo([])
    scrollBack()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.noteId])
  const noteTitle = (id: string) => {
    const m = getNotes(workspaceDoc).get(id)
    return (m && readNote(m).title) || 'the note'
  }
  const isOpenable = (id: string) => {
    const m = getNotes(workspaceDoc).get(id)
    return Boolean(m && !readNote(m).trashedAt)
  }
  /** go one step back (or forward) along the trail; false if there's nowhere to go */
  const step = (dir: 'back' | 'forward') => {
    const from = [...trail[dir]]
    const to = [...trail[dir === 'back' ? 'forward' : 'back']]
    let id: string | undefined
    while ((id = from.pop()) && !isOpenable(id));
    if (!id) {
      if (from.length !== trail[dir].length) setTrail(dir === 'back' ? { back: [], forward: to } : { back: to, forward: [] })
      return false
    }
    if (nav.noteId) to.push(nav.noteId)
    setTrail(dir === 'back' ? { back: from, forward: to } : { back: to, forward: from })
    setFindOnOpen(null)
    setNav({ ...nav, noteId: id })
    setPane('note')
    return true
  }
  // keyboard: ⌘[ and ⌘] (like Safari)
  const stepRef = useRef(step)
  stepRef.current = step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === '[' && stepRef.current('back')) e.preventDefault()
      else if (e.key === ']' && stepRef.current('forward')) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // phones: which way screens slide (deeper: folders → notes → note)
  const depth = { folders: 0, list: 1, note: 2 } as const
  const lastPane = useRef(pane)
  const navDir = useRef<'fwd' | 'back'>('fwd')
  if (lastPane.current !== pane) {
    navDir.current = depth[pane] > depth[lastPane.current] ? 'fwd' : 'back'
    lastPane.current = pane
  }
  /** iPad / computer: the notes / Jobs column widened over the note area */
  const [listExpanded, setListExpanded] = useState(false)
  const sidebarInline = !narrow && wide && layout === 3
  const sidebarVisible = narrow ? pane === 'folders' : sidebarInline || overlay
  const listVisible = narrow ? pane === 'list' : layout >= 2
  const editorVisible = narrow ? pane === 'note' : true

  /** Editor's sidebar button: cycle 3 → 2 → 1 → 3 columns (like Apple Notes). */
  const cyclePanels = () => {
    setOverlay(false)
    if (wide) setLayout(layout === 3 ? 2 : layout === 2 ? 1 : 3)
    else setLayout(layout >= 2 ? 1 : 2)
  }
  /**
   * Swipe in from the left edge: show the notes, then (swiping again) the
   * folders. Swipe left on a panel to hide them again. Phones: the edge swipe
   * goes back a screen.
   */
  const openNext = () => {
    if (narrow) setPane(pane === 'note' && !(fromSearch && search.trim()) ? 'list' : 'folders')
    else if (layout === 1) setLayout(2)
    else if (wide) setLayout(3)
    else setOverlay(true)
  }
  const closeOne = () => {
    if (narrow) return
    if (overlay) setOverlay(false)
    else if (sidebarInline) setLayout(2)
    else if (layout >= 2 && nav.noteId) setLayout(1)
  }
  /** the note is on screen, so the edge swipes walk the link trail first */
  const noteShown = Boolean(nav.noteId) && (narrow ? pane === 'note' : true)
  useEdgeSwipe(
    () => {
      if (!(noteShown && step('back'))) openNext()
    },
    () => {
      if (noteShown) step('forward')
    },
    closeOne,
  )

  /** Notes list's sidebar button: show/hide the folders. */
  const toggleFolders = () => {
    if (wide) setLayout(layout === 3 ? 2 : 3)
    else setOverlay(!overlay)
  }

  // ⌘K window: open it, and what it can do from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const showView = (view: View) => {
    setNav({ ...nav, view })
    if (narrow) setPane('list')
    else if (layout === 1) setLayout(2)
  }
  const appRef = useRef({ nav, showView, openNote, showSearch, setTheme: (t: 'light' | 'dark' | 'system') => settings.set({ theme: t }) })
  appRef.current = { nav, showView, openNote, showSearch, setTheme: (t) => settings.set({ theme: t }) }
  // the buttons on "job finished" messages
  useEffect(() => setJobNavigator({ openNote: (id) => appRef.current.openNote(id), showJobs: () => appRef.current.showView({ kind: 'jobs' }), showSearch: (q) => appRef.current.showSearch(q) }), [])
  const templatesKey = ws.notes.filter((n) => n.template && !n.trashedAt).map((n) => `${n.id}:${n.title}`).join('|')
  const openNoteMeta = note && !note.trashedAt ? note : null
  useEffect(() => {
    const a = () => appRef.current
    const G = 'Go to'
    const N = 'Notes'
    const folderNow = () => (a().nav.view.kind === 'folder' ? (a().nav.view as { folderId: string }).folderId : null)
    const commands = [
      { id: 'new-note', label: 'New note', section: N, keywords: 'create add', run: () => a().openNote(createNote(workspaceDoc, { folderId: folderNow() })) },
      { id: 'today', label: 'Today’s note', section: N, keywords: 'daily journal date', run: () => void openDailyNote().then((id) => a().openNote(id)) },
      { id: 'new-meeting', label: 'New meeting', section: N, keywords: 'record minutes agenda action items', run: () => void startMeeting(folderNow()).then((id) => a().openNote(id)) },
      {
        id: 'new-folder',
        label: 'New folder',
        section: N,
        run: () => {
          const name = prompt('Folder name', 'New folder')
          if (name) a().showView({ kind: 'folder', folderId: createFolder(workspaceDoc, { name }) })
        },
      },
      ...listNotes(workspaceDoc)
        .filter((n) => n.template && !n.trashedAt)
        .map((t) => ({ id: `tpl-${t.id}`, label: `New note from template: ${t.title || 'Untitled'}`, section: N, run: () => void newNoteFromTemplate(t.id, folderNow()).then((id) => a().openNote(id)) })),
      { id: 'web-import', label: 'Import a web page…', section: N, keywords: 'website url guide manual article download save link', run: () => setWebImport({ folderId: folderNow() }) },
      { id: 'all', label: 'All Notes', section: G, run: () => a().showView({ kind: 'all' }) },
      { id: 'unfiled', label: 'Not in a folder', section: G, run: () => a().showView({ kind: 'unfiled' }) },
      { id: 'jobs', label: 'Jobs (AI and processing)', section: G, keywords: 'queue ai running tasks progress', run: () => a().showView({ kind: 'jobs' }) },
      { id: 'tasks', label: 'Tasks', section: G, keywords: 'to-dos todo checklist all', run: () => a().showView({ kind: 'tasks' }) },
      { id: 'due', label: 'Due items', section: G, keywords: 'reminders deadlines calendar', run: () => a().showView({ kind: 'due' }) },
      { id: 'templates', label: 'Templates', section: G, run: () => a().showView({ kind: 'templates' }) },
      { id: 'trash', label: 'Recently Deleted', section: G, keywords: 'trash bin', run: () => a().showView({ kind: 'trash' }) },
      { id: 'tips', label: 'Show the tips again', section: 'App', keywords: 'help tour welcome how', run: () => setTourOpen(true) },
      { id: 'settings', label: 'Settings', section: 'App', keywords: 'preferences server backups devices export import', run: () => setSettingsOpen(true) },
      ...SETTINGS_TABS.map((t) => ({ id: `settings-${t.id}`, label: `Settings › ${t.label}`, section: 'App', keywords: `preferences ${t.blurb}`, run: () => setSettingsOpen(t.id) })),
      { id: 'theme-light', label: 'Light appearance', section: 'App', keywords: 'theme', run: () => a().setTheme('light') },
      { id: 'theme-dark', label: 'Dark appearance', section: 'App', keywords: 'theme night', run: () => a().setTheme('dark') },
      { id: 'theme-system', label: 'Match system appearance', section: 'App', keywords: 'theme auto', run: () => a().setTheme('system') },
      { id: 'back', label: 'Back to the previous note', section: G, shortcut: '⌘[', run: () => void stepRef.current('back') },
      { id: 'forward', label: 'Forward', section: G, shortcut: '⌘]', run: () => void stepRef.current('forward') },
    ]
    const vf = folderNow()
    if (vf) {
      const kept = isKeptOffline(vf)
      if (kept !== 'parent')
        commands.push({ id: 'offline', label: kept ? 'Stop keeping this folder offline' : 'Keep this folder offline on this device', section: N, keywords: 'download', run: () => setKeepOffline(vf, !kept) })
    }
    if (openNoteMeta) {
      const id = openNoteMeta.id
      commands.push(
        { id: 'pin', label: openNoteMeta.pinned ? 'Unpin this note' : 'Pin this note', section: 'This note', keywords: 'top', run: () => pinNotes([id], !openNoteMeta.pinned) },
        { id: 'move', label: 'Move this note to…', section: 'This note', keywords: 'folder', run: () => setMoving({ kind: 'note', id }) },
        { id: 'delete', label: 'Delete this note', section: 'This note', keywords: 'trash remove', run: () => trashNotes([id]) },
      )
    }
    return registerCommands('app', commands)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatesKey, nav.view, openNoteMeta?.id, openNoteMeta?.pinned])

  return (
    <div className={`app${narrow ? ' narrow' : ''}${wide ? ' wide' : ''}${!narrow && listExpanded && listVisible ? ' list-expanded' : ''}`}>
      <Panel
        show={sidebarVisible}
        mode={narrow ? 'push' : overlay && !sidebarInline ? 'none' : 'side'}
        dir={navDir.current}
        className="panel-sidebar"
      >
        {overlay && !sidebarInline && <div className="sidebar-backdrop" onClick={() => setOverlay(false)} />}
        <Sidebar
          overlay={overlay && !sidebarInline}
          view={nav.view}
          onView={(view) => {
            setNav({ ...nav, view })
            if (narrow) setPane('list')
            else if (overlay) setOverlay(false)
            if (!narrow && layout === 1) setLayout(2)
          }}
          onClose={narrow ? undefined : () => (overlay ? setOverlay(false) : setLayout(2))}
          onSettings={() => setSettingsOpen(true)}
          onCommands={() => setPaletteOpen(true)}
          onMoveFolder={(id) => setMoving({ kind: 'folder', id })}
          search={search}
          onSearch={setSearch}
          activeNoteId={nav.noteId}
          onOpenResult={(id, findText) => {
            // the note opens with its find bar on the match
            openNote(id, findText ?? search)
            if (overlay && !sidebarInline) setOverlay(false)
          }}
        />
      </Panel>
      <Panel show={listVisible} mode={narrow ? 'push' : 'side'} dir={navDir.current} className="panel-list">
        <div className="list-col">
          {nav.view.kind === 'jobs' ? (
            <JobsPanel
              onOpenNote={openNote}
              onBack={narrow ? () => setPane('folders') : undefined}
              onToggleFolders={!narrow && !sidebarInline ? toggleFolders : undefined}
              expanded={listExpanded}
              onToggleExpand={narrow ? undefined : () => setListExpanded(!listExpanded)}
            />
          ) : (
          <NoteList
            view={nav.view}
            noteId={nav.noteId}
            onOpen={openNote}
            onBack={narrow ? () => setPane('folders') : undefined}
            onToggleFolders={!narrow && !sidebarInline ? toggleFolders : undefined}
            expanded={listExpanded}
            onToggleExpand={narrow ? undefined : () => setListExpanded(!listExpanded)}
            onMoveNote={(id) => setMoving({ kind: 'note', id })}
            onMoveNotes={(ids) => setMoving({ kind: 'notes', ids })}
          />
          )}
        </div>
      </Panel>
      <Panel show={editorVisible} mode={narrow ? 'push' : 'none'} dir={navDir.current} className="panel-editor">
        <main className="editor-col">
          {noteLockedBy ? (
            <LockedScreen folderId={noteLockedBy} what="note" />
          ) : noteDoc?.ready && nav.noteId ? (
            <NoteEditor
              key={nav.noteId}
              noteId={nav.noteId}
              doc={noteDoc.doc}
              folderId={note?.folderId ?? null}
              onOpenNote={openNote}
              onFollowLink={followFromNote}
              onBack={narrow ? () => setPane(fromSearch && search.trim() ? 'folders' : 'list') : undefined}
              onTogglePanels={narrow ? undefined : cyclePanels}
              fullScreen={!narrow && layout === 1}
              initialFind={findOnOpen?.noteId === nav.noteId ? findOnOpen : undefined}
              onOpenTag={(tag) => {
                setNav({ ...nav, view: { kind: 'tag', tag } })
                if (narrow) setPane('list')
                else if (layout === 1) setLayout(2)
              }}
            />
          ) : (
            <div className="no-note">
              {narrow ? null : (
                <>
                  <p>Select a note or create a new one.</p>
                  {layout === 1 && (
                    <button className="text" onClick={() => setLayout(wide ? 3 : 2)}>
                      <PanelLeft size={16} /> Show notes
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </main>
      </Panel>
      {settingsOpen && <SettingsDialog tab={settingsOpen === true ? undefined : settingsOpen} onClose={() => setSettingsOpen(false)} />}
      {moving && <MoveDialog target={moving} onClose={() => setMoving(null)} />}
      {/* the way back from a link: centred on the whole screen, where "Back to chat" sits (above it when both show) */}
      {backTo.length > 0 &&
        nav.noteId &&
        editorVisible &&
        createPortal(
          <div className={`link-back${chatAside ? ' above-chat' : ''}`}>
            <button className="link-back-go" onClick={goBackTo} title="Back to where the link was">
              <ArrowLeft size={16} />
              <span className="link-back-to">{backTo.at(-1)!.noteId !== nav.noteId ? `Back to ${noteTitle(backTo.at(-1)!.noteId)}` : 'Back'}</span>
            </button>
            <button className="icon" aria-label="Forget the way back" onClick={() => setBackTo([])}>
              <X size={15} />
            </button>
          </div>,
          document.body,
        )}
      <Toaster />
      <HideKeyboardButton />
      <RecordingPill shownNoteId={editorVisible ? nav.noteId : null} onOpen={(id) => openFromReminder.current(id)} />
      <ImageViewerHost />
      <AskChatHost onOpen={followLink} />
      <ReferencesHost onOpen={followLink} />
      {tourOpen && <Tour onClose={() => setTourOpen(false)} onSettings={() => setSettingsOpen('sync')} />}
      {webImport && <WebImportDialog folderId={webImport.folderId} onClose={() => setWebImport(null)} onOpen={(id) => openNote(id)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenNote={openNote}
          onOpenFolder={(folderId) => showView({ kind: 'folder', folderId })}
          onOpenTag={(tag) => showView({ kind: 'tag', tag })}
          onSearch={showSearch}
        />
      )}
    </div>
  )
}
