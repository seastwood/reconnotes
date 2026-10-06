import { useRef } from 'react'
import { safeLocalGet, safeLocalSet } from '../lib/store'

/**
 * iPad / computer: drag the edge of the folders or notes column to make it
 * wider (e.g. to read Jobs or search results), double-tap it to switch
 * between wide and the usual width. Widths are remembered on this device.
 */

export type Column = 'sidebar' | 'list'
export type Widths = Partial<Record<Column, number>>
const KEY = 'reconnotes.columnWidths'
export const loadWidths = (): Widths => safeLocalGet<Widths>(KEY, {})
const MIN = 200
/** the note keeps at least this much room */
const NOTE_MIN = 320

export function ResizeHandle({
  column,
  widths,
  onChange,
  otherWidth,
}: {
  column: Column
  widths: Widths
  onChange: (w: Widths) => void
  /** how wide the other column on screen is (so the note keeps room) */
  otherWidth: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; w: number; moved: boolean } | null>(null)
  const lastTap = useRef(0)
  const max = () => Math.max(MIN, innerWidth - otherWidth - NOTE_MIN)
  const clamp = (w: number) => Math.round(Math.min(max(), Math.max(MIN, w)))
  const current = () => ref.current?.parentElement?.getBoundingClientRect().width ?? 300
  const set = (w: number | undefined, save: boolean) => {
    const next = { ...widths, [column]: w }
    if (w === undefined) delete next[column]
    onChange(next)
    if (save) safeLocalSet(KEY, next)
  }

  return (
    <div
      ref={ref}
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={column === 'sidebar' ? 'Resize the folders column' : 'Resize the notes column'}
      title="Drag to resize – double-tap to widen or go back"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: current(), moved: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        if (Math.abs(e.clientX - d.x) > 3) d.moved = true
        if (d.moved) set(clamp(d.w + e.clientX - d.x), false)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (!d) return
        if (d.moved) return set(clamp(d.w + e.clientX - d.x), true)
        // a tap: two in a row switch between wide and the usual width
        const now = Date.now()
        if (now - lastTap.current < 400) {
          lastTap.current = 0
          set(widths[column] ? undefined : clamp(Math.max(current() * 1.8, innerWidth * 0.45)), true)
        } else lastTap.current = now
      }}
      onPointerCancel={() => (drag.current = null)}
    >
      <span />
    </div>
  )
}
