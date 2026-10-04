import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Placeholder } from '@tiptap/extension-placeholder'
import type * as Y from 'yjs'
import { CONTENT_FIELD, newId } from '@reconnotes/core'
import { DrawingNode, NoteContext } from '../drawing/DrawingNode'
import { InkToolbar } from '../drawing/InkToolbar'
import { PencilPalette } from '../drawing/PencilPalette'
import { inkUi } from '../drawing/toolState'
import { AudioNode, FileNode, ImageNode, insertFiles } from './nodes'
import { UndoContext, createUndoManager } from './undo'
import { EditorToolbar } from './EditorToolbar'
import { settings } from '../lib/settings'

interface Props {
  noteId: string
  doc: Y.Doc
  folderId: string | null
  onOpenNote: (id: string) => void
  onBack?: () => void
}

export function NoteEditor({ noteId, doc, folderId, onOpenNote, onBack }: Props) {
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
        Placeholder.configure({ placeholder: 'Start typing, or draw with Apple Pencil…' }),
        DrawingNode,
        ImageNode,
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
    if (e.pointerType !== 'pen' || !editor) return
    inkUi.set({ pencilSeen: true })
    const target = e.target as HTMLElement
    if (target.closest('.drawing-block') || settings.get().pencilInText !== 'draw') return
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
          <EditorToolbar editor={editor} noteId={noteId} folderId={folderId} onOpenNote={onOpenNote} onBack={onBack} />
          <div className="editor-scroll" onPointerDownCapture={onPointerDownCapture}>
            <EditorContent editor={editor} className={isEmpty ? 'is-empty' : ''} />
            <div className="editor-tail" onClick={() => editor.commands.focus('end')} />
          </div>
          <InkToolbar />
          <PencilPalette />
        </div>
      </UndoContext.Provider>
    </NoteContext.Provider>
  )
}
