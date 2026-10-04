import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * A dropdown menu rendered on top of everything (in a portal on <body>), so
 * it is never clipped by scrolling containers like the editor toolbar or the
 * folder list. Positioned under its anchor button, flipped above it when
 * there isn't room below, and kept inside the viewport.
 */
export function Popover({
  anchorRef,
  onClose,
  align = 'left',
  keepFocus = false,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  align?: 'left' | 'right'
  /** don't steal focus from the editor when tapping menu items */
  keepFocus?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect()
      const m = ref.current
      if (!a || !m) return
      const margin = 8
      const w = m.offsetWidth
      const h = m.scrollHeight
      const below = innerHeight - a.bottom - margin
      const above = a.top - margin
      const openUp = h > below && above > below
      const maxHeight = Math.max(160, openUp ? above - 4 : below - 4)
      const top = openUp ? Math.max(margin, a.top - 4 - Math.min(h, maxHeight)) : a.bottom + 4
      let left = align === 'right' ? a.right - w : a.left
      left = Math.min(Math.max(margin, left), innerWidth - w - margin)
      setPos({ top, left, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef, align])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // close if the anchor scrolls away
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={ref}
      className="menu floating"
      role="menu"
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: -9999, left: -9999 }}
      onPointerDown={(e) => {
        if (keepFocus) e.preventDefault()
      }}
      onClick={(e) => {
        // React portals bubble through the component tree; don't let menu
        // clicks reach the row or toolbar the menu was opened from.
        e.stopPropagation()
        // choosing an item closes the menu (labels and inputs don't)
        if ((e.target as HTMLElement).closest('button')) onClose()
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
