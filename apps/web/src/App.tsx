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
  const [showSidebar, setShowSidebar] = useState(true)
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
  const sidebarVisible = narrow ? pane === 'folders' : wide || showSidebar
  const listVisible = narrow ? pane === 'list' : true
  const editorVisible = narrow ? pane === 'note' : true

  return (
    <div className={`app${narrow ? ' narrow' : ''}${wide ? ' wide' : ''}${sidebarVisible ? ' with-sidebar' : ''}`}>
      {sidebarVisible && (
        <Sidebar
          view={nav.view}
          onView={(view) => {
            setNav({ ...nav, view })
            if (narrow) setPane('list')
            else if (!wide && view.kind !== 'search') setShowSidebar(false)
          }}
          onSettings={() => setSettingsOpen(true)}
          onMoveFolder={(id) => setMoving({ kind: 'folder', id })}
        />
      )}
      {listVisible && (
        <div className="list-col">
          {!narrow && !wide && (
            <button className="icon sidebar-toggle" onClick={() => setShowSidebar(!showSidebar)} aria-label="Toggle folders">
              <PanelLeft size={20} />
            </button>
          )}
          <NoteList
            view={nav.view}
            noteId={nav.noteId}
            onOpen={openNote}
            onBack={narrow ? () => setPane('folders') : undefined}
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
            />
          ) : (
            <div className="no-note">{narrow ? null : <p>Select a note or create a new one.</p>}</div>
          )}
        </main>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {moving && <MoveDialog target={moving} onClose={() => setMoving(null)} />}
    </div>
  )
}
