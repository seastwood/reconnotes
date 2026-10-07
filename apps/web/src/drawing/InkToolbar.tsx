import { useEffect, useState } from 'react'
import { Eraser, Highlighter, Lasso, PenLine, Pencil, Redo2, Trash2, Undo2, X, Brush, Copy, Scissors, ClipboardPaste, CopyPlus, Type } from 'lucide-react'
import { useInkClipboard } from './inkClipboard'
import type { Tool } from '@reconnotes/core'
import {
  HIGHLIGHT_PALETTE,
  INK_TOOLS,
  PALETTE,
  SIZES,
  inkUi,
  selectTool,
  setColor,
  setSize,
  toolState,
  useInkUi,
  useTools,
  type DrawTool,
} from './toolState'
import { useUndoManager, useUndoState } from '../editor/undo'

export const TOOL_ICONS: Record<DrawTool, typeof PenLine> = {
  pen: PenLine,
  pencil: Pencil,
  marker: Brush,
  highlighter: Highlighter,
  eraser: Eraser,
  lasso: Lasso,
}

const TOOL_LABELS: Record<DrawTool, string> = {
  pen: 'Pen',
  pencil: 'Pencil',
  marker: 'Marker',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
  lasso: 'Lasso select',
}

export function ToolButtons({ compact = false }: { compact?: boolean }) {
  const tool = useTools((s) => s.tool)
  const colors = useTools((s) => s.colors)
  const eraserMode = useTools((s) => s.eraserMode)
  return (
    <div className="ink-tools">
      {(['pen', 'pencil', 'marker', 'highlighter', 'eraser', 'lasso'] as DrawTool[]).map((t) => {
        const Icon = TOOL_ICONS[t]
        const color = INK_TOOLS.includes(t as Tool) ? colors[t as Tool] : undefined
        return (
          <button
            key={t}
            className={`ink-tool${tool === t ? ' on' : ''}`}
            title={t === 'eraser' ? `Eraser (${eraserMode === 'object' ? 'whole strokes' : 'pixels'}) – tap again to switch` : TOOL_LABELS[t]}
            aria-label={TOOL_LABELS[t]}
            onClick={() => {
              if (t === 'eraser' && tool === 'eraser')
                toolState.set({ eraserMode: eraserMode === 'object' ? 'pixel' : 'object' })
              else selectTool(t)
            }}
          >
            <Icon size={compact ? 18 : 20} color={color && color !== '#000000' ? color : undefined} />
            {t === 'eraser' && tool === 'eraser' && <span className="badge">{eraserMode === 'object' ? 'obj' : 'px'}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function ColorRow() {
  const tool = useTools((s) => s.tool)
  const colors = useTools((s) => s.colors)
  const recent = useTools((s) => s.recentColors)
  const inkTool: Tool = INK_TOOLS.includes(tool as Tool) ? (tool as Tool) : 'pen'
  const palette = inkTool === 'highlighter' ? HIGHLIGHT_PALETTE : PALETTE
  const current = colors[inkTool]
  const extra = recent.filter((c) => !palette.includes(c)).slice(0, 2)
  return (
    <div className="ink-colors">
      {[...palette, ...extra].map((c) => (
        <button
          key={c}
          className={`swatch${current === c ? ' on' : ''}`}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          onClick={() => setColor(c)}
        />
      ))}
      <label className="swatch custom" title="Custom colour">
        <input type="color" value={current} onChange={(e) => setColor(e.target.value)} />
      </label>
    </div>
  )
}

export function SizeRow() {
  const tool = useTools((s) => s.tool)
  const sizes = useTools((s) => s.sizes)
  const inkTool: Tool = INK_TOOLS.includes(tool as Tool) ? (tool as Tool) : 'pen'
  return (
    <div className="ink-sizes">
      {SIZES.map((s) => (
        <button key={s} className={`size${sizes[inkTool] === s ? ' on' : ''}`} onClick={() => setSize(s)} aria-label={`Size ${s}`}>
          <span style={{ width: s * 2 + 2, height: s * 2 + 2 }} />
        </button>
      ))}
    </div>
  )
}

/** Toolbar shown at the bottom of the screen while drawing (like Apple Notes). */
export function InkToolbar() {
  const activeDrawing = useInkUi((s) => s.activeDrawing)
  const um = useUndoManager()
  const { canUndo, canRedo } = useUndoState(um)
  const [selCount, setSelCount] = useState(0)
  const clipCount = useInkClipboard()
  const lasso = useTools((s) => s.tool === 'lasso')

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d.drawingId === inkUi.get().activeDrawing) setSelCount(d.count)
    }
    window.addEventListener('reconnotes:ink-selection', on)
    return () => window.removeEventListener('reconnotes:ink-selection', on)
  }, [])

  if (!activeDrawing) return null
  const action = (a: string, extra: object = {}) =>
    window.dispatchEvent(new CustomEvent('reconnotes:ink-action', { detail: { drawingId: activeDrawing, action: a, ...extra } }))

  return (
    <div className="ink-toolbar" role="toolbar" aria-label="Drawing tools" onPointerDown={(e) => e.preventDefault()}>
      <button onClick={() => um?.undo()} disabled={!canUndo} aria-label="Undo" title="Undo">
        <Undo2 size={20} />
      </button>
      <button onClick={() => um?.redo()} disabled={!canRedo} aria-label="Redo" title="Redo">
        <Redo2 size={20} />
      </button>
      <span className="sep" />
      <ToolButtons />
      <span className="sep" />
      {selCount > 0 ? (
        <>
          <span className="sel-label">{selCount} selected</span>
          <div className="ink-colors">
            {PALETTE.slice(0, 6).map((c) => (
              <button key={c} className="swatch" style={{ background: c }} onClick={() => action('recolor-selection', { color: c })} />
            ))}
          </div>
          <button onClick={() => action('copy-selection')} aria-label="Copy selection" title="Copy (⌘C) – paste it in this or another drawing">
            <Copy size={19} />
          </button>
          <button onClick={() => action('cut-selection')} aria-label="Cut selection" title="Cut (⌘X)">
            <Scissors size={19} />
          </button>
          <button onClick={() => action('duplicate-selection')} aria-label="Duplicate selection" title="Duplicate (⌘D)">
            <CopyPlus size={19} />
          </button>
          <button onClick={() => action('convert-selection')} aria-label="Convert selection to text" title="Convert just this writing to text">
            <Type size={19} />
          </button>
          <button onClick={() => action('delete-selection')} aria-label="Delete selection" className="danger">
            <Trash2 size={20} />
          </button>
        </>
      ) : (
        <>
          {lasso && clipCount > 0 && (
            <button onClick={() => action('paste')} aria-label="Paste handwriting" title="Paste handwriting (⌘V)">
              <ClipboardPaste size={19} />
            </button>
          )}
          <ColorRow />
          <SizeRow />
        </>
      )}
      <span className="sep" />
      <button onClick={() => inkUi.set({ activeDrawing: null })} aria-label="Done drawing" title="Done">
        <X size={20} />
      </button>
    </div>
  )
}
