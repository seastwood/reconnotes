import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, PanelLeft, X } from 'lucide-react'
import { getNotes, readNote } from '@reconnotes/core'
import { Sidebar, type View } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { setJobNavigator } from './lib/jobs'
import { SETTINGS_TABS, type SettingsTab } from './components/settingsTabs'
import type { MoveTarget } from './components/MoveDialog'
import { NoteEditor } from './editor/Editor'
import { useNoteDoc, useWorkspace, workspaceDoc } from './lib/workspace'
import { settings, useSettings } from './lib/settings'
import { usePencilInteractions } from './drawing/PencilPalette'
import { safeLocalGet, safeLocalSet, useStore } from './lib/store'
import { ALL_NOTES, DOCK_MEDIA, askChat, browseChats, openAskChat, openChatRef, toggleAskChat } from './lib/askChat'
import { startReminders } from './lib/reminders'
import { startPush } from './lib/push'
import { resumeRecording } from './lib/recorder'
import { RecordingPill } from './components/RecordingPill'
import { LockedScreen } from './components/LockedScreen'
import type { ImportTab, PhotoKind } from './components/WebImportDialog'
import { AskChatHost } from './components/AskChat'
import { ReferencesHost } from './components/References'
import { useFolderAccess } from './lib/folderLock'
import { startShareInbox } from './lib/shareInbox'
import { Toaster } from './components/Toaster'
import { HideKeyboardButton } from './components/HideKeyboardButton'
import { Panel } from './components/Panel'
import { ColumnResizer, savedColumnWidths } from './components/ColumnResizer'
import { ImageViewerHost } from './components/ImageViewer'
import { CommandPalette } from './components/CommandPalette'
import { shouldShowTour } from './components/Tour'
import { noteOpened } from './lib/recentNotes'
import { registerCommands } from './lib/commands'
import { createFolder, createNote, listNotes, updateNote } from '@reconnotes/core'
import { pinNotes, trashNotes } from './lib/noteActions'
import { newNoteFromTemplate } from './lib/templates'
import { isKeptOffline, setKeepOffline } from './lib/offline'
import { quickAction, startAppLinks, type LinkAction } from './lib/appLinks'
import * as Y from 'yjs'
import { getContent, noteDocName } from '@reconnotes/core'
import { sync } from './lib/sync'
import { useMedia } from './lib/media'
import { startMeeting } from './lib/meeting'

// opened now and then: loaded the first time they are (a smaller app to start)
const SettingsDialog = lazy(() => import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog })))
const MoveDialog = lazy(() => import('./components/MoveDialog').then((m) => ({ default: m.MoveDialog })))
const WebImportDialog = lazy(() => import('./components/WebImportDialog').then((m) => ({ default: m.WebImportDialog })))
const JobsPanel = lazy(() => import('./components/JobsPanel').then((m) => ({ default: m.JobsPanel })))
const Tour = lazy(() => import('./components/Tour').then((m) => ({ default: m.Tour })))

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
 * iPad (and touch computers): the folders and notes columns follow the finger. Swipe right from the
 * left edge, or on a column, and the next column slides in as you drag – the note making room; swipe
 * left on a column and it slides away. Let go far enough along (or with a flick) and it goes there,
 * else it slides back. What can't follow (the folders over the note, on a narrower screen; the link
 * trail) happens on the flick, as before. Pencil and mouse are ignored, and so are vertical moves.
 */
