import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { getNotes, readNote } from '@reconnotes/core'
import { Sidebar, type View } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { SettingsDialog } from './components/SettingsDialog'
import { MoveDialog } from './components/MoveDialog'
import { NoteEditor } from './editor/Editor'
import { useNoteDoc, useWorkspace, workspaceDoc } from './lib/workspace'
import { useSettings } from './lib/settings'
import { usePencilInteractions } from './drawing/PencilPalette'
import { safeLocalGet, safeLocalSet } from './lib/store'

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

interface Nav {
  view: View
  noteId: string | null
}

export function App() {
  useTheme()
  usePencilInteractions()
  const ws = useWorkspace()
  const narrow = useMedia('(max-width: 699px)')
  const wide = useMedia('(min-width: 1100px)')
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
  const [moving, setMoving] = useState<{ kind: 'note' | 'folder'; id: string } | null>(null)

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

  const noteDoc = useNoteDoc(note && !note.trashedAt ? nav.noteId : null)

  const openNote = (id: string) => {
    setNav({ ...nav, noteId: id })
    setPane('note')
  }
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
              onBack={narrow ? () => setPane('list') : undefined}
              onTogglePanels={narrow ? undefined : cyclePanels}
              fullScreen={!narrow && layout === 1}
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
    </div>
  )
}
