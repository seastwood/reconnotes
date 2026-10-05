import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type ReactNodeViewProps } from '@tiptap/react'
import { useContext, useEffect, useState } from 'react'
import { AudioLines, Copy, Eye, FileText, Loader2, Mic, PenLine, ScanText, Share, TextQuote } from 'lucide-react'
import { convertImage, transcribeAudio } from '../lib/ai'
import { getTranscripts, newId } from '@reconnotes/core'
import { addAttachment, attachmentUrl } from '../lib/attachments'
import { NoteContext } from '../drawing/DrawingNode'
import { DrawingCanvas } from '../drawing/DrawingCanvas'
import { inkUi, useInkUi } from '../drawing/toolState'
import { useUndoManager } from './undo'
import { fileKind, formatSize, openFile, shareFile } from '../lib/files'
import { findKey } from './find'

function useAttachmentUrl(id: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!id) return
    let alive = true
    let retry: ReturnType<typeof setTimeout>
    const load = async () => {
      const u = await attachmentUrl(id)
      if (!alive) return
      if (u) setUrl(u)
      else {
        setMissing(true)
        retry = setTimeout(load, 15_000) // not downloaded yet / offline
      }
    }
    void load()
    return () => {
      alive = false
      clearTimeout(retry)
    }
  }, [id])
  return { url, missing }
}

/** Text the server extracted from an attachment (OCR / transcript), synced in the note. */
function useAttachmentText(id: string) {
  const ctx = useContext(NoteContext)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!ctx) return
    const tr = getTranscripts(ctx.doc)
    const update = () => setText(tr.get(`att:${id}`) ?? null)
    update()
    tr.observe(update)
    return () => tr.unobserve(update)
  }, [ctx, id])
  return text
}

/**
 * Button handlers that work for finger and Pencil on iPad as well as the
 * mouse: touch/pen act on pointerup (inside a note, iOS doesn't always
 * deliver the click), the mouse on click.
 */
function tap(action: () => void) {
  let handledAt = 0
  return {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
      e.preventDefault()
      handledAt = Date.now()
      action()
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      if (Date.now() - handledAt < 800) return // already handled on pointerup
      action()
    },
  }
}

// --- Image ------------------------------------------------------------------

