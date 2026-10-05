import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { createContext, useContext, useEffect, useState } from 'react'
import * as Y from 'yjs'
import { ArrowDown, ArrowUp, GripVertical, Loader2, ScanText, Trash2 } from 'lucide-react'
import { getStrokes, getTranscripts, inkHash, newId, transcriptSourceKey } from '@reconnotes/core'
import { DrawingCanvas } from './DrawingCanvas'
import { useUndoManager } from '../editor/undo'
import { inkUi, useInkUi } from './toolState'
import { convertHandwriting, drawingImageUrl, recognizeDrawingLocally } from '../lib/ai'
import { useDeviceOcr } from '../lib/deviceOcr'
import { settings } from '../lib/settings'

export interface NoteContextValue {
  doc: Y.Doc
  noteId: string
}
export const NoteContext = createContext<NoteContextValue | null>(null)

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    drawing: {
      /** Insert an ink drawing at the cursor. */
      insertDrawing: () => ReturnType
    }
  }
}

/**
 * A block holding an ink drawing. The node only stores the drawing's id; the
 * strokes live in their own Y.Array so they merge stroke-by-stroke.
 */
export const DrawingNode = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return { drawingId: { default: null } }
  },

  parseHTML() {
    return [{ tag: 'div[data-drawing-id]', getAttrs: (el) => ({ drawingId: (el as HTMLElement).dataset.drawingId }) }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-drawing-id': HTMLAttributes.drawingId })]
  },

  addCommands() {
    return {
      insertDrawing:
        () =>
        ({ commands }) => {
          const drawingId = newId()
          const ok = commands.insertContent([{ type: this.name, attrs: { drawingId } }, { type: 'paragraph' }])
          if (ok) inkUi.set({ activeDrawing: drawingId })
          return ok
        },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawingView)
  },
})

function DrawingView({ node, editor, deleteNode, selected, getPos }: ReactNodeViewProps) {
  const ctx = useContext(NoteContext)
  const um = useUndoManager()
  const drawingId = node.attrs.drawingId as string
  const active = useInkUi((s) => s.activeDrawing === drawingId)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // iOS app: recognise the handwriting on the device a few seconds after the
  // writer pauses, so the drawing is searchable (synced to every device).
  useEffect(() => {
    if (!ctx || !drawingId || !useDeviceOcr() || !settings.get().backgroundOcr || !editor.isEditable) return
    const strokes = getStrokes(ctx.doc, drawingId)
    let timer: ReturnType<typeof setTimeout> | null = null
    let running = false
    const check = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const marker = getTranscripts(ctx.doc).get(transcriptSourceKey(drawingId))
        if (running || !strokes.length || marker === `device:${inkHash(strokes.toArray())}`) return
        running = true
        try {
          await recognizeDrawingLocally(ctx.noteId, drawingId, { cleanup: false })
        } catch {
          /* best effort – the server can still recognise it */
        } finally {
          running = false
        }
      }, 4000)
    }
    strokes.observe(check)
    check()
    return () => {
      strokes.unobserve(check)
      if (timer) clearTimeout(timer)
    }
  }, [ctx, drawingId, editor])

  useEffect(() => {
    if (!ctx) return
    const tr = getTranscripts(ctx.doc)
    const update = () => setTranscript(tr.get(drawingId) ?? null)
    update()
    tr.observe(update)
    return () => tr.unobserve(update)
  }, [ctx, drawingId])

  if (!ctx || !drawingId) return <NodeViewWrapper className="drawing-block">Drawing unavailable</NodeViewWrapper>

  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      await convertHandwriting(editor, ctx.noteId, drawingId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Move this drawing above the previous block or below the next one. */
  const move = (dir: -1 | 1) => {
    const pos = getPos()
    if (typeof pos !== 'number') return
    const { state } = editor
    const $pos = state.doc.resolve(pos)
    const index = $pos.index()
    const parent = $pos.parent
    const neighbour = parent.maybeChild(index + dir)
    if (!neighbour) return
    const self = state.doc.nodeAt(pos)!
    const tr = state.tr.delete(pos, pos + self.nodeSize)
    tr.insert(dir < 0 ? pos - neighbour.nodeSize : pos + neighbour.nodeSize, self)
    editor.view.dispatch(tr.scrollIntoView())
  }

  const footer = active && editor.isEditable && (
    <div className="drawing-footer-actions" onPointerDown={(e) => e.stopPropagation()}>
      <span className="drag-grip" data-drag-handle="" draggable title="Drag to move this drawing" aria-label="Drag to move">
        <GripVertical size={18} />
      </span>
      <button onClick={() => move(-1)} title="Move up" aria-label="Move drawing up">
        <ArrowUp size={16} />
      </button>
      <button onClick={() => move(1)} title="Move down" aria-label="Move drawing down">
        <ArrowDown size={16} />
      </button>
      <span className="spacer" />
      <button onClick={convert} disabled={busy} title="Convert handwriting to text below this drawing">
        {busy ? <Loader2 size={16} className="spin" /> : <ScanText size={16} />} Convert to text
      </button>
      <button onClick={() => deleteNode()} title="Delete drawing" aria-label="Delete drawing" className="danger">
        <Trash2 size={16} />
      </button>
    </div>
  )

  return (
    <NodeViewWrapper
      className={`drawing-block${active ? ' active' : ''}${selected ? ' selected' : ''}`}
      contentEditable={false}
      onPointerDownCapture={() => inkUi.set({ activeDrawing: drawingId })}
    >
      <DrawingCanvas doc={ctx.doc} drawingId={drawingId} undoManager={um} editable={editor.isEditable} footer={footer} />
      {error && (
        <div className="drawing-error" role="alert">
          {error}{' '}
          <a href={drawingImageUrl(ctx.noteId, drawingId)} target="_blank" rel="noreferrer">
            See the image sent to the AI
          </a>
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {transcript && !active && <div className="drawing-transcript" title="Recognised handwriting (searchable)">{transcript}</div>}
    </NodeViewWrapper>
  )
}