type Column = 'folders' | 'list'
function useSideSwipe(
  enabled: boolean,
  api: {
    /** the column a swipe right brings in (null: one that can't follow the finger – `open` does it) */
    willOpen: () => Column | null
    /** the column a swipe left puts away (null: as above, with `close`) */
    willClose: () => Column | null
    open: () => void
    close: () => void
    /** a note reached by a link: back along the links (no sliding), if there is one */
    linkBack: () => boolean
    /** the finger is moving this column (opening: it's on screen, starting fully to the left) */
    begin: (c: Column, opening: boolean) => void
    /** done: shown or not; `undo` puts the columns back as they were before an opening that went back */
    end: (undo: boolean) => void
  },
) {
  const ref = useRef({ enabled, api })
  ref.current = { enabled, api }
  useEffect(() => {
    const EDGE = 28
    type Drag = { x0: number; y0: number; fromEdge: boolean; onPanel: boolean; t0: number; locked: null | { opening: boolean; col: Column | null }; last: { x: number; t: number }[] }
    let d: Drag | null = null
    const CLS: Record<Column, string> = { folders: '.panel-sidebar', list: '.panel-list' }
    const el = (c: Column) => document.querySelector<HTMLElement>(CLS[c])
    const width = (c: Column) => el(c)?.getBoundingClientRect().width || 300
    const put = (c: Column, margin: number, animate: boolean) => {
      const e = el(c)
      if (!e) return
      e.style.transition = animate ? 'margin-left 200ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      e.style.marginLeft = `${margin}px`
    }
    const clear = (c: Column) => {
      const e = el(c)
      if (e) e.style.transition = e.style.marginLeft = ''
    }
    const down = (e: TouchEvent) => {
      d = null
      const t = e.touches[0]
      if (!ref.current.enabled || e.touches.length !== 1 || !t || (t as Touch & { touchType?: string }).touchType === 'stylus') return
      const target = e.target as Element
      // the picture viewer and the chat have their own gestures
      if (target.closest?.('.image-viewer, .ask-chat, .ask-dock, .dialog, .menu, .cook-mode') || document.querySelector('.ask-chat:not(.docked)')) return
      const fromEdge = t.clientX <= EDGE
      const onPanel = Boolean(target.closest?.('.sidebar, .list-col')) && !target.closest?.('input, textarea, [contenteditable="true"]')
      if (!fromEdge && !onPanel) return
      d = { x0: t.clientX, y0: t.clientY, fromEdge, onPanel, t0: Date.now(), locked: null, last: [] }
    }
    const move = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!d || !t) return
      const dx = t.clientX - d.x0
      const dy = t.clientY - d.y0
      if (!d.locked) {
        if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) return void (d = null) // scrolling
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return
        const opening = dx > 0
        if (!opening && !d.onPanel) return void (d = null)
        if (opening && d.fromEdge && ref.current.api.linkBack()) return void (d = null)
        const col = opening ? ref.current.api.willOpen() : ref.current.api.willClose()
        d.locked = { opening, col }
        if (col) {
          ref.current.api.begin(col, opening)
          if (opening) ref.current.api.open()
        }
      }
      if (e.cancelable) e.preventDefault()
      const { opening, col } = d.locked
      if (!col) return
      d.last = [...d.last.slice(-4), { x: t.clientX, t: performance.now() }]
      const w = width(col)
      put(col, opening ? Math.min(0, Math.max(-w, -w + dx)) : Math.min(0, Math.max(-w, dx)), false)
    }
    const up = (e: TouchEvent) => {
      const drag = d
      d = null
      if (!drag?.locked) return
      const t = e.changedTouches[0]
      const dx = (t?.clientX ?? drag.x0) - drag.x0
      const { opening, col } = drag.locked
      if (!col) {
        // what can't follow the finger: on a flick, as before
        if (Date.now() - drag.t0 < 800 && Math.abs(dx) > 60) (opening ? ref.current.api.open : ref.current.api.close)()
        return
      }
      const a = drag.last[0]
      const b = drag.last[drag.last.length - 1]
      const v = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0
      const w = width(col)
      const go = opening ? dx > w * 0.35 || v > 0.45 : -dx > w * 0.35 || v < -0.45
      if (opening) {
        put(col, go ? 0 : -w, true)
        setTimeout(() => {
          ref.current.api.end(!go)
          // (let go too soon: it's leaving – kept out of sight until it's gone)
          if (go) clear(col)
        }, 210)
      } else {
        put(col, go ? -w : 0, true)
        setTimeout(() => {
          if (go) ref.current.api.close()
          ref.current.api.end(false)
          if (!go) clear(col)
        }, 210)
      }
    }
    window.addEventListener('touchstart', down, { passive: true, capture: true })
    window.addEventListener('touchmove', move, { passive: false, capture: true })
    window.addEventListener('touchend', up, { passive: true, capture: true })
    window.addEventListener('touchcancel', up, { passive: true, capture: true })
    return () => {
      window.removeEventListener('touchstart', down, { capture: true })
      window.removeEventListener('touchmove', move, { capture: true })
      window.removeEventListener('touchend', up, { capture: true })
      window.removeEventListener('touchcancel', up, { capture: true })
    }
  }, [])
}

