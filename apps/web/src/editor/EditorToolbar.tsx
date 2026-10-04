import { useEffect, useRef, useState } from 'react'
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
  Paperclip,
  PenLine,
  Pin,
  PinOff,
  Redo2,
  Sparkles,
  Square,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Undo2,
  ImagePlus,
  Download,
} from 'lucide-react'
import { getNotes, noteDocName, noteToMarkdown, readNote, updateNote } from '@reconnotes/core'
import { useUndoManager, useUndoState } from './undo'
import { insertFiles } from './nodes'
import { addAttachment } from '../lib/attachments'
import { compileNote } from '../lib/ai'
import { sync } from '../lib/sync'
import { workspaceDoc } from '../lib/workspace'

interface Props {
  editor: Editor
  noteId: string
  folderId: string | null
  onOpenNote: (id: string) => void
  onBack?: () => void
}

type StyleKey = 'title' | 'heading' | 'subheading' | 'body' | 'mono' | 'bullet' | 'numbered' | 'check' | 'quote'

const STYLES: { key: StyleKey; label: string; className: string }[] = [
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

function applyStyle(editor: Editor, key: StyleKey) {
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

export function EditorToolbar({ editor, noteId, folderId, onOpenNote, onBack }: Props) {
  const um = useUndoManager()
  const { canUndo, canRedo } = useUndoState(um)
  const [menu, setMenu] = useState<'style' | 'more' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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
      {onBack && (
        <button className="tb back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={22} />
        </button>
      )}
      <button className="tb undo" onClick={() => um?.undo()} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)">
        <Undo2 size={20} />
      </button>
      <button className="tb" onClick={() => um?.redo()} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)">
        <Redo2 size={20} />
      </button>
      <span className="sep" />

      <div className="menu-anchor">
        <button className={`tb${menu === 'style' ? ' on' : ''}`} onClick={() => setMenu(menu === 'style' ? null : 'style')} title="Text style">
          <Type size={20} />
          <span className="tb-label">{state.style}</span>
        </button>
        {menu === 'style' && (
          <div className="menu" onClick={() => setMenu(null)}>
            {STYLES.map((s) => (
              <button key={s.key} className={s.className} onClick={() => applyStyle(editor, s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className={`tb${state.bold ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold">
        <Bold size={18} />
      </button>
      <button className={`tb${state.italic ? ' on' : ''}`} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic">
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
      <AudioRecorder editor={editor} />
      <button className="tb hide-sm" onClick={() => fileRef.current?.click()} aria-label="Attach file" title="Attach file">
        <Paperclip size={20} />
      </button>
      <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFiles} />
      <input ref={fileRef} type="file" multiple hidden onChange={onFiles} />

      <span className="spacer" />
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
      <div className="menu-anchor">
        <button className="tb" onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-label="More">
          <MoreHorizontal size={20} />
        </button>
        {menu === 'more' && (
          <div className="menu right" onClick={() => setMenu(null)}>
            <button onClick={() => updateNote(workspaceDoc, noteId, { pinned: !pinned })}>
              {pinned ? <PinOff size={16} /> : <Pin size={16} />} {pinned ? 'Unpin' : 'Pin to top'}
            </button>
            <button onClick={exportMarkdown}>
              <Download size={16} /> Export Markdown
            </button>
            <button className="danger" onClick={() => updateNote(workspaceDoc, noteId, { trashedAt: Date.now() })}>
              <Trash2 size={16} /> Move to Trash
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="toolbar-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  )
}

function AudioRecorder({ editor }: { editor: Editor }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null)
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [rec])

  const start = async () => {
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
      alert(`Microphone unavailable: ${(e as Error).message}`)
    }
  }

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
    <button className="tb" onClick={start} aria-label="Record audio" title="Record audio">
      <Mic size={20} />
    </button>
  )
}
