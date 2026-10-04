import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { createContext, useContext, useEffect, useState } from 'react'
import * as Y from 'yjs'
import { Loader2, ScanText, Trash2 } from 'lucide-react'
import { getTranscripts, newId } from '@reconnotes/core'
import { DrawingCanvas } from './DrawingCanvas'
import { useUndoManager } from '../editor/undo'
import { inkUi, useInkUi } from './toolState'
import { convertHandwriting, drawingImageUrl } from '../lib/ai'

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

function DrawingView({ node, editor, deleteNode, selected }: ReactNodeViewProps) {
  const ctx = useContext(NoteContext)
  const um = useUndoManager()
  const drawingId = node.attrs.drawingId as string
  const active = useInkUi((s) => s.activeDrawing === drawingId)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <NodeViewWrapper
      className={`drawing-block${active ? ' active' : ''}${selected ? ' selected' : ''}`}
      data-drag-handle=""
      contentEditable={false}
      onPointerDownCapture={() => inkUi.set({ activeDrawing: drawingId })}
    >
      <DrawingCanvas doc={ctx.doc} drawingId={drawingId} undoManager={um} editable={editor.isEditable} />
      {active && editor.isEditable && (
        <div className="drawing-actions">
          <button onClick={convert} disabled={busy} title="Convert handwriting to text below this drawing">
            {busy ? <Loader2 size={16} className="spin" /> : <ScanText size={16} />} Convert to text
          </button>
          <button onClick={() => deleteNode()} title="Delete drawing" className="danger">
            <Trash2 size={16} />
          </button>
        </div>
      )}
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