type Pane = 'folders' | 'list' | 'note'
const PANE_CLASS: Record<Pane, string> = { folders: '.panel-sidebar', list: '.panel-list', note: '.panel-editor' }

/**
 * Phones: the screens – folders › notes › note (› chat, AskChat.tsx) – move with the finger, like
 * iOS: swipe right (from the left edge, or anywhere on the folders or notes) and the screen slides
 * away to show the one before underneath; swipe left (from the right edge, or anywhere on the
 * folders or notes) and the next slides in over it. Let go far enough along (or with a flick) and
 * it goes there; else it slides back. On a note reached through links, the left edge goes back
 * along the links first.
 */
function usePaneSwipe(
  enabled: boolean,
  api: {
    current: () => Pane
    prev: () => Pane | null
    next: () => Pane | null
    /** a note reached by a link: back to that note (no sliding), if there is one */
    linkBack: () => boolean
    begin: (p: Pane) => void
    finish: (p: Pane | null) => void
  },
) {
  const ref = useRef({ enabled, api })
  ref.current = { enabled, api }
  useEffect(() => {
    const EDGE = 24
    type Drag = { x0: number; y0: number; edge: 'left' | 'right' | null; onPanel: boolean; locked: null | { dir: 'back' | 'fwd'; to: Pane | 'link' }; last: { x: number; t: number }[] }
    let d: Drag | null = null
    const W = () => innerWidth
    const els = (to: Pane) => [document.querySelector<HTMLElement>(PANE_CLASS[ref.current.api.current()]), document.querySelector<HTMLElement>(PANE_CLASS[to])] as const
    const paint = (dir: 'back' | 'fwd', to: Pane, p: number, animate: boolean) => {
      const [cur, other] = els(to)
      const tr = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 220ms' : 'none'
      for (const e of [cur, other]) if (e) e.style.transition = tr
      if (dir === 'back') {
        if (cur) Object.assign(cur.style, { transform: `translateX(${p * W()}px)`, zIndex: '3', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' })
        if (other) Object.assign(other.style, { transform: `translateX(${-28 * (1 - p)}%)`, opacity: String(0.7 + 0.3 * p), zIndex: '1' })
      } else {
        if (other) Object.assign(other.style, { transform: `translateX(${(1 - p) * W()}px)`, zIndex: '3', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' })
        if (cur) Object.assign(cur.style, { transform: `translateX(${-28 * p}%)`, opacity: String(1 - 0.3 * p), zIndex: '1' })
      }
    }
    const clear = () =>
      document.querySelectorAll<HTMLElement>('.app.narrow > .panel').forEach((e) => {
        for (const k of ['transition', 'transform', 'opacity', 'zIndex', 'boxShadow'] as const) e.style[k] = ''
      })
    const down = (e: TouchEvent) => {
      d = null
      const t = e.touches[0]
      if (!ref.current.enabled || e.touches.length !== 1 || !t || (t as Touch & { touchType?: string }).touchType === 'stylus') return
      const el = e.target as Element
      // the chat, the picture viewer and cook mode have their own gestures
      if (el.closest?.('.ask-chat, .image-viewer, .cook-mode, .dialog, .menu') || document.querySelector('.ask-chat:not(.docked)')) return
      const edge = t.clientX <= EDGE ? 'left' : t.clientX >= W() - EDGE ? 'right' : null
      const onPanel = Boolean(el.closest?.('.sidebar, .list-col')) && !el.closest?.('input, textarea, [contenteditable="true"]')
      if (!edge && !onPanel) return
      d = { x0: t.clientX, y0: t.clientY, edge, onPanel, locked: null, last: [] }
    }
    const move = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!d || !t) return
      const dx = t.clientX - d.x0
      const dy = t.clientY - d.y0
      if (!d.locked) {
        if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) return void (d = null) // scrolling
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return
        const dir = dx > 0 ? 'back' : 'fwd'
        const cur = ref.current.api.current()
        // the note's right edge is the chat's
        if (dir === 'fwd' && (cur === 'note' || !(d.edge === 'right' || d.onPanel))) return void (d = null)
        if (dir === 'back' && !(d.edge === 'left' || d.onPanel)) return void (d = null)
        if (dir === 'back' && cur === 'note' && d.edge === 'left' && ref.current.api.linkBack()) {
          d.locked = { dir, to: 'link' }
          return
        }
        const to = dir === 'back' ? ref.current.api.prev() : ref.current.api.next()
        if (!to) return void (d = null)
        d.locked = { dir, to }
        ref.current.api.begin(to)
      }
      if (e.cancelable) e.preventDefault()
      if (d.locked.to === 'link') return
      d.last = [...d.last.slice(-4), { x: t.clientX, t: performance.now() }]
      const p = Math.max(0, Math.min(1, Math.abs(dx) / W()))
      paint(d.locked.dir, d.locked.to, (d.locked.dir === 'back') === dx > 0 ? p : 0, false)
    }
    const up = (e: TouchEvent) => {
      const drag = d
      d = null
      if (!drag?.locked) return
      const { dir, to } = drag.locked
      if (to === 'link') return // went back along the links already
      const t = e.changedTouches[0]
      const dx = (t?.clientX ?? drag.x0) - drag.x0
      const a = drag.last[0]
      const b = drag.last[drag.last.length - 1]
      const v = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0
      const go = Math.abs(dx) > W() * 0.35 ? (dir === 'back') === dx > 0 : dir === 'back' ? v > 0.45 : v < -0.45
      paint(dir, to, go ? 1 : 0, true)
      setTimeout(() => {
        ref.current.api.finish(go ? to : null)
        requestAnimationFrame(() => requestAnimationFrame(clear))
      }, 230)
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', up, { passive: true })
    window.addEventListener('touchcancel', up, { passive: true })
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      window.removeEventListener('touchcancel', up)
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
  // the folders and notes columns as wide as they were dragged to (see ColumnResizer)
  const [columnWidths] = useState(savedColumnWidths)
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
  const [webImport, setWebImport] = useState<{ folderId: string | null; startOn?: { tab: ImportTab; kind?: PhotoKind } } | null>(null)
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
  // the notes opened last (⌘K and search offer them)
  useEffect(() => noteOpened(nav.noteId), [nav.noteId])
  // iOS app: tapping a notification from the server opens what it's about
  useEffect(() => startPush({ note: (id) => openFromReminder.current(id), search: (q) => appRef.current.showSearch(q) }), [])
  // iOS app: things shared to ReconNotes become notes
  useEffect(() => startShareInbox((id) => openFromReminder.current(id)), [])
  // widget, Siri / Shortcuts and home-screen shortcuts: new note, record, scan…
  const onLink = useRef<(a: LinkAction) => void>(() => undefined)
  onLink.current = (a) => {
    if (a.kind === 'open') return openFromReminder.current(a.noteId, a.find)
    if (a.kind === 'search') return showSearch(a.query)
    if (a.kind === 'chat') return openChatRef(a)
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
  // computer / iPad, with the folders showing: the notes list can be put away on its own
  const [listHidden, setListHiddenState] = useState(() => safeLocalGet<{ v: boolean }>('reconnotes.listHidden', { v: false }).v)
  const setListHidden = (v: boolean) => {
    setListHiddenState(v)
    safeLocalSet('reconnotes.listHidden', { v })
  }
  const listAway = listHidden && sidebarInline
  const listVisible = narrow ? pane === 'list' : layout >= 2 && !listAway
  const editorVisible = narrow ? pane === 'note' : true

  /** Editor's sidebar button: cycle 3 → 2 → 1 → 3 columns (like Apple Notes). */
  const cyclePanels = () => {
    setOverlay(false)
    // the notes list put away: it comes back first
    if (listAway) return setListHidden(false)
    if (wide) setLayout(layout === 3 ? 2 : layout === 2 ? 1 : 3)
    else setLayout(layout >= 2 ? 1 : 2)
  }
  /**
   * Swipe in from the left edge: show the notes, then (swiping again) the
   * folders – or swipe right on the notes list. Swipe left on a panel to hide
   * them again. Phones: the edge swipe (or a swipe right on the list) goes back
   * a screen.
   */
  const openNext = () => {
    if (narrow) setPane(pane === 'note' && !(fromSearch && search.trim()) ? 'list' : 'folders')
    else if (listAway) setListHidden(false)
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
  // phones: screens that follow the finger
  const [peek, setPeek] = useState<Pane | null>(null)
  const [instant, setInstant] = useState(false)
  // where a screen being pulled in starts (before the finger moves it: no flash in place)
  const peekStyle = (p: Pane): React.CSSProperties | undefined =>
    peek !== p ? undefined : depth[p] > depth[pane] ? { transform: 'translateX(100%)', zIndex: 3 } : { transform: 'translateX(-28%)', opacity: 0.7, zIndex: 1 }
  useEffect(() => {
    if (!instant) return
    const t = setTimeout(() => setInstant(false), 60)
    return () => clearTimeout(t)
  }, [instant])
  usePaneSwipe(narrow, {
    current: () => pane,
    prev: () => (pane === 'note' ? (fromSearch && search.trim() ? 'folders' : 'list') : pane === 'list' ? 'folders' : null),
    next: () => (pane === 'folders' ? 'list' : pane === 'list' && nav.noteId && isOpenable(nav.noteId) ? 'note' : null),
    linkBack: () => step('back'),
    begin: (p) => (setInstant(true), setPeek(p)),
    finish: (p) => {
      setInstant(true)
      if (p) setPane(p)
      setPeek(null)
    },
  })
  // iPad / computer: the columns follow the finger (sideDrag: which one, while it does)
  const [sideDrag, setSideDrag] = useState<{ col: Column; opening: boolean; before: { layout: 1 | 2 | 3; listHidden: boolean } } | null>(null)
  const sideDragRef = useRef(sideDrag)
  sideDragRef.current = sideDrag
  useSideSwipe(!narrow, {
    willOpen: () => (listAway || layout === 1 ? 'list' : wide && layout === 2 ? 'folders' : null),
    willClose: () => (overlay ? null : sidebarInline ? 'folders' : layout >= 2 && nav.noteId ? 'list' : null),
    open: openNext,
    close: closeOne,
    linkBack: () => noteShown && step('back'),
    begin: (col, opening) => setSideDrag({ col, opening, before: { layout, listHidden } }),
    end: (undo) => {
      // pulled in, then let go too soon: the columns as they were
      const d = sideDragRef.current
      if (undo && d) {
        setLayout(d.before.layout)
        setListHidden(d.before.listHidden)
      }
      // (a moment later: the column just shown or hidden mustn't slide again on its own)
      setTimeout(() => setSideDrag(null), 80)
    },
  })
  /** the column the finger moves: no slide of its own; one being pulled in starts out of sight */
  const sideStyle = (col: Column): React.CSSProperties | undefined => (sideDrag?.col === col && sideDrag.opening ? { marginLeft: 'calc(-1 * var(--pw))' } : undefined)

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
  // the chat beside the note: if that leaves the note too narrow, the folders (then the notes list)
  // step aside – and come back when the chat closes
  const chatOpen = useStore(askChat, (s) => Boolean(s.target || s.browsing))
  const roomForChat = useMedia(DOCK_MEDIA)
  const chatDocked = chatOpen && roomForChat && !narrow
  // (kept across restarts: closed in the meantime, the columns still come back)
  const madeRoomFrom = useRef<1 | 2 | 3 | null>(safeLocalGet<{ v: 1 | 2 | 3 | null }>('reconnotes.layoutBeforeChat', { v: null }).v)
  const roomFrom = (v: 1 | 2 | 3 | null) => {
    madeRoomFrom.current = v
    safeLocalSet('reconnotes.layoutBeforeChat', { v })
  }
  useLayoutEffect(() => {
    if (!chatDocked) {
      if (madeRoomFrom.current !== null) setLayout(madeRoomFrom.current)
      if (madeRoomFrom.current !== null) roomFrom(null)
      return
    }
    // worked out from the columns' widths (measuring mid-animation would take away too much)
    const css = getComputedStyle(document.querySelector('.app') ?? document.documentElement)
    const px = (name: string, fallback: number) => parseFloat(css.getPropertyValue(name)) || fallback
    const chatW = document.querySelector('.ask-dock')?.getBoundingClientRect().width ?? 420
    const noteW = (l: 1 | 2 | 3) => innerWidth - chatW - (l >= 3 ? px('--sidebar-w', 260) : 0) - (l >= 2 && !(listHidden && l === 3) ? px('--list-w', 320) : 0)
    let fit = layout
    while (fit > 1 && noteW(fit) < 460) fit = (fit - 1) as 1 | 2
    if (fit !== layout) {
      if (madeRoomFrom.current === null) roomFrom(layout)
      setLayout(fit)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatDocked])
  const showView = (view: View) => {
    setNav({ ...nav, view })
    if (listHidden) setListHidden(false)
    if (narrow) setPane('list')
    else if (layout === 1) setLayout(2)
  }
  const appRef = useRef({ nav, showView, openNote, showSearch, setTheme: (t: 'light' | 'dark' | 'system') => settings.set({ theme: t }) })
  appRef.current = { nav, showView, openNote, showSearch, setTheme: (t) => settings.set({ theme: t }) }
  // the buttons on "job finished" messages
  useEffect(() => setJobNavigator({ openNote: (id) => appRef.current.openNote(id), showJobs: () => appRef.current.showView({ kind: 'jobs' }) }), [])
  const templatesKey = ws.notes.filter((n) => n.template && !n.trashedAt).map((n) => `${n.id}:${n.title}`).join('|')
  const openNoteMeta = note && !note.trashedAt ? note : null
  useEffect(() => {
    const a = () => appRef.current
    const G = 'Go to'
    const N = 'Notes'
    const folderNow = () => (a().nav.view.kind === 'folder' ? (a().nav.view as { folderId: string }).folderId : null)
    const commands = [
      { id: 'new-note', label: 'New note', section: N, keywords: 'create add', run: () => a().openNote(createNote(workspaceDoc, { folderId: folderNow() })) },
      { id: 'ask-chat', label: 'Ask your notes (chat)', section: N, keywords: 'question ai chat answer', run: () => openAskChat(ALL_NOTES) },
      { id: 'chat-toggle', label: 'Show or hide the chat', section: N, keywords: 'ask ai panel side', run: () => toggleAskChat(null) },
      { id: 'chats', label: 'All chats', section: N, keywords: 'ask ai history conversations', run: () => browseChats() },
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
      { id: 'web-import', label: 'Import a web page…', section: N, keywords: 'website url guide manual article download save link', run: () => setWebImport({ folderId: folderNow(), startOn: { tab: 'web' } }) },
      { id: 'recipe-photos', label: 'Recipe from photos…', section: N, keywords: 'hello fresh meal kit card cookbook scan picture camera', run: () => setWebImport({ folderId: folderNow(), startOn: { tab: 'photos', kind: 'recipe' } }) },
      { id: 'photo-pages', label: 'Import photos of pages…', section: N, keywords: 'handwriting book page printed directions trail hike route scan picture camera ocr', run: () => setWebImport({ folderId: folderNow(), startOn: { tab: 'photos' } }) },
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
    <div className={`app${narrow ? ' narrow' : ''}${wide ? ' wide' : ''}${!narrow && listExpanded && listVisible ? ' list-expanded' : ''}`} style={narrow ? undefined : columnWidths}>
      <Panel
        show={sidebarVisible || peek === 'folders'}
        mode={narrow ? 'push' : overlay && !sidebarInline ? 'none' : 'side'}
        dir={navDir.current}
        className="panel-sidebar"
        instant={narrow ? instant || peek !== null : sideDrag !== null}
        style={narrow ? peekStyle('folders') : sideStyle('folders')}
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
            // choosing a folder brings its notes back
            if (listHidden) setListHidden(false)
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
        {!narrow && !(overlay && !sidebarInline) && <ColumnResizer name="--sidebar-w" label="folders" />}
      </Panel>
      <Panel show={listVisible || peek === 'list'} mode={narrow ? 'push' : 'side'} dir={navDir.current} className="panel-list" instant={narrow ? instant || peek !== null : sideDrag !== null} style={narrow ? peekStyle('list') : sideStyle('list')}>
        <div className="list-col">
          {nav.view.kind === 'jobs' ? (
            <Suspense fallback={null}>
            <JobsPanel
              onOpenNote={openNote}
              onBack={narrow ? () => setPane('folders') : undefined}
              onToggleFolders={!narrow && !sidebarInline ? toggleFolders : undefined}
              onHide={sidebarInline ? () => setListHidden(true) : undefined}
              expanded={listExpanded}
              onToggleExpand={narrow ? undefined : () => setListExpanded(!listExpanded)}
            />
            </Suspense>
          ) : (
          <NoteList
            view={nav.view}
            noteId={nav.noteId}
            onOpen={openNote}
            onBack={narrow ? () => setPane('folders') : undefined}
            onToggleFolders={!narrow && !sidebarInline ? toggleFolders : undefined}
            onHide={sidebarInline ? () => setListHidden(true) : undefined}
            expanded={listExpanded}
            onToggleExpand={narrow ? undefined : () => setListExpanded(!listExpanded)}
            onMoveNote={(id) => setMoving({ kind: 'note', id })}
            onMoveNotes={(ids) => setMoving({ kind: 'notes', ids })}
            onOpenFolder={(folderId) => showView({ kind: 'folder', folderId })}
          />
          )}
        </div>
        {!narrow && !listExpanded && <ColumnResizer name="--list-w" label="notes list" />}
      </Panel>
      <Panel show={editorVisible || peek === 'note'} mode={narrow ? 'push' : 'none'} dir={navDir.current} className="panel-editor" instant={narrow && (instant || peek !== null)} style={peekStyle('note')}>
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
              fullScreen={!narrow && (layout === 1 || listAway)}
              initialFind={findOnOpen?.noteId === nav.noteId ? findOnOpen : undefined}
              onShowFolder={(view) => {
                // out of the search results: the folders show, this one chosen, the note in its list
                setSearch('')
                showView(view)
              }}
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
      {/* the chat: beside the note on a big screen (or over it, on a phone) */}
      <AskChatHost
        onOpen={followLink}
        onShowFolder={(folderId) => showView({ kind: 'folder', folderId })}
        current={note && nav.noteId && !note.trashedAt ? { noteId: nav.noteId, title: note.title, folderId: note.folderId ?? null } : null}
        noteOnScreen={noteShown && editorVisible && !noteLockedBy}
      />
      <Suspense fallback={null}>
        {settingsOpen && <SettingsDialog tab={settingsOpen === true ? undefined : settingsOpen} onClose={() => setSettingsOpen(false)} />}
        {moving && <MoveDialog target={moving} onClose={() => setMoving(null)} />}
      </Suspense>
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

      <ReferencesHost onOpen={followLink} />
      <Suspense fallback={null}>
        {tourOpen && <Tour onClose={() => setTourOpen(false)} onSettings={() => setSettingsOpen('sync')} />}
        {webImport && <WebImportDialog folderId={webImport.folderId} startOn={webImport.startOn} onClose={() => setWebImport(null)} onOpen={(id) => openNote(id)} />}
      </Suspense>
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
