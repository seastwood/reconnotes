import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * A dropdown menu rendered on top of everything (in a portal on <body>), so
 * it is never clipped by scrolling containers like the editor toolbar or the
 * folder list. Positioned under its anchor button, flipped above it when
 * there isn't room below, and kept inside the viewport.
 */
/** The safe-area insets (status bar / notch, home indicator) in pixels. */
let probe: HTMLDivElement | null = null
function safeInsets(): { top: number; bottom: number } {
  if (!probe) {
    probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
    document.body.appendChild(probe)
  }
  const cs = getComputedStyle(probe)
  return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 }
}

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
      // keep clear of the status bar / notch and the home indicator
      const { top: insetTop, bottom: insetBottom } = safeInsets()
      const minTop = insetTop + margin
      const maxBottom = innerHeight - insetBottom - margin
      const w = m.offsetWidth
      const h = m.scrollHeight
      const below = maxBottom - a.bottom - 4
      const above = a.top - 4 - minTop
      const openUp = h > below && above > below
      // taller than the room there: it scrolls inside
      const maxHeight = Math.max(120, openUp ? above : below)
      const top = openUp ? Math.max(minTop, a.top - 4 - Math.min(h, maxHeight)) : a.bottom + 4
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
