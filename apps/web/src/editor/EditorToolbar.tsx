import { errorText } from '../lib/jobs'
import { canIndentAt, indentAt } from './indent'
import { useEffect, useRef, useState } from 'react'
import { Popover } from '../components/Popover'
import { useEditorState, type Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  BookOpen,
  Bold,
  Camera,
  ChevronDown,
  Copy,
  RefreshCw,
  ChevronLeft,
  IndentDecrease,
  IndentIncrease,
  List,
  ListOrdered,
  Users,
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
  MessageCircleQuestion,
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
  Globe,
  ScanLine,
} from 'lucide-react'
import { getNotes, noteDocName, noteToMarkdown, readNote, updateNote } from '@reconnotes/core'
import { useUndoManager, useUndoState } from './undo'
import { insertFiles } from './nodes'
import { saveBlob } from '../lib/files'
import { checkForUpdates } from '../lib/webImport'
import { RecordingError, setRecordingTarget, startRecording, stopRecording, useRecorderSaving, useRecording } from '../lib/recorder'
import { cleanUpSelection, compileNote, convertAllHandwriting, noteAction } from '../lib/ai'
import { sync } from '../lib/sync'
import { workspaceDoc } from '../lib/workspace'
import { duplicateNote, newNoteFromTemplate, saveAsTemplate } from '../lib/templates'
import { trashNotes } from '../lib/noteActions'
import { scanIntoNote, scannerAvailable } from '../lib/scanner'
import { meetingStart } from '../lib/meeting'
import { useStore } from '../lib/store'
import { takeQuickAction } from '../lib/appLinks'
import { openAskChat } from '../lib/askChat'
import { openRefs, useRefs } from '../lib/refs'
import { Capacitor } from '@capacitor/core'

const isNativeApp = Capacitor.isNativePlatform()

interface Props {
  editor: Editor
  noteId: string
  folderId: string | null
  onOpenNote: (id: string, find?: string) => void
  onBack?: () => void
  onTogglePanels?: () => void
  fullScreen?: boolean
  /** open the find bar */
  onFind?: () => void
  /** insert a link to another note */
  onLinkNote?: () => void
  /** show earlier versions of the note */
  onHistory?: () => void
  /** share a read-only link */
  onShareLink?: () => void
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

const LISTS: { key: 'bullet' | 'numbered' | 'check'; label: string; icon: typeof List }[] = [
  { key: 'bullet', label: 'Bulleted list', icon: List },
  { key: 'numbered', label: 'Numbered list', icon: ListOrdered },
  { key: 'check', label: 'Checklist', icon: ListChecks },
]

/** Indent (1) or outdent (-1) what's at the cursor: a list item nests; other text moves a step. */
export function indent(editor: Editor, dir: 1 | -1) {
  return indentAt(editor, dir)
}

const LIST_TYPES = { bullet: 'bulletList', numbered: 'orderedList', check: 'taskList' } as const

/**
 * In a list of another kind (bullets → checklist…): the whole list changes,
 * not just the item the cursor is in.
 */
function convertWholeList(editor: Editor, key: keyof typeof LIST_TYPES): boolean {
  const { state } = editor
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const list = $from.node(d)
    const name = list.type.name
    if (!Object.values(LIST_TYPES).includes(name as never)) continue
    if (name === LIST_TYPES[key]) return false
    // the same items, as the other kind (each keeps its text and anything inside it)
    const itemType = key === 'check' ? state.schema.nodes.taskItem : state.schema.nodes.listItem
    const items: PMNode[] = []
    list.forEach((item) => items.push(itemType.create(key === 'check' ? { checked: false } : null, item.content)))
    const pos = $from.before(d)
    const tr = state.tr.replaceWith(pos, pos + list.nodeSize, state.schema.nodes[LIST_TYPES[key]].create(null, items))
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(state.selection.head, tr.doc.content.size))))
    editor.view.dispatch(tr)
    editor.commands.focus()
    return true
  }
  return false
}

