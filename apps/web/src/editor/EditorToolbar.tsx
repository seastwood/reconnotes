import { useEffect, useRef, useState } from 'react'
import { Popover } from '../components/Popover'
import { useEditorState, type Editor } from '@tiptap/react'
import {
  Bold,
  Camera,
  ChevronLeft,
  Italic,
  ListChecks,
  Loader2,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PanelLeftOpen,
  Paperclip,
  PenLine,
  Pin,
  PinOff,
  Redo2,
  ScanText,
  Sparkles,
  Square,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Undo2,
  ImagePlus,
  Download,
  Search,
  LayoutTemplate,
  ListTodo,
  WandSparkles,
  ScrollText,
  Link2,
  History,
  Printer,
  Table2,
} from 'lucide-react'
import { getNotes, noteDocName, noteToMarkdown, readNote, updateNote } from '@reconnotes/core'
import { useUndoManager, useUndoState } from './undo'
import { insertFiles } from './nodes'
import { addAttachment } from '../lib/attachments'
import { cleanUpSelection, compileNote, convertAllHandwriting, noteAction } from '../lib/ai'
import { sync } from '../lib/sync'
import { workspaceDoc } from '../lib/workspace'
import { newNoteFromTemplate, saveAsTemplate } from '../lib/templates'
import { trashNotes } from '../lib/noteActions'
import { Capacitor } from '@capacitor/core'

const isNativeApp = Capacitor.isNativePlatform()

interface Props {
  editor: Editor
  noteId: string
  folderId: string | null
  onOpenNote: (id: string) => void
  onBack?: () => void
  onTogglePanels?: () => void
  fullScreen?: boolean
  /** open the find bar */
  onFind?: () => void
  /** insert a link to another note */
  onLinkNote?: () => void
  /** show earlier versions of the note */
  onHistory?: () => void
  /** print / share as PDF */
  onPrint?: () => Promise<void>
}

type StyleKey = 'title' | 'heading' | 'subheading' | 'body' | 'mono' | 'bullet' | 'numbered' | 'check' | 'quote'

type Chain = ReturnType<Editor['chain']>
const TABLE_ACTIONS: ('-' | { label: string; run: (c: Chain) => Chain; danger?: boolean; close?: boolean })[] = [
  { label: 'Add row above', run: (c) => c.addRowBefore() },
  { label: 'Add row below', run: (c) => c.addRowAfter() },
  { label: 'Add column left', run: (c) => c.addColumnBefore() },
  { label: 'Add column right', run: (c) => c.addColumnAfter() },
  '-',
  { label: 'Header row on/off', run: (c) => c.toggleHeaderRow() },
  { label: 'Merge or split cells', run: (c) => c.mergeOrSplit() },
  '-',
  { label: 'Delete row', run: (c) => c.deleteRow(), danger: true },
  { label: 'Delete column', run: (c) => c.deleteColumn(), danger: true },
  { label: 'Delete table', run: (c) => c.deleteTable(), danger: true, close: true },
]

export const STYLES: { key: StyleKey; label: string; className: string }[] = [
  { key: 'title', label: 'Title', className: 'st-title' },
  { key: 'heading', label: 'Heading', className: 'st-heading' },
  { key: 'subheading', label: 'Subheading', className: 'st-subheading' },
  { key: 'body', label: 'Body', className: 'st-body' },
  { key: 'mono', label: 'Monospaced', className: 'st-mono' },
  { key: 'bullet', label: '•  Bulleted list', className: 'st-body' },
  { key: 'numbered', label: '1. Numbered list', className: 'st-body' },
  { key: 'check', label: '◯  Checklist', className: 'st-body' },
  { key: 'quote', label: '▍ Block quote', className: 'st-body' },
]