function ImageView({ node, selected, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const ctx = useContext(NoteContext)
  const um = useUndoManager()
  const drawingId = node.attrs.drawingId as string | null
  const markingUp = useInkUi((s) => drawingId !== null && s.activeDrawing === drawingId)
  const [aspect, setAspect] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      await convertImage(editor, node.attrs.attachmentId, () => {
        const pos = getPos()
        return typeof pos === 'number' ? pos + node.nodeSize : undefined
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  /** Open the picture's ink layer (created on first use) to draw on it. */
  const markUp = () => {
    let id = drawingId
    if (!id) {
      id = newId()
      updateAttributes({ drawingId: id })
    }
    inkUi.set({ activeDrawing: id, palette: null })
  }
  // The Pencil touching a picture starts marking it up (that first touch
  // only opens it, like a closed drawing); mouse and fingers keep selecting,
  // resizing and scrolling.
  const onPenDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'pen' || !editor.isEditable || markingUp) return
    if ((e.target as HTMLElement).closest('button, .image-resize')) return
    e.preventDefault()
    e.stopPropagation()
    markUp()
  }

  const width = node.attrs.width as number | null
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // The frame hugs the image, so the handle always sits on its corner.
    const frame = e.currentTarget.closest('.image-frame') as HTMLElement
    const startX = e.clientX
    const startW = frame.getBoundingClientRect().width
    // the block the frame sits in is exactly the text column's width
    const parentW = (frame.parentElement as HTMLElement).clientWidth
    const move = (ev: PointerEvent) => {
      frame.style.width = `${Math.max(60, Math.min(parentW, startW + ev.clientX - startX))}px`
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const w = Math.max(60, Math.min(parentW, startW + ev.clientX - startX))
      updateAttributes({ width: Math.round((w / parentW) * 100) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <NodeViewWrapper className={`image-block${selected ? ' selected' : ''}${markingUp ? ' marking-up' : ''}`} data-drag-handle="">
      {url ? (
        <div className="image-frame" style={width ? { width: `${width}%` } : undefined} onPointerDownCapture={onPenDown}>
          <img
            src={url}
            alt={node.attrs.alt ?? ''}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth) setAspect(img.naturalHeight / img.naturalWidth)
            }}
          />
          {ctx && drawingId && aspect && (
            <DrawingCanvas doc={ctx.doc} drawingId={drawingId} undoManager={um} editable={editor.isEditable} overlay={{ aspect }} />
          )}
          {selected && editor.isEditable && !markingUp && (
            <div className="image-resize" onPointerDown={startResize} title="Drag to resize" aria-label="Resize image" />
          )}
          {editor.isEditable && !markingUp && (
            <div className={`image-actions${selected || busy ? ' show' : ''}`}>
              <button {...tap(markUp)} title="Draw on this picture (or just touch it with Apple Pencil)">
                <PenLine size={16} /> Mark up
              </button>
              <button {...tap(() => void convert())} disabled={busy} title="Read the handwriting or text in this picture and add it below">
                {busy ? <Loader2 size={16} className="spin" /> : <ScanText size={16} />} {busy ? 'Reading…' : 'Convert to text'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="attachment-placeholder">
          {missing ? 'Image will appear when synced' : <Loader2 className="spin" size={18} />}
        </div>
      )}
      {error && (
        <div className="drawing-error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </NodeViewWrapper>
  )
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    // drawingId: ink drawn on top of the picture (created when first marked up)
    return { attachmentId: { default: null }, alt: { default: '' }, width: { default: null }, drawingId: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'img[data-attachment-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.attachmentId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId, alt: HTMLAttributes.alt })]
  },
  addNodeView() {
    // Touches on the picture's own controls are theirs alone: the editor
    // mustn't turn them into selecting the picture (which can swallow the tap).
    return ReactNodeViewRenderer(ImageView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('.image-actions, .image-resize, .drawing-canvas.overlay.open')),
    })
  },
})

// --- Audio ------------------------------------------------------------------

/** Copy text, with a fallback for browsers without the async clipboard. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/** The transcript with the words being searched for (⌘F) marked. */
function highlight(text: string, query: string) {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return text
  const out: (string | React.ReactElement)[] = []
  const lower = text.toLocaleLowerCase()
  let i = 0
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    out.push(text.slice(i, at), <mark key={at} className="find-match current">{text.slice(at, at + q.length)}</mark>)
    i = at + q.length
  }
  out.push(text.slice(i))
  return out
}

function AudioView({ node, editor, getPos }: ReactNodeViewProps) {
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const transcript = useAttachmentText(node.attrs.attachmentId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const flash = (msg: string) => {
    setCopied(msg)
    setTimeout(() => setCopied(null), 1500)
  }
  // Find (⌘F) landed on this recording because its transcript matches: show the transcript
  const findHere = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const f = e ? findKey.getState(e.state) : undefined
      const m = f?.matches[f.current]
      return Boolean(m?.block && m.from === getPos())
    },
  })
  useEffect(() => {
    if (findHere) setOpen(true)
  }, [findHere])
  const findQuery = useEditorState({ editor, selector: ({ editor: e }) => (e ? (findKey.getState(e.state)?.query ?? '') : '') })
  const [error, setError] = useState<string | null>(null)
  const transcribe = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await transcribeAudio(
        editor,
        node.attrs.attachmentId,
        () => {
          const pos = getPos()
          return typeof pos === 'number' ? pos + node.nodeSize : undefined
        },
        transcript,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <NodeViewWrapper className="audio-block" data-drag-handle="">
      <div className="audio-head">
        <Mic size={16} /> <span>{node.attrs.name || 'Recording'}</span>
        {editor.isEditable && (
          <button className="audio-transcribe" {...tap(() => void transcribe())} disabled={busy} title="Turn the speech into text below this recording">
            {busy ? <Loader2 size={15} className="spin" /> : <AudioLines size={15} />} {busy ? 'Transcribing…' : 'Transcribe'}
          </button>
        )}
      </div>
      {error && (
        <div className="drawing-error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {url ? <audio controls src={url} preload="metadata" /> : <div className="attachment-placeholder">{missing ? 'Audio will appear when synced' : '…'}</div>}
      {transcript && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Hide transcript' : 'Show transcript'}
        </button>
      )}
      {open && transcript && (
        <>
          <div className="audio-transcript">{highlight(transcript, findQuery)}</div>
          <div className="audio-transcript-actions">
            <button {...tap(() => void copyText(transcript).then(() => flash('Copied')))}>
              <Copy size={14} /> {copied ?? 'Copy'}
            </button>
            {editor.isEditable && (
              <button
                {...tap(() => {
                  const pos = getPos()
                  if (typeof pos !== 'number') return
                  editor
                    .chain()
                    .focus()
                    .insertContentAt(
                      pos + node.nodeSize,
                      transcript.split(/\n+/).filter(Boolean).map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
                    )
                    .run()
                })}
              >
                <TextQuote size={14} /> Insert into note
              </button>
            )}
          </div>
        </>
      )}
    </NodeViewWrapper>
  )
}

