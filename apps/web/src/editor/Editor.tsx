import { errorText, warmUpAi } from '../lib/jobs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { JobTag } from './jobTag'
import { Uncertain } from './uncertain'
import { ChecklistClipboard } from './checklistCopy'
import { ItemCopyButton } from './ItemCopyButton'
import { BlockClipboard } from './blockClipboard'
import type * as Y from 'yjs'
import { CONTENT_FIELD, getTranscripts, newId } from '@reconnotes/core'
import { DrawingNode, NoteContext } from '../drawing/DrawingNode'
import { InkToolbar } from '../drawing/InkToolbar'
import { PencilPalette } from '../drawing/PencilPalette'
import { inkUi } from '../drawing/toolState'
import { AudioNode, FileNode, ImageNode, insertFiles } from './nodes'
import { VideoNode } from './video'
import { UndoContext, createUndoManager } from './undo'
import { EditorToolbar, STYLES, applyStyle } from './EditorToolbar'
import { registerCommands } from '../lib/commands'
import { compileNote, convertAllHandwriting, noteAction } from '../lib/ai'
import { saveAsTemplate } from '../lib/templates'
import { isSyncConfigured, settings } from '../lib/settings'
import { useInputDebugLog } from './debugInput'
import { FindInNote } from './find'
import { FindBar } from './FindBar'
import { Hashtags } from './hashtags'
import { CodeCopy } from './codeCopy'
import { MeetingSetup } from './MeetingSetup'
import { useStore } from '../lib/store'
import { meetingSetup } from '../lib/meeting'
import { ListenButtons } from './listenButtons'
import { LinkOpener } from './linkOpener'
import { LinkPicker, LinkedFrom, NoteLink } from './noteLink'
import { RelatedNotes } from '../components/RelatedNotes'
import { NotePath } from '../components/NotePath'
import type { View } from '../components/Sidebar'
import { DueDate } from './dueDate'
import { VersionHistory } from '../components/VersionHistory'
import { ShareDialog } from '../components/ShareDialog'
import { scanIntoNote, scannerAvailable } from '../lib/scanner'
import { takeQuickAction } from '../lib/appLinks'

import { printNote } from '../lib/printNote'

interface Props {
  noteId: string
  doc: Y.Doc
  folderId: string | null
  onOpenNote: (id: string, find?: string) => void
  /** a tapped link to another note (kept in the back/forward trail) */
  onFollowLink?: (id: string, find?: string) => void
  onBack?: () => void
  /** iPad/desktop: cycle folders / notes / full-screen note */
  onTogglePanels?: () => void
  fullScreen?: boolean
  /** show the notes with this #tag */
  onOpenTag?: (tag: string) => void
  /** show the find bar with this text (a note opened from search results; `n` changes on every open) */
  initialFind?: { query: string; n: number }
  /** show the folder the note is in (its path at the top) */
  onShowFolder?: (view: View) => void
}