export function applyStyle(editor: Editor, key: StyleKey) {
  const c = editor.chain().focus()
  switch (key) {
    case 'title':
      return c.setHeading({ level: 1 }).run()
    case 'heading':
      return c.setHeading({ level: 2 }).run()
    case 'subheading':
      return c.setHeading({ level: 3 }).run()
    case 'body':
      return c.setParagraph().run()
    case 'mono':
      return c.toggleCodeBlock().run()
    case 'bullet':
      return c.toggleBulletList().run()
    case 'numbered':
      return c.toggleOrderedList().run()
    case 'check':
      return c.toggleTaskList().run()
    case 'quote':
      return c.toggleBlockquote().run()
  }
}

export function EditorToolbar({ editor, noteId, folderId, onOpenNote, onBack, onTogglePanels, fullScreen, onFind, onLinkNote, onHistory, onPrint }: Props) {
  const um = useUndoManager()
  const { canUndo, canRedo } = useUndoState(um)
  const [menu, setMenu] = useState<'style' | 'more' | 'table' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const styleBtn = useRef<HTMLButtonElement>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const tableBtn = useRef<HTMLButtonElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      check: e.isActive('taskList'),
      table: e.isActive('table'),
      style: e.isActive('heading', { level: 1 })
        ? 'Title'
        : e.isActive('heading', { level: 2 })
          ? 'Heading'
          : e.isActive('heading', { level: 3 })
            ? 'Subheading'
            : e.isActive('codeBlock')
              ? 'Monospaced'
              : 'Body',
    }),
  })

  const meta = getNotes(workspaceDoc).get(noteId)
  const pinned = meta ? readNote(meta).pinned : false
  const isTemplate = meta ? readNote(meta).template : false

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length) void insertFiles(editor, files)
  }

  const exportMarkdown = async () => {
    const { handle, close } = sync.open(noteDocName(noteId))
    await handle.loaded
    const md = noteToMarkdown(handle.doc)
    close()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    a.download = `${(meta?.get('title') as string) || 'note'}.md`
    a.click()
  }

  return (
    <div className="editor-toolbar" onPointerDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
      {onTogglePanels && (
        <button
          className="tb"
          onClick={onTogglePanels}
          aria-label={fullScreen ? 'Show notes' : 'Hide panels'}
          title={fullScreen ? 'Show folders and notes' : 'Hide folders / full screen'}
        >
          {fullScreen ? <PanelLeftOpen size={20} /> : <PanelLeft size={20} />}
        </button>
      )}
      {onBack && (
        <button className="tb back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={22} />
        </button>
      )}
      {/* the middle buttons scroll sideways when space is short; navigation
          (left) and AI + ⋯ (right) always stay in view */}
      <div className="tb-scroll">
      <button className="tb undo" onClick={() => um?.undo()} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)">
        <Undo2 size={20} />
      </button>
      <button className="tb hide-xs" onClick={() => um?.redo()} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)">
        <Redo2 size={20} />
      </button>
      <span className="sep" />

      <button
        ref={styleBtn}
        className={`tb${menu === 'style' ? ' on' : ''}`}
        onClick={() => setMenu(menu === 'style' ? null : 'style')}
        title="Text style"
      >
        <Type size={20} />
        <span className="tb-label">{state.style}</span>
      </button>
      {menu === 'style' && (
        <Popover anchorRef={styleBtn} onClose={() => setMenu(null)} keepFocus>
          {STYLES.map((s) => (
            <button key={s.key} className={s.className} onClick={() => applyStyle(editor, s.key)}>
              {s.label}
            </button>
          ))}
        </Popover>
      )}
      <button className={`tb${state.bold ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold">
        <Bold size={18} />
      </button>
      <button className={`tb hide-xs${state.italic ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic">
        <Italic size={18} />
      </button>
      <button className={`tb hide-sm${state.underline ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleUnderline().run()} aria-label="Underline">
        <Underline size={18} />
      </button>
      <button className={`tb hide-sm${state.strike ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label="Strikethrough">
        <Strikethrough size={18} />
      </button>
      <button className={`tb${state.check ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleTaskList().run()} aria-label="Checklist" title="Checklist (or type [ ] )">
        <ListChecks size={20} />
      </button>
      <button
        ref={tableBtn}
        className={`tb hide-xs${state.table || menu === 'table' ? ' on' : ''}`}
        onClick={() => {
          if (!state.table) {
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            return
          }
          setMenu(menu === 'table' ? null : 'table')
        }}
        aria-label={state.table ? 'Table options' : 'Insert table'}
        title={state.table ? 'Rows, columns and table options' : 'Insert table'}
      >
        <Table2 size={19} />
      </button>
      {menu === 'table' && (
        <Popover anchorRef={tableBtn} onClose={() => setMenu(null)} keepFocus>
          {TABLE_ACTIONS.map((a, i) =>
            a === '-' ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={a.label}
                className={a.danger ? 'danger' : undefined}
                onClick={() => {
                  a.run(editor.chain().focus()).run()
                  if (a.close) setMenu(null)
                }}
              >
                {a.label}
              </button>
            ),
          )}
        </Popover>
      )}
      <span className="sep" />

      <button className="tb" onClick={() => editor.chain().focus().insertDrawing().run()} aria-label="Add drawing" title="Add drawing">
        <PenLine size={20} />
      </button>
      <button className="tb" onClick={() => photoRef.current?.click()} aria-label="Add photo" title="Add photo or screenshot (or paste)">
        <ImagePlus size={20} />
      </button>
      <button className="tb hide-sm" onClick={() => cameraRef.current?.click()} aria-label="Take photo" title="Take photo / scan">
        <Camera size={20} />
      </button>
      <AudioRecorder editor={editor} onError={setError} />
      <button className="tb" onClick={() => fileRef.current?.click()} aria-label="Attach file" title="Attach file">
        <Paperclip size={20} />
      </button>
      <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFiles} />
      <input ref={fileRef} type="file" multiple hidden onChange={onFiles} />
      </div>

      {busy && <Loader2 size={18} className="spin" aria-label={busy} />}
      <button
        className="tb"
        title="Compile into a clean document with AI (handwriting + typing)"
        aria-label="Compile with AI"
        disabled={Boolean(busy)}
        onClick={() => run('Compiling…', async () => onOpenNote(await compileNote(editor, noteId, folderId)))}
      >
        <Sparkles size={20} />
      </button>
      <button ref={moreBtn} className={`tb${menu === 'more' ? ' on' : ''}`} onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-label="More">
        <MoreHorizontal size={20} />
      </button>
      {menu === 'more' && (
        <Popover anchorRef={moreBtn} align="right" onClose={() => setMenu(null)}>
            <div className="menu-label">AI</div>
            <button onClick={() => (setMenu(null), void run('Summarising…', () => noteAction(editor, noteId, 'summary')))}>
              <ScrollText size={16} /> Summarise note
            </button>
            <button onClick={() => (setMenu(null), void run('Finding to-dos…', () => noteAction(editor, noteId, 'todos')))}>
              <ListTodo size={16} /> Extract to-dos
            </button>
            <button onClick={() => (setMenu(null), void run('Cleaning up…', () => cleanUpSelection(editor)))} title="Fix spelling, grammar and clarity of the selected text">
              <WandSparkles size={16} /> Clean up wording{editor.state.selection.empty ? ' (select text first)' : ''}
            </button>
            <div className="menu-sep" />
            {onLinkNote && (
              <button
                onClick={() => {
                  setMenu(null)
                  onLinkNote()
                }}
              >
                <Link2 size={16} /> Link to note… <span className="menu-shortcut">[[</span>
              </button>
            )}
            {onFind && (
              <button
                onClick={() => {
                  setMenu(null)
                  onFind()
                }}
              >
                <Search size={16} /> Find in note <span className="menu-shortcut">⌘F</span>
              </button>
            )}
            {isTemplate ? (
              <>
                <button onClick={() => run('Creating note…', async () => onOpenNote(await newNoteFromTemplate(noteId, null)))}>
                  <LayoutTemplate size={16} /> New note from this template
                </button>
                <button onClick={() => updateNote(workspaceDoc, noteId, { template: false })}>
                  <LayoutTemplate size={16} /> Turn into a normal note
                </button>
              </>
            ) : (
              <button onClick={() => run('Saving template…', async () => void (await saveAsTemplate(noteId)))}>
                <LayoutTemplate size={16} /> Save as template
              </button>
            )}
            <button onClick={() => updateNote(workspaceDoc, noteId, { pinned: !pinned })}>
              {pinned ? <PinOff size={16} /> : <Pin size={16} />} {pinned ? 'Unpin' : 'Pin to top'}
            </button>
            <button
              onClick={() =>
                run('Converting handwriting…', async () => {
                  const { converted, errors } = await convertAllHandwriting(editor, noteId)
                  if (!converted && !errors.length) throw new Error('This note has no handwriting to convert.')
                  if (errors.length) throw new Error(`Converted ${converted} drawing(s); ${errors.length} failed: ${errors[0]}`)
                })
              }
            >
              <ScanText size={16} /> Convert all handwriting to text
            </button>
            {onHistory && (
              <button
                onClick={() => {
                  setMenu(null)
                  onHistory()
                }}
              >
                <History size={16} /> Version history…
              </button>
            )}
            {onPrint && (
              <button
                onClick={() => {
                  setMenu(null)
                  void run('Preparing PDF…', onPrint)
                }}
              >
                <Printer size={16} /> {isNativeApp ? 'Share as PDF…' : 'Print / Save as PDF…'}
              </button>
            )}
            <button onClick={exportMarkdown}>
              <Download size={16} /> Export Markdown
            </button>
            <button className="danger" onClick={() => trashNotes([noteId])}>
              <Trash2 size={16} /> Move to Trash
            </button>
        </Popover>
      )}
      {error && (
        <div className="toolbar-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  )
}

function AudioRecorder({ editor, onError }: { editor: Editor; onError: (msg: string) => void }) {
  const pickRef = useRef<HTMLInputElement>(null)
  const [rec, setRec] = useState<MediaRecorder | null>(null)
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [rec])

  const start = async () => {
    // Browsers only allow the microphone on secure (https) pages; on a plain
    // http address navigator.mediaDevices doesn't exist at all.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError(
        window.isSecureContext
          ? 'This browser can’t record audio. Pick an existing recording instead.'
          : `Recording needs a secure (https) connection, and this page is ${location.protocol}//${location.host}. ` +
              'Set up HTTPS for your server (see “Reaching the server from your phone” in the README) or use the iOS app. ' +
              'For now you can attach a recording, e.g. from Voice Memos.',
      )
      pickRef.current?.click()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks: Blob[] = []
      r.ondataavailable = (e) => chunks.push(e.data)
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const type = r.mimeType.split(';')[0] || 'audio/webm'
        const blob = new Blob(chunks, { type })
        const name = `Recording ${new Date().toLocaleString()}`
        const attachmentId = await addAttachment(blob, `${name}.${type.includes('mp4') ? 'm4a' : 'webm'}`)
        editor.chain().focus().insertContent([{ type: 'audio', attrs: { attachmentId, name } }, { type: 'paragraph' }]).run()
      }
      r.start()
      setSecs(0)
      setRec(r)
    } catch (e) {
      const err = e as Error
      onError(
        err.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your browser or iOS settings to record audio.'
          : `Microphone unavailable: ${err.message}`,
      )
    }
  }

  const picker = (
    <input
      ref={pickRef}
      type="file"
      accept="audio/*"
      hidden
      onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        if (files.length) void insertFiles(editor, files)
      }}
    />
  )

  if (rec)
    return (
      <button
        className="tb recording"
        onClick={() => {
          rec.stop()
          setRec(null)
        }}
        aria-label="Stop recording"
      >
        <Square size={16} /> {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      </button>
    )
  return (
    <>
      <button className="tb" onClick={start} aria-label="Record audio" title="Record audio">
        <Mic size={20} />
      </button>
      {picker}
    </>
  )
}
