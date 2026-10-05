import { useEffect } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import { ColorRow, SizeRow, ToolButtons } from './InkToolbar'
import { inkUi, switchToPrevious, toggleEraser, useInkUi } from './toolState'
import { useUndoManager, useUndoState } from '../editor/undo'

/**
 * Apple Pencil side-button support.
 *
 * The iOS app forwards UIPencilInteraction events as a DOM event:
 *   window.dispatchEvent(new CustomEvent('reconnotes:pencil', { detail }))
 * where detail = { kind: 'tap' | 'squeeze', action, x?, y? } and `action` is
 * the user's system preference (Settings › Apple Pencil):
 *   switchEraser | switchPrevious | showColorPalette | showInkAttributes | ignore
 *
 * Double-tap follows the system preference; squeeze (Pencil Pro) opens this
 * palette next to the pencil with undo/redo, tools, colours and sizes — the
 * same thing Apple Notes does.
 */
/** Where the Pencil was last seen (hovering or touching), so the palette opens next to it. */
let lastPencil: { x: number; y: number } | null = null

export function usePencilInteractions() {
  useEffect(() => {
    const onPencil = (e: Event) => {
      const d = (e as CustomEvent<{ kind: 'tap' | 'squeeze'; action?: string; x?: number; y?: number }>).detail
      const pos =
        d.x !== undefined && d.y !== undefined ? { x: d.x, y: d.y } : (lastPencil ?? { x: innerWidth / 2, y: innerHeight / 2 })
      const openPalette = () => inkUi.set({ palette: inkUi.get().palette ? null : pos })
      if (d.kind === 'squeeze') return openPalette()
      switch (d.action ?? 'switchEraser') {
        case 'switchEraser':
          return toggleEraser()
        case 'switchPrevious':
          return switchToPrevious()
        case 'showColorPalette':
        case 'showInkAttributes':
          return openPalette()
        default:
          return
      }
    }
    // Remember where the pencil is (hovering or touching) so the palette opens next to it.
    const onMove = (e: PointerEvent) => {
      // a plain variable, not the store: updating the store on every move re-renders the page while writing
      if (e.pointerType === 'pen') lastPencil = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('reconnotes:pencil', onPencil)
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('reconnotes:pencil', onPencil)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
}

export function PencilPalette() {
  const palette = useInkUi((s) => s.palette)
  const um = useUndoManager()
  const { canUndo, canRedo } = useUndoState(um)
  if (!palette) return null
  const w = 340
  const left = Math.min(Math.max(8, palette.x - w / 2), innerWidth - w - 8)
  const top = palette.y > innerHeight - 260 ? palette.y - 240 : palette.y + 24
  return (
    <>
      <div className="palette-backdrop" onPointerDown={() => inkUi.set({ palette: null })} />
      <div className="pencil-palette" style={{ left, top, width: w }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-row">
          <button onClick={() => um?.undo()} disabled={!canUndo} aria-label="Undo">
            <Undo2 size={22} />
          </button>
          <button onClick={() => um?.redo()} disabled={!canRedo} aria-label="Redo">
            <Redo2 size={22} />
          </button>
        </div>
        <ToolButtons compact />
        <ColorRow />
        <SizeRow />
      </div>
    </>
  )
}