export const AudioNode = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, name: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'audio[data-attachment-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.attachmentId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(AudioView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('button, audio, .audio-transcript')),
    })
  },
})

// --- Generic file (PDF, documents, …) -----------------------------------------

function FileView({ node }: ReactNodeViewProps) {
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const text = useAttachmentText(node.attrs.attachmentId)
  const [error, setError] = useState<string | null>(null)
  const name = (node.attrs.name as string) || 'Attachment'
  const mime = (node.attrs.mime as string) || ''
  const size = Number(node.attrs.size) || 0
  const run = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e) => setError((e as Error).message))
  }
  return (
    <NodeViewWrapper className="file-block" data-drag-handle="">
      <div className="file-card">
        <div className="file-icon" aria-hidden="true">
          <FileText size={22} />
          <span>{fileKind(name, mime).slice(0, 4)}</span>
        </div>
        <div className="file-info">
          <div className="file-name">{name}</div>
          <div className="file-meta">
            {[fileKind(name, mime), formatSize(size), !url && missing ? 'not downloaded yet' : '', text ? 'searchable' : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="file-actions">
          <button {...tap(run(() => openFile(node.attrs.attachmentId, name, mime)))} title="Open">
            <Eye size={16} /> Open
          </button>
          <button {...tap(run(() => shareFile(node.attrs.attachmentId, name)))} title="Share or save a copy" aria-label="Share or save">
            <Share size={16} />
          </button>
        </div>
      </div>
      {error && (
        <div className="drawing-error" role="alert">
          {error}
        </div>
      )}
    </NodeViewWrapper>
  )
}

export const FileNode = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, name: { default: '' }, mime: { default: '' }, size: { default: 0 } }
  },
  parseHTML() {
    return [{ tag: 'div[data-file-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.fileId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-file-id': HTMLAttributes.attachmentId })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('button')),
    })
  },
})

/** Store files locally (synced later) and insert the right node for each. */
export async function insertFiles(editor: Editor, files: File[], pos?: number) {
  const nodes = []
  for (const f of files) {
    const attachmentId = await addAttachment(f, f.name)
    if (f.type.startsWith('image/')) nodes.push({ type: 'image', attrs: { attachmentId, alt: f.name.replace(/\.[^.]+$/, '') } })
    else if (f.type.startsWith('audio/')) nodes.push({ type: 'audio', attrs: { attachmentId, name: f.name } })
    else nodes.push({ type: 'file', attrs: { attachmentId, name: f.name, mime: f.type, size: f.size } })
  }
  if (!nodes.length) return
  const chain = editor.chain().focus()
  if (pos !== undefined) chain.insertContentAt(pos, [...nodes, { type: 'paragraph' }]).run()
  else chain.insertContent([...nodes, { type: 'paragraph' }]).run()
}