export function applyStyle(editor: Editor, key: StyleKey) {
  if ((key === 'bullet' || key === 'numbered' || key === 'check') && convertWholeList(editor, key)) return true
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

export function EditorToolbar({ editor, noteId, folderId, onOpenNote, onBack, onTogglePanels, fullScreen, onFind, onLinkNote, onHistory, onShareLink, onPrint }: Props) {
  const um = useUndoManager()
  const { canUndo, canRedo } = useUndoState(um)
  const [menu, setMenu] = useState<'style' | 'more' | 'table' | 'lists' | 'format' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const styleBtn = useRef<HTMLButtonElement>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const tableBtn = useRef<HTMLButtonElement>(null)
  const listsBtn = useRef<HTMLButtonElement>(null)
  const formatBtn = useRef<HTMLButtonElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      list: e.isActive('taskList') ? 'check' : e.isActive('orderedList') ? 'numbered' : e.isActive('bulletList') ? 'bullet' : null,
      canIndent: canIndentAt(e, 1),
      canOutdent: canIndentAt(e, -1),
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
  const refCount = useRefs(noteId).length
  const isTemplate = meta ? readNote(meta).template : false
  /** the web page it was imported from */
  const saved = meta ? readNote(meta).source : null
  // imported before the address was kept with the note: its "From … · imported …" line has it
  const fromLine = (): string | null => {
    let href: string | null = null
    let i = 0
    editor.state.doc.forEach((node) => {
      if (href || i++ > 8 || !/^From\b.*·\s*imported\s+\d{4}-\d\d-\d\d/.test(node.textContent.trim())) return
      node.descendants((n) => {
        const link = n.marks.find((mk) => mk.type.name === 'link')
        if (!href && link?.attrs.href) href = String(link.attrs.href)
      })
    })
    return href
  }
  const source = saved ?? (menu === 'more' ? fromLine() : null)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length) void insertFiles(editor, files)
  }

  /** the note as a Markdown file: the share sheet in the iOS app (Save to Files, AirDrop…), a download on the web */
  const exportMarkdown = async () => {
    const { handle, close } = sync.open(noteDocName(noteId))
    try {
      await handle.loaded
      const md = noteToMarkdown(handle.doc)
      const name = (((meta?.get('title') as string) || 'Note').split('\n')[0].replace(/[\\/:*?"<>|#]+/g, ' ').trim().slice(0, 80) || 'Note') + '.md'
      await saveBlob(new Blob([md], { type: 'text/markdown' }), name)
    } finally {
      close()
    }
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
      {/* narrow: what doesn't fit is a tap away, in one panel */}
      <button
        ref={formatBtn}
        className={`tb show-sm${menu === 'format' ? ' on' : ''}`}
        onClick={() => setMenu(menu === 'format' ? null : 'format')}
        aria-label="More formatting"
        title="More formatting"
      >
        <ChevronDown size={18} />
      </button>
      {menu === 'format' && (
        <Popover anchorRef={formatBtn} onClose={() => setMenu(null)} keepFocus>
          <div className="format-panel">
            {[
              { label: 'Italic', icon: Italic, on: state.italic, run: () => editor.chain().focus().toggleItalic().run() },
              { label: 'Underline', icon: Underline, on: state.underline, run: () => editor.chain().focus().toggleUnderline().run() },
              { label: 'Strike', icon: Strikethrough, on: state.strike, run: () => editor.chain().focus().toggleStrike().run() },
              { label: 'Bulleted', icon: List, on: state.list === 'bullet', run: () => applyStyle(editor, 'bullet') },
              { label: 'Numbered', icon: ListOrdered, on: state.list === 'numbered', run: () => applyStyle(editor, 'numbered') },
              { label: 'Checklist', icon: ListChecks, on: state.list === 'check', run: () => applyStyle(editor, 'check') },
              { label: 'Outdent', icon: IndentDecrease, disabled: !state.canOutdent, run: () => indent(editor, -1) },
              { label: 'Indent', icon: IndentIncrease, disabled: !state.canIndent, run: () => indent(editor, 1) },
              { label: state.table ? 'Table…' : 'Table', icon: Table2, on: state.table, run: () => (state.table ? setTimeout(() => setMenu('table')) : editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()) },
              { label: 'Redo', icon: Redo2, disabled: !canRedo, run: () => um?.redo() },
              { label: 'Camera', icon: Camera, run: () => cameraRef.current?.click() },
            ].map((b) => (
              <button
                key={b.label}
                className={b.on ? 'on' : ''}
                disabled={b.disabled}
                onClick={() => {
                  setMenu(null)
                  b.run()
                }}
              >
                <b.icon size={18} />
                <span>{b.label}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
      <button
        ref={listsBtn}
        className={`tb${state.list || menu === 'lists' ? ' on' : ''}`}
        onClick={() => setMenu(menu === 'lists' ? null : 'lists')}
        aria-label="Lists and indent"
        title="Bulleted, numbered and check lists; indent"
      >
        {state.list === 'bullet' ? <List size={20} /> : state.list === 'numbered' ? <ListOrdered size={20} /> : <ListChecks size={20} />}
      </button>
      {menu === 'lists' && (
        <Popover anchorRef={listsBtn} onClose={() => setMenu(null)} keepFocus>
          {LISTS.map((l) => (
            <button key={l.key} className={state.list === l.key ? 'checked' : ''} onClick={() => (applyStyle(editor, l.key), setMenu(null))}>
              <l.icon size={16} /> {l.label}
            </button>
          ))}
          <div className="menu-sep" />
          <button disabled={!state.canIndent} onClick={() => indent(editor, 1)}>
            <IndentIncrease size={16} /> Indent <span className="menu-shortcut">Tab</span>
          </button>
          <button disabled={!state.canOutdent} onClick={() => indent(editor, -1)}>
            <IndentDecrease size={16} /> Outdent <span className="menu-shortcut">⇧Tab</span>
          </button>
        </Popover>
      )}
      {/* in a list: indent / outdent right here (always in the lists menu too) */}
      {state.list && (
        <>
          <button className="tb hide-xs" disabled={!state.canOutdent} onClick={() => indent(editor, -1)} aria-label="Outdent" title="Outdent (⇧Tab)">
            <IndentDecrease size={19} />
          </button>
          <button className="tb hide-xs" disabled={!state.canIndent} onClick={() => indent(editor, 1)} aria-label="Indent" title="Indent (Tab)">
            <IndentIncrease size={19} />
          </button>
        </>
      )}
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
        <Popover anchorRef={tableBtn.current?.offsetParent ? tableBtn : formatBtn} onClose={() => setMenu(null)} keepFocus>
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
      {scannerAvailable() && (
        <button
          className="tb"
          onClick={() => run('Scanning…', () => scanIntoNote(editor, noteId))}
          aria-label="Scan document"
          title="Scan a document (pages are found, cropped and straightened)"
        >
          <ScanLine size={20} />
        </button>
      )}
      <button className="tb hide-sm" onClick={() => cameraRef.current?.click()} aria-label="Take photo" title="Take photo">
        <Camera size={20} />
      </button>
      <AudioRecorder editor={editor} noteId={noteId} onError={setError} />
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
        title="Chat with AI about this note"
        aria-label="Ask about this note"
        onClick={() => openAskChat({ noteId, title: (meta?.get('title') as string) ?? '' })}
      >
        <MessageCircleQuestion size={20} />
      </button>
      <button ref={moreBtn} className={`tb${menu === 'more' ? ' on' : ''}`} onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-label="More">
        <MoreHorizontal size={20} />
      </button>
      {menu === 'more' && (
        <Popover anchorRef={moreBtn} align="right" onClose={() => setMenu(null)}>
            <div className="menu-label">AI</div>
            <button
              disabled={Boolean(busy)}
              title="Compile into a clean document with AI (handwriting + typing)"
              onClick={() => (setMenu(null), void run('Compiling…', async () => onOpenNote(await compileNote(editor, noteId))))}
            >
              <Sparkles size={16} /> Compile into a clean document
            </button>
            <button onClick={() => (setMenu(null), void run('Summarising…', () => noteAction(editor, noteId, 'summary')))}>
              <ScrollText size={16} /> Summarise note
            </button>
            <button onClick={() => (setMenu(null), void run('Finding to-dos…', () => noteAction(editor, noteId, 'todos')))}>
              <ListTodo size={16} /> Extract to-dos
            </button>
            <button onClick={() => (setMenu(null), void run('Cleaning up…', () => cleanUpSelection(editor, noteId)))} title="Fix spelling, grammar and clarity of the selected text">
              <WandSparkles size={16} /> Clean up wording{editor.state.selection.empty ? ' (select text first)' : ''}
            </button>
            <button onClick={() => (setMenu(null), openRefs(noteId))} title="The notes Ask reads with this one (the documents it refers to) – add, import, remove">
              <BookOpen size={16} /> References…{refCount > 0 && <span className="menu-shortcut">{refCount}</span>}
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
            {source && (
              <button onClick={() => (setMenu(null), void checkForUpdates({ noteId }))} title={`Fetch ${source} again and bring this note up to date if the page changed`}>
                <RefreshCw size={16} /> Check page for updates
              </button>
            )}
            <button onClick={() => (setMenu(null), void run('Duplicating…', async () => onOpenNote(await duplicateNote(noteId))))}>
              <Copy size={16} /> Duplicate note
            </button>
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
            {onShareLink && (
              <button
                onClick={() => {
                  setMenu(null)
                  onShareLink()
                }}
              >
                <Globe size={16} /> Share a read-only link…
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
            <button onClick={() => (setMenu(null), void run('Exporting…', exportMarkdown))}>
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

function AudioRecorder({ editor, noteId, onError }: { editor: Editor; noteId: string; onError: (msg: string) => void }) {
  const pickRef = useRef<HTMLInputElement>(null)
  const active = useRecording()
  const saving = useRecorderSaving()
  const mine = active?.noteId === noteId
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  // a recording started in this note goes in at the cursor while the note is open
  useEffect(() => {
    setRecordingTarget(noteId, (attrs) => editor.chain().focus().insertContent([{ type: 'audio', attrs }, { type: 'paragraph' }]).run())
    return () => setRecordingTarget(noteId, null)
  }, [editor, noteId])

  const micBtn = useRef<HTMLButtonElement>(null)
  const [choosing, setChoosing] = useState(false)
  const start = async (opts: { meeting?: boolean } = {}) => {
    if (active) return onError('Another recording is running – stop it first.')
    try {
      await startRecording(noteId, opts)
    } catch (e) {
      const err = e as RecordingError
      if (err.code === 'insecure')
        onError(
          `Recording needs a secure (https) connection, and this page is ${location.protocol}//${location.host}. ` +
            'Set up HTTPS for your server (see “Reaching the server from your phone” in the README) or use the iOS app. ' +
            'For now you can attach a recording, e.g. from Voice Memos.',
        )
      else if (err.code === 'unsupported') onError('This browser can’t record audio. Pick an existing recording instead.')
      else if (err.code === 'denied') onError('Microphone access was denied. Allow it in your browser or iOS settings to record audio.')
      else onError(err.message)
      if (err.code === 'insecure' || err.code === 'unsupported') pickRef.current?.click()
    }
  }

  // opened by "Record" in the widget / Siri: start straight away
  const startRef = useRef(start)
  startRef.current = start
  // (once this has stayed on screen a moment: a new note's editor can be
  // set up twice while it loads, and the first one mustn't take the mic)
  useEffect(() => {
    const t = setTimeout(() => {
      if (takeQuickAction(noteId, 'record')) void startRef.current()
      else if (takeQuickAction(noteId, 'meeting')) void startRef.current({ meeting: true })
    }, 400)
    return () => clearTimeout(t)
  }, [noteId])
  // a new meeting's setup said Start
  const meetingNow = useStore(meetingStart, (m) => m.noteId === noteId)
  useEffect(() => {
    if (!meetingNow) return
    meetingStart.set({ noteId: null })
    void startRef.current({ meeting: true })
  }, [meetingNow])

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

  if (mine) {
    const secs = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000))
    return (
      <button className="tb recording" onClick={() => void stopRecording()} aria-label={active.meeting ? 'Stop the meeting recording' : 'Stop recording'}>
        <Square size={16} /> {active.meeting && <Users size={14} />} {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      </button>
    )
  }
  if (saving)
    return (
      <button className="tb" disabled aria-label="Saving the recording">
        <Loader2 size={18} className="spin" />
      </button>
    )
  return (
    <>
      <button ref={micBtn} className={`tb${choosing ? ' on' : ''}`} onClick={() => setChoosing(!choosing)} aria-label="Record" title="Record audio or a meeting">
        <Mic size={20} />
      </button>
      {choosing && (
        <Popover anchorRef={micBtn} onClose={() => setChoosing(false)}>
          <button onClick={() => (setChoosing(false), void start())}>
            <Mic size={16} /> Record audio
          </button>
          <button onClick={() => (setChoosing(false), void start({ meeting: true }))}>
            <Users size={16} />
            <span>
              Record a meeting
              <span className="menu-sub">When you stop: the transcript, a summary, decisions and action items</span>
            </span>
          </button>
          <div className="menu-sep" />
          <button onClick={() => (setChoosing(false), pickRef.current?.click())}>
            <Paperclip size={16} /> Add a recording from a file…
          </button>
        </Popover>
      )}
      {picker}
    </>
  )
}
