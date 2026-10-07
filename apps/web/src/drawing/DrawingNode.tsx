import { errorText } from '../lib/jobs'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { createContext, useContext, useEffect, useState } from 'react'
import * as Y from 'yjs'
import { ArrowDown, ArrowUp, Copy, GripVertical, Loader2, ScanText, Scissors, Sparkles, Trash2 } from 'lucide-react'
import { copyBlock } from '../editor/blockClipboard'
import { getStrokes, getTranscripts, inkHash, newId, tidyHandwriting, transcriptSourceKey } from '@reconnotes/core'
import { DrawingCanvas } from './DrawingCanvas'
import { DRAW_ORIGIN, useUndoManager } from '../editor/undo'
import { inkUi, useInkUi } from './toolState'
import { convertHandwriting, drawingImageUrl, recognizeDrawingLocally } from '../lib/ai'
import { preferServerOcr, useDeviceOcr } from '../lib/deviceOcr'
import { settings } from '../lib/settings'
import { useFindInNode, useInkMatches } from '../editor/findHighlights'

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
  // Moved with its own grip and deleted with its own button: a tap or long
  // press on it must not select it like text (iPadOS paints that blue).
  draggable: false,
  selectable: false,

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
    // The drawing handles its own touches; the editor shouldn't turn them into
    // a text selection.
    return ReactNodeViewRenderer(DrawingView, { stopEvent: ({ event }) => !event.type.startsWith('drag') })
  },
})

