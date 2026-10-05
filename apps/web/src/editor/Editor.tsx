import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import type * as Y from 'yjs'
import { CONTENT_FIELD, getTranscripts, newId } from '@reconnotes/core'
import { DrawingNode, NoteContext } from '../drawing/DrawingNode'
import { InkToolbar } from '../drawing/InkToolbar'
import { PencilPalette } from '../drawing/PencilPalette'
import { inkUi } from '../drawing/toolState'
import { AudioNode, FileNode, ImageNode, insertFiles } from './nodes'
import { UndoContext, createUndoManager } from './undo'
import { EditorToolbar } from './EditorToolbar'
import { settings } from '../lib/settings'
import { useInputDebugLog } from './debugInput'
import { FindInNote } from './find'
import { FindBar } from './FindBar'

interface Props {
  noteId: string
  doc: Y.Doc
  folderId: string | null
  onOpenNote: (id: string) => void
  onBack?: () => void
  /** iPad/desktop: cycle folders / notes / full-screen note */
  onTogglePanels?: () => void
  fullScreen?: boolean
  /** show the find bar with this text (a note opened from search results; `n` changes on every open) */
  initialFind?: { query: string; n: number }
}

export function NoteEditor({ noteId, doc, folderId, onOpenNote, onBack, onTogglePanels, fullScreen, initialFind }: Props) {
  const undoManager = useMemo(() => createUndoManager(doc), [doc])
  useEffect(() => () => undoManager.destroy(), [undoManager])
  const ctx = useMemo(() => ({ doc, noteId }), [doc, noteId])

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false, // the shared Yjs undo manager handles history
          link: { openOnClick: false, autolink: true },
        }),
        Collaboration.configure({ document: doc, field: CONTENT_FIELD, yUndoOptions: { undoManager } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        DrawingNode,
        ImageNode,
        FindInNote.configure({
          // drawings, pictures and recordings are found by their recognised text
          transcriptOf: (node) => {
            const t = getTranscripts(doc)
            if (node.type.name === 'drawing') return t.get(node.attrs.drawingId) ?? null
            if (node.attrs.attachmentId) return t.get(`att:${node.attrs.attachmentId}`) ?? null
            return null
          },
        }),
        AudioNode,
        FileNode,
      ],
      editorProps: {
        attributes: { class: 'note-content', spellcheck: 'true' },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? [])
          if (!files.length) return false
          event.preventDefault()
          void insertFiles(editorRef.current!, files)
          return true
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? [])
          if (moved || !files.length) return false
          event.preventDefault()
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
          void insertFiles(editorRef.current!, files, pos)
          return true
        },
      },
    },
    [doc],
  )
  const editorRef = useRef<TiptapEditor | null>(null)
  editorRef.current = editor
  useInputDebugLog(editor)

  // Find in note: ⌘F / Ctrl+F, the ⋯ menu, or opened from search results
  const [find, setFind] = useState<{ text: string; n: number; focus: boolean } | null>(null)
  useEffect(() => {
    // from search results: show the matches, but don't pop up the keyboard
    if (initialFind?.query.trim()) setFind((f) => ({ text: initialFind.query, n: (f?.n ?? 0) + 1, focus: false }))
  }, [initialFind?.n, initialFind?.query])
  const openFind = () => {
    const sel = editor && !editor.state.selection.empty ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ').slice(0, 100) : ''
    // a new key so the bar refocuses (and takes the selection) even if it's open
    setFind((f) => ({ text: sel || f?.text || '', n: (f?.n ?? 0) + 1, focus: true }))
  }
  const openFindRef = useRef(openFind)
  openFindRef.current = openFind
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFindRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Leave drawing mode when switching notes.
  useEffect(() => () => inkUi.set({ activeDrawing: null, palette: null }), [noteId])

  // New, empty note: put the cursor in it.
  useEffect(() => {
    if (editor && editor.isEmpty) editor.commands.focus('start')
  }, [editor])

  /**
   * "Pencil draws anywhere": when the Apple Pencil touches typed text, start a
   * drawing right there instead of moving the cursor (unless the user prefers
   * iPadOS Scribble, which turns handwriting into typed text).
   */
  const onPointerDownCapture = (e: React.PointerEvent) => {
    // Touching the text (not a drawing) ends drawing mode, which also lets
    // iPadOS Scribble work there again.
    if (inkUi.get().activeDrawing && (e.target as HTMLElement).closest('.ProseMirror') && !(e.target as HTMLElement).closest('.drawing-block, .image-block.marking-up'))
      inkUi.set({ activeDrawing: null, palette: null })
    if (e.pointerType !== 'pen' || !editor) return
    if (!inkUi.get().pencilSeen) inkUi.set({ pencilSeen: true })
    const target = e.target as HTMLElement
    // Only start a drawing when the Pencil touches text – never when it taps a
    // control, a picture or an existing drawing.
    if (
      target.closest('.drawing-block, .image-block, .audio-block, .file-block, button, a, input, select, textarea, label') ||
      settings.get().pencilInText !== 'draw'
    )
      return
    e.preventDefault()
    e.stopPropagation()
    const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
    let pos = editor.state.doc.content.size
    if (hit) {
      const $pos = editor.state.doc.resolve(hit.pos)
      pos = $pos.depth > 0 ? $pos.after(1) : hit.pos
    }
    editor.chain().insertContentAt(pos, { type: 'drawing', attrs: { drawingId: newId() } }).run()
    const node = editor.state.doc.nodeAt(pos)
    if (node?.type.name === 'drawing') inkUi.set({ activeDrawing: node.attrs.drawingId })
  }

  const isEmpty = useEditorState({ editor, selector: (s) => s.editor?.isEmpty ?? true })

  if (!editor) return null
  return (
    <NoteContext.Provider value={ctx}>
      <UndoContext.Provider value={undoManager}>
        <div className="editor">
          <EditorToolbar
            editor={editor}
            noteId={noteId}
            folderId={folderId}
            onOpenNote={onOpenNote}
            onBack={onBack}
            onTogglePanels={onTogglePanels}
            fullScreen={fullScreen}
            onFind={openFind}
          />
          {find && <FindBar key={find.n} editor={editor} initial={find.text} focus={find.focus} onClose={() => setFind(null)} />}
          <div className="editor-scroll" onPointerDownCapture={onPointerDownCapture}>
            {/* The blank space below the text is part of the editable area (padding),
                so writing there with Scribble or tapping there behaves like the text. */}
            <EditorContent editor={editor} className={isEmpty ? 'is-empty' : ''} />
          </div>
          <InkToolbar />
          <PencilPalette />
        </div>
      </UndoContext.Provider>
    </NoteContext.Provider>
  )
}