export function NoteEditor({ noteId, doc, folderId, onOpenNote, onFollowLink = onOpenNote, onBack, onTogglePanels, fullScreen, initialFind, onOpenTag, onShowFolder }: Props) {
  const undoManager = useMemo(() => createUndoManager(doc), [doc])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const onFollowLinkRef = useRef(onFollowLink)
  onFollowLinkRef.current = onFollowLink
  const onOpenNoteRef = useRef(onOpenNote)
  onOpenNoteRef.current = onOpenNote
  /** the [[ link picker: where it is, and what it replaces */
  const [picker, setPicker] = useState<{ x: number; y: number; top: number; range: { from: number; to: number } | null } | null>(null)
  const editorForPicker = useRef<TiptapEditor | null>(null)
  const openLinkPicker = (range: { from: number; to: number } | null) => {
    const ed = editorForPicker.current
    if (!ed) return
    const pos = range ? range.from : ed.state.selection.from
    const c = ed.view.coordsAtPos(pos)
    setPicker({ x: c.left, y: c.bottom, top: c.top, range })
  }
  /** a tapped #tag: offer to show the notes with it */
  const [tagChip, setTagChip] = useState<{ tag: string; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!tagChip) return
    const hide = () => setTagChip(null)
    const t = setTimeout(hide, 5000)
    window.addEventListener('keydown', hide)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', hide)
    }
  }, [tagChip])
  useEffect(() => () => undoManager.destroy(), [undoManager])
  const ctx = useMemo(() => ({ doc, noteId }), [doc, noteId])

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false, // the shared Yjs undo manager handles history
          // listen:<recording>@<seconds> – a meeting note's ▶ link into its recording
          link: { openOnClick: false, autolink: true, isAllowedUri: (url, ctx) => /^listen:[a-z0-9]+@\d+$/i.test(url) || ctx.defaultValidate(url) },
        }),
        Collaboration.configure({ document: doc, field: CONTENT_FIELD, yUndoOptions: { undoManager } }),
        LinkOpener,
        CodeCopy,
        ListenButtons,
        TaskList,
        TaskItem.configure({ nested: true }),
        JobTag,
        Uncertain,
        ChecklistClipboard.configure({ doc }),
        BlockClipboard.configure({ doc }),
        TableKit.configure({ table: { resizable: true, lastColumnResizable: false, cellMinWidth: 60 } }),
        DrawingNode,
        ImageNode,
        DueDate,
        NoteLink.configure({
          onOpen: (id, find) => onFollowLinkRef.current(id, find),
          onTrigger: (range) => openLinkPicker(range),
        }),
        Hashtags.configure({ onTagClick: (tag, rect) => setTagChip({ tag, x: rect.left, y: rect.bottom }) }),
        FindInNote.configure({
          // drawings, pictures and recordings are found by their recognised text
          transcriptOf: (node) => {
            const t = getTranscripts(doc)
            if (node.type.name === 'drawing') return t.get(node.attrs.drawingId) ?? null
            // a picture: its own text, and any handwriting drawn on it
            const parts = [node.attrs.attachmentId && t.get(`att:${node.attrs.attachmentId}`), node.attrs.drawingId && t.get(node.attrs.drawingId)]
            return parts.filter(Boolean).join('\n') || null
          },
        }),
        AudioNode,
        FileNode,
        VideoNode,
      ],
      editorProps: {
        attributes: { class: 'note-content', spellcheck: 'true' },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? [])
          if (!files.length) return false
          // copied from ReconNotes (a checklist item with its pictures…): the blocks, not just the picture
          if (event.clipboardData?.getData('text/html').includes('data-reconnotes-blocks')) return false
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
  editorForPicker.current = editor
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

  // ⌘K: what can be done to this note
  const folderRef = useRef(folderId)
  folderRef.current = folderId
  useEffect(() => {
    if (!editor) return
    const c = () => editor.chain().focus()
    const S = 'This note'
    return registerCommands('editor', [
      { id: 'find', label: 'Find in note', section: S, shortcut: '⌘F', keywords: 'search replace', run: () => openFindRef.current() },
      { id: 'drawing', label: 'Add drawing', section: S, keywords: 'pen handwriting sketch ink', run: () => c().insertDrawing().run() },
      ...(scannerAvailable() ? [{ id: 'scan', label: 'Scan a document', section: S, keywords: 'camera paper pages', run: () => void scanIntoNote(editor, noteId) }] : []),
      { id: 'table', label: 'Insert table', section: S, keywords: 'grid rows columns', run: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { id: 'checklist', label: 'Checklist', section: S, keywords: 'todo task list', run: () => c().toggleTaskList().run() },
      { id: 'link', label: 'Link to another note', section: S, keywords: '[[ reference', run: () => openLinkPicker(null) },
      ...STYLES.map((st) => ({ id: `style-${st.key}`, label: `Style: ${st.label.replace(/^[^A-Za-z0-9]+/, '')}`, section: S, run: () => applyStyle(editor, st.key) })),
      { id: 'history', label: 'Version history', section: S, keywords: 'restore earlier undo', run: () => setHistoryOpen(true) },
      { id: 'share', label: 'Share a read-only link', section: S, keywords: 'public url send', run: () => setShareOpen(true) },
      { id: 'print', label: 'Print or save as PDF', section: S, keywords: 'share pdf export', run: () => void printNote(editor, doc, noteId) },
      { id: 'convert', label: 'Convert all handwriting to text', section: S, keywords: 'ocr recognise', run: () => void convertAllHandwriting(editor, noteId) },
      { id: 'summary', label: 'Summarise with AI', section: S, keywords: 'summary ai', run: () => void noteAction(editor, noteId, 'summary').catch((e) => errorText(e) && alert(errorText(e))) },
      { id: 'todos', label: 'Extract to-dos with AI', section: S, keywords: 'tasks ai', run: () => void noteAction(editor, noteId, 'todos').catch((e) => errorText(e) && alert(errorText(e))) },
      { id: 'compile', label: 'Compile into a clean document with AI', section: S, keywords: 'ai tidy', run: () => void compileNote(editor, noteId).then((id) => onOpenNoteRef.current(id)).catch((e) => errorText(e) && alert(errorText(e))) },
      { id: 'template', label: 'Save as template', section: S, run: () => void saveAsTemplate(noteId) },
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, noteId, doc])

  // opened by "Scan" in the widget / Siri: scan straight away
  useEffect(() => {
    if (!editor) return
    const t = setTimeout(() => {
      if (takeQuickAction(noteId, 'scan') && scannerAvailable()) void scanIntoNote(editor, noteId)
    }, 400)
    return () => clearTimeout(t)
  }, [editor, noteId])

  // Leave drawing mode when switching notes.
  useEffect(() => () => inkUi.set({ activeDrawing: null, palette: null }), [noteId])
  // a note with handwriting or pictures: have the server load its handwriting model now
  useEffect(() => {
    if (!editor || !isSyncConfigured()) return
    let found = false
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'drawing' || n.type.name === 'image') found = true
      return !found
    })
    if (found) warmUpAi()
  }, [editor, noteId])

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
    // Closed only once the tap is over: closing hides the drawing's footer, and
    // if the page moved under the finger now, a tap on a button below would miss.
    if (inkUi.get().activeDrawing && (e.target as HTMLElement).closest('.ProseMirror') && !(e.target as HTMLElement).closest('.drawing-block, .image-block.marking-up')) {
      const close = () => {
        window.removeEventListener('pointerup', close, true)
        window.removeEventListener('pointercancel', close, true)
        setTimeout(() => inkUi.set({ activeDrawing: null, palette: null }), 0)
      }
      window.addEventListener('pointerup', close, true)
      window.addEventListener('pointercancel', close, true)
    }
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
  // a new meeting: its setup first (who's there, the agenda), then it records
  const settingUp = useStore(meetingSetup, (m) => m.noteId === noteId)

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
            onLinkNote={() => openLinkPicker(null)}
            onHistory={() => setHistoryOpen(true)}
            onShareLink={isSyncConfigured() ? () => setShareOpen(true) : undefined}
            onPrint={() => printNote(editor, doc, noteId)}
          />
          {find && <FindBar key={find.n} editor={editor} initial={find.text} focus={find.focus} onClose={() => setFind(null)} />}
          {onShowFolder && <NotePath noteId={noteId} folderId={folderId} onShow={onShowFolder} />}
          <div className="editor-scroll" onPointerDownCapture={onPointerDownCapture}>
            {settingUp && (
              <MeetingSetup
                noteId={noteId}
                doc={doc}
                title={editor.state.doc.firstChild?.textContent ?? ''}
                onStart={() => setTimeout(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1), 0)}
              />
            )}
            {/* The blank space below the text is part of the editable area (padding),
                so writing there with Scribble or tapping there behaves like the text. */}
            <EditorContent editor={editor} className={isEmpty ? 'is-empty' : ''} />
            <div className="note-footer">
              <LinkedFrom noteId={noteId} onOpen={onFollowLink} />
              <RelatedNotes noteId={noteId} onOpen={onFollowLink} />
            </div>
          </div>
          <ItemCopyButton editor={editor} doc={doc} />
          {tagChip && onOpenTag && (
            <button
              className="tag-chip-action"
              style={{ left: Math.min(tagChip.x, window.innerWidth - 230), top: tagChip.y + 6 }}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                setTagChip(null)
                onOpenTag(tagChip.tag)
              }}
            >
              Show notes tagged #{tagChip.tag}
            </button>
          )}
          {picker && (
            <LinkPicker
              currentNoteId={noteId}
              at={picker}
              onClose={() => {
                setPicker(null)
                editor.commands.focus()
              }}
              onPick={(n) => {
                const range = picker.range ?? { from: editor.state.selection.from, to: editor.state.selection.to }
                setPicker(null)
                editor
                  .chain()
                  .focus()
                  .insertContentAt(range, [{ type: 'noteLink', attrs: { noteId: n.id, title: n.title } }, { type: 'text', text: ' ' }])
                  .run()
              }}
            />
          )}
          {historyOpen && <VersionHistory noteId={noteId} onClose={() => setHistoryOpen(false)} />}
          {shareOpen && <ShareDialog noteId={noteId} onClose={() => setShareOpen(false)} />}
          <InkToolbar />
          <PencilPalette />
        </div>
      </UndoContext.Provider>
    </NoteContext.Provider>
  )
}