function DrawingView({ node, editor, deleteNode, selected, getPos }: ReactNodeViewProps) {
  const ctx = useContext(NoteContext)
  const um = useUndoManager()
  const drawingId = node.attrs.drawingId as string
  const active = useInkUi((s) => s.activeDrawing === drawingId)
  // Find in note: highlight the matching words in the handwriting
  const find = useFindInNode(editor, getPos)
  const inkMatches = useInkMatches(ctx?.doc, drawingId, find.query)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // iOS app: recognise the handwriting on the device a few seconds after the
  // writer pauses, so the drawing is searchable (synced to every device).
  useEffect(() => {
    // (with your server's models first, the server makes it searchable instead)
    if (!ctx || !drawingId || !useDeviceOcr() || preferServerOcr() || !settings.get().backgroundOcr || !editor.isEditable) return
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

  // the lasso's "Convert to text": just the selected writing, its text below the drawing
  useEffect(() => {
    if (!ctx || !drawingId) return
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ drawingId: string; strokeIds: string[] }>).detail
      if (d.drawingId !== drawingId) return
      setBusy(true)
      setError(null)
      convertHandwriting(editor, ctx.noteId, drawingId, d.strokeIds)
        .catch((err) => setError(errorText(err)))
        .finally(() => setBusy(false))
    }
    window.addEventListener('reconnotes:convert-ink', on)
    return () => window.removeEventListener('reconnotes:convert-ink', on)
  }, [ctx, drawingId, editor])

  if (!ctx || !drawingId) return <NodeViewWrapper className="drawing-block">Drawing unavailable</NodeViewWrapper>

  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      await convertHandwriting(editor, ctx.noteId, drawingId)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  /** Straighten lines, level words, align margins, smooth wobbles (undoable). */
  const tidy = () => {
    const strokes = getStrokes(ctx.doc, drawingId)
    const before = strokes.toArray()
    const after = tidyHandwriting(before, newId)
    um?.stopCapturing()
    ctx.doc.transact(() => {
      for (let i = before.length - 1; i >= 0; i--) {
        if (after[i] === before[i]) continue
        strokes.delete(i, 1)
        strokes.insert(i, [after[i]])
      }
    }, DRAW_ORIGIN)
    um?.stopCapturing()
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

  /**
   * Drag the grip to move the drawing anywhere in the note. Done with
   * pointer events (not HTML drag and drop, which touch and Pencil on iPad
   * don't start here): a line shows where it will land, and the page scrolls
   * near the top or bottom edge.
   */
  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    const pos = getPos()
    if (typeof pos !== 'number' || editor.state.doc.resolve(pos).depth !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const grip = e.currentTarget
    const id = e.pointerId
    grip.setPointerCapture(id)
    const view = editor.view
    const block = grip.closest('.drawing-block') as HTMLElement | null
    block?.classList.add('dragging')
    const indicator = document.createElement('div')
    indicator.className = 'drop-indicator'
    document.body.appendChild(indicator)
    const scroller = scrollParent(view.dom)
    let y = e.clientY
    let target = -1

    const update = () => {
      const blocks: { index: number; rect: DOMRect }[] = []
      view.state.doc.forEach((_n, offset, index) => {
        const dom = view.nodeDOM(offset)
        if (dom instanceof HTMLElement) blocks.push({ index, rect: dom.getBoundingClientRect() })
      })
      if (!blocks.length) return
      const before = blocks.find((b) => y < b.rect.top + b.rect.height / 2)
      target = before ? before.index : view.state.doc.childCount
      const lineY = before ? before.rect.top - 3 : blocks[blocks.length - 1].rect.bottom + 3
      const r = view.dom.getBoundingClientRect()
      indicator.style.cssText = `top:${lineY - 2}px;left:${r.left}px;width:${r.width}px`
    }
    let raf = 0
    const autoScroll = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect()
        const edge = 60
        if (y < r.top + edge) scroller.scrollTop -= Math.ceil((r.top + edge - y) / 4)
        else if (y > r.bottom - edge) scroller.scrollTop += Math.ceil((y - (r.bottom - edge)) / 4)
      }
      update()
      raf = requestAnimationFrame(autoScroll)
    }
    raf = requestAnimationFrame(autoScroll)

    const move = (ev: PointerEvent) => {
      if (ev.pointerId === id) y = ev.clientY
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      cancelAnimationFrame(raf)
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      indicator.remove()
      block?.classList.remove('dragging')
      if (ev.type !== 'pointerup') return
      const from = getPos()
      if (typeof from !== 'number' || target < 0) return
      const { state } = editor
      const $from = state.doc.resolve(from)
      if ($from.depth !== 0) return
      const index = $from.index()
      if (target === index || target === index + 1) return // dropped where it already is
      const self = state.doc.nodeAt(from)!
      let insertAt = 0
      state.doc.forEach((n, offset, i) => {
        if (i < target) insertAt = offset + n.nodeSize
      })
      const tr = state.tr.insert(insertAt, self)
      tr.delete(tr.mapping.map(from), tr.mapping.map(from + self.nodeSize))
      view.dispatch(tr.scrollIntoView())
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }

  const footer = active && editor.isEditable && (
    <div className="drawing-footer-actions" onPointerDown={(e) => e.stopPropagation()}>
      <span className="drag-grip" onPointerDown={startDrag} title="Drag to move this drawing" aria-label="Drag to move">
        <GripVertical size={20} />
      </span>
      <button onClick={() => move(-1)} title="Move up" aria-label="Move drawing up">
        <ArrowUp size={16} />
      </button>
      <button onClick={() => move(1)} title="Move down" aria-label="Move drawing down">
        <ArrowDown size={16} />
      </button>
      <span className="spacer" />
      <button onClick={tidy} title="Make the handwriting neater: straighter lines, even words and margins, smoother strokes (undo restores it)">
        <Sparkles size={16} /> Tidy
      </button>
      <button onClick={convert} disabled={busy} title="Convert handwriting to text below this drawing">
        {busy ? <Loader2 size={16} className="spin" /> : <ScanText size={16} />} Convert to text
      </button>
      <button onClick={() => void copyBlock(editor, getPos(), ctx.doc)} title="Copy this handwriting (paste it in any note)" aria-label="Copy drawing">
        <Copy size={16} />
      </button>
      <button onClick={() => void copyBlock(editor, getPos(), ctx.doc, true)} title="Cut – to move it to another note" aria-label="Cut drawing">
        <Scissors size={16} />
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
      // Pencil/mouse open the drawing at once; a finger only on a tap, so
      // scrolling past a drawing doesn't open it.
      onPointerDownCapture={(e: React.PointerEvent) => {
        // the ink area opens the drawing itself (so it can tell a first tap from writing)
        if ((e.target as HTMLElement).closest('.ink-input')) return
        // a finger opens it only with a tap (onClickCapture), so scrolling past doesn't
        if (e.pointerType !== 'touch') inkUi.set({ activeDrawing: drawingId })
      }}
      onClickCapture={() => {
        if (!active) inkUi.set({ activeDrawing: drawingId })
      }}
    >
      <DrawingCanvas
        doc={ctx.doc}
        drawingId={drawingId}
        undoManager={um}
        editable={editor.isEditable}
        footer={footer}
        highlights={{ rects: inkMatches, current: find.current }}
      />
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

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return document.scrollingElement as HTMLElement | null
}
