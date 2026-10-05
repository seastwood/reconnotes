import { useEffect, useRef, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { getNotes, readNote } from '@reconnotes/core'
import { Sidebar, type View } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { SettingsDialog } from './components/SettingsDialog'
import { MoveDialog, type MoveTarget } from './components/MoveDialog'
import { NoteEditor } from './editor/Editor'
import { useNoteDoc, useWorkspace, workspaceDoc } from './lib/workspace'
import { useSettings } from './lib/settings'
import { usePencilInteractions } from './drawing/PencilPalette'
import { safeLocalGet, safeLocalSet } from './lib/store'
import { startReminders } from './lib/reminders'
import { startShareInbox } from './lib/shareInbox'
import { Toaster } from './components/Toaster'

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moving, setMoving] = useState<MoveTarget | null>(null)

  const setNav = (n: Nav) => {
    setNavState(n)
    if (n.view.kind !== 'search') safeLocalSet('reconnotes.nav', n)
  }

  // If the open note was deleted (here or on another device), close it.
  const meta = nav.noteId ? getNotes(workspaceDoc).get(nav.noteId) : undefined
  const note = meta ? readNote(meta) : null
  useEffect(() => {
    if (ws.loaded && nav.noteId && (!note || note.trashedAt)) setNav({ ...nav, noteId: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, nav.noteId])

  // iOS app: reminders for due items; tapping one opens its note
  const openFromReminder = useRef<(id: string) => void>(() => undefined)
  openFromReminder.current = (id) => {
    setNav({ ...nav, noteId: id })
    setPane('note')
  }
  useEffect(() => startReminders((id) => openFromReminder.current(id)), [])
  // iOS app: things shared to ReconNotes become notes
  useEffect(() => startShareInbox((id) => openFromReminder.current(id)), [])

  const noteDoc = useNoteDoc(note && !note.trashedAt ? nav.noteId : null)

  /** a note opened from search results opens with the find bar on the search text */
  const [findOnOpen, setFindOnOpen] = useState<{ noteId: string; query: string; n: number } | null>(null)
  /**
   * Notes reached by following links, like a browser's history: swipe in from
   * the left edge to go back, from the right edge to go forward. Opening a note
   * any other way (the list, search, a new note) starts over.
   */
  const [trail, setTrail] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] })
  const openNote = (id: string) => {
    setFindOnOpen((f) => (nav.view.kind === 'search' && nav.view.query.trim() ? { noteId: id, query: nav.view.query.trim(), n: (f?.n ?? 0) + 1 } : null))
    setNav({ ...nav, noteId: id })
    setPane('note')
    setTrail({ back: [], forward: [] })
  }
  const followLink = (id: string) => {
    if (id === nav.noteId) return
    if (nav.noteId) setTrail({ back: [...trail.back, nav.noteId].slice(-100), forward: [] })
    setFindOnOpen(null)
    setNav({ ...nav, noteId: id })
    setPane('note')
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
    if (narrow) setPane(pane === 'note' ? 'list' : 'folders')
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

  return (
    <div className={`app${narrow ? ' narrow' : ''}${wide ? ' wide' : ''}`}>
      {sidebarVisible && (
        <>
          {overlay && !sidebarInline && <div className="sidebar-backdrop" onClick={() => setOverlay(false)} />}
          <Sidebar
            overlay={overlay && !sidebarInline}
            view={nav.view}
            onView={(view) => {
              setNav({ ...nav, view })
              if (narrow) setPane('list')
              else if (overlay && view.kind !== 'search') setOverlay(false)
              if (!narrow && layout === 1) setLayout(2)
            }}
            onClose={narrow ? undefined : () => (overlay ? setOverlay(false) : setLayout(2))}
            onSettings={() => setSettingsOpen(true)}
            onMoveFolder={(id) => setMoving({ kind: 'folder', id })}
          />
        </>
      )}
      {listVisible && (
        <div className="list-col">
          <NoteList
            view={nav.view}
            noteId={nav.noteId}
            onOpen={openNote}
            onBack={narrow ? () => setPane('folders') : undefined}
            onToggleFolders={!narrow && !sidebarInline ? toggleFolders : undefined}
            onMoveNote={(id) => setMoving({ kind: 'note', id })}
            onMoveNotes={(ids) => setMoving({ kind: 'notes', ids })}
          />
        </div>
      )}
      {editorVisible && (
        <main className="editor-col">
          {noteDoc?.ready && nav.noteId ? (
            <NoteEditor
              key={nav.noteId}
              noteId={nav.noteId}
              doc={noteDoc.doc}
              folderId={note?.folderId ?? null}
              onOpenNote={openNote}
              onFollowLink={followLink}
              onBack={narrow ? () => setPane('list') : undefined}
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
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {moving && <MoveDialog target={moving} onClose={() => setMoving(null)} />}
      <Toaster />
    </div>
  )
}
