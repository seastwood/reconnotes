import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { Check, PenLine, Share, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Store, useStore } from '../lib/store'
import { DrawingCanvas } from '../drawing/DrawingCanvas'
import { InkToolbar } from '../drawing/InkToolbar'
import { inkUi, useInkUi } from '../drawing/toolState'
import { UndoContext } from '../editor/undo'
import { attachmentBlob } from '../lib/attachments'
import { saveBlob } from '../lib/files'
import { settings } from '../lib/settings'

/**
 * Full-screen picture viewer
 * ==========================
 *
 * Tap a picture in a note to see it big: pinch or scroll to zoom, drag to
 * move around, double-tap to zoom in and out, swipe down (or Esc) to close.
 * "Mark up" draws on it right here – on the same ink layer the note shows on
 * the picture, so it syncs and undoes like any other ink. While marking up,
 * the Pencil draws and two fingers zoom and move (one finger too, unless
 * "draw with finger" is on).
 */

export interface ViewerTarget {
  attachmentId: string
  url: string
  alt: string
  doc: Y.Doc
  undoManager: Y.UndoManager | null
  /** the picture's ink layer, if it has one yet */
  drawingId: string | null
  /** make the ink layer (first mark-up) and return its id */
  ensureDrawing: () => string
  editable: boolean
}

export const imageViewer = new Store<{ target: ViewerTarget | null }>({ target: null })
export const openImageViewer = (target: ViewerTarget) => imageViewer.set({ target })

const MAX_ZOOM = 8
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(1, z))

export function ImageViewerHost() {
  const target = useStore(imageViewer, (s) => s.target)
  if (!target) return null
  return <ImageViewer key={target.attachmentId} target={target} onClose={() => imageViewer.set({ target: null })} />
}

function ImageViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [aspect, setAspect] = useState<number | null>(null)
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [drawingId, setDrawingId] = useState(target.drawingId)
  const marking = useInkUi((s) => drawingId !== null && s.activeDrawing === drawingId)
  const [dismiss, setDismiss] = useState(0) // swipe-down distance

  // the picture fitted into the screen (zoom 1), centred
  const pad = 16
  const top = 64
  const availW = size.w - pad * 2
  const availH = size.h - top - (marking ? 96 : 32)
  const a = aspect ?? 0.75
  const w = Math.max(1, Math.min(availW, availH / a))
  const h = w * a
  const bx = (size.w - w) / 2
  const by = top + (availH - h) / 2

  useLayoutEffect(() => {
    const el = stage.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** keep the picture on screen */
  const clamp = (v: { z: number; tx: number; ty: number }) => {
    if (v.z <= 1.001) return { z: 1, tx: 0, ty: 0 }
    const cw = w * v.z
    const ch = h * v.z
    const fit = (t: number, base: number, content: number, view: number) => {
      // the content may not leave a gap at either side (when it's bigger than the screen)
      const min = Math.min(view - base - content - pad, (view - content) / 2 - base)
      const max = Math.max(-base + pad, (view - content) / 2 - base)
      return Math.min(max, Math.max(min, t))
    }
    return { z: v.z, tx: fit(v.tx, bx, cw, size.w), ty: fit(v.ty, by, ch, size.h) }
  }
  const zoomAt = (px: number, py: number, z: number, from = viewRef.current) => {
    const nz = clampZoom(z)
    const k = nz / from.z
    setView(clamp({ z: nz, tx: px - bx - (px - bx - from.tx) * k, ty: py - by - (py - by - from.ty) * k }))
  }

  // --- gestures ---------------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>())
  const pinch = useRef<{ dist: number; mx: number; my: number; from: typeof view } | null>(null)
  const pan = useRef<{ x: number; y: number; from: typeof view; moved: boolean } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  /** fingers (and the mouse, when not marking up) move the picture; the Pencil draws */
  const moves = (type: string) =>
    type === 'touch' ? !marking || !settings.get().fingerDrawing || pointers.current.size > 1 : type === 'mouse' ? !marking : false

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('.viewer-bar, .ink-toolbar')) return
    if (e.pointerType === 'pen' && !marking && target.editable) {
      // the Pencil on the picture starts marking it up (this touch only opens it)
      startMarkup()
      return
    }
    if (e.pointerType === 'pen') return // the Pencil only ever draws (and a resting palm mustn't pinch)
    const p = local(e)
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType })
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, from: viewRef.current }
      pan.current = null
    } else if (pointers.current.size === 1 && moves(e.pointerType)) {
      pan.current = { x: p.x, y: p.y, from: viewRef.current, moved: false }
    }
  }
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const p = local(e)
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType })
    const pc = pinch.current
    if (pc && pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()]
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y)
      const mx = (p1.x + p2.x) / 2
      const my = (p1.y + p2.y) / 2
      const nz = clampZoom((pc.from.z * dist) / Math.max(1, pc.dist))
      const k = nz / pc.from.z
      setView(clamp({ z: nz, tx: mx - bx - (pc.mx - bx - pc.from.tx) * k, ty: my - by - (pc.my - by - pc.from.ty) * k }))
      return
    }
    const pn = pan.current
    if (!pn) return
    const dx = p.x - pn.x
    const dy = p.y - pn.y
    if (Math.hypot(dx, dy) > 6) pn.moved = true
    if (pn.from.z <= 1.001 && !marking) setDismiss(Math.max(0, dy)) // swipe down to close
    else setView(clamp({ z: pn.from.z, tx: pn.from.tx + dx, ty: pn.from.ty + dy }))
  }
  const onUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const p = local(e)
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const pn = pan.current
    if (pointers.current.size === 0) pan.current = null
    if (dismiss > 0) {
      if (dismiss > 110) return onClose()
      setDismiss(0)
    }
    // double tap: zoom in there, or back out
    if (pn && !pn.moved && !marking) {
      const now = Date.now()
      const lt = lastTap.current
      if (lt && now - lt.t < 320 && Math.hypot(lt.x - p.x, lt.y - p.y) < 30) {
        lastTap.current = null
        if (viewRef.current.z > 1.05) setView({ z: 1, tx: 0, ty: 0 })
        else zoomAt(p.x, p.y, 2.5)
      } else lastTap.current = { t: now, x: p.x, y: p.y }
    }
  }

  // trackpad pinch (ctrl + wheel) and mouse wheel
  useEffect(() => {
    const el = stage.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, v.z * Math.exp(-e.deltaY * 0.01), v)
      else if (v.z > 1) setView(clamp({ z: v.z, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
      else zoomAt(e.clientX - r.left, e.clientY - r.top, v.z * Math.exp(-e.deltaY * 0.004), v)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // Esc closes (or ends mark-up first); + and - zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (marking) inkUi.set({ activeDrawing: null, palette: null })
        else onClose()
      } else if ((e.key === '+' || e.key === '=') && !marking) zoomAt(size.w / 2, size.h / 2, viewRef.current.z * 1.5)
      else if (e.key === '-' && !marking) zoomAt(size.w / 2, size.h / 2, viewRef.current.z / 1.5)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // closing the viewer ends mark-up
  useEffect(
    () => () => {
      if (drawingId && inkUi.get().activeDrawing === drawingId) inkUi.set({ activeDrawing: null, palette: null })
    },
    [drawingId],
  )

  const startMarkup = () => {
    const id = drawingId ?? target.ensureDrawing()
    setDrawingId(id)
    inkUi.set({ activeDrawing: id, palette: null })
  }
  const share = async () => {
    const blob = await attachmentBlob(target.attachmentId)
    if (blob) await saveBlob(blob, `${target.alt || 'Picture'}.${(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`)
  }

  return (
    <div className="image-viewer" role="dialog" aria-label="Picture" style={dismiss ? { background: `rgba(0,0,0,${Math.max(0.2, 0.92 - dismiss / 400)})` } : undefined}>
      <div
        ref={stage}
        className={`viewer-stage${marking ? ' marking' : ''}`}
        onPointerDownCapture={onDown}
        onPointerMoveCapture={onMove}
        onPointerUpCapture={onUp}
        onPointerCancelCapture={onUp}
      >
        <div
          className="viewer-content"
          style={{
            width: w,
            height: h,
            transform: `translate(${bx + view.tx}px, ${by + view.ty + dismiss}px) scale(${view.z})`,
          }}
        >
          <img
            src={target.url}
            alt={target.alt}
            draggable={false}
            onLoad={(e) => e.currentTarget.naturalWidth && setAspect(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth)}
          />
          {drawingId && aspect && (
            <UndoContext.Provider value={target.undoManager}>
              <DrawingCanvas doc={target.doc} drawingId={drawingId} undoManager={target.undoManager} editable={target.editable} overlay={{ aspect }} />
            </UndoContext.Provider>
          )}
        </div>
      </div>

      <div className="viewer-bar">
        <button className="icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={22} />
        </button>
        <span className="viewer-title">{target.alt}</span>
        {!marking && (
          <>
            <button className="icon" onClick={() => zoomAt(size.w / 2, size.h / 2, view.z / 1.5)} disabled={view.z <= 1} aria-label="Zoom out">
              <ZoomOut size={20} />
            </button>
            <button className="viewer-zoom" onClick={() => setView({ z: 1, tx: 0, ty: 0 })} title="Fit to screen">
              {Math.round(view.z * 100)}%
            </button>
            <button className="icon" onClick={() => zoomAt(size.w / 2, size.h / 2, view.z * 1.5)} disabled={view.z >= MAX_ZOOM} aria-label="Zoom in">
              <ZoomIn size={20} />
            </button>
            <button className="icon" onClick={() => void share()} aria-label="Share or save" title="Share or save">
              <Share size={19} />
            </button>
          </>
        )}
        {target.editable &&
          (marking ? (
            <button className="primary" onClick={() => inkUi.set({ activeDrawing: null, palette: null })}>
              <Check size={16} /> Done
            </button>
          ) : (
            <button className="primary" onClick={startMarkup}>
              <PenLine size={16} /> Mark up
            </button>
          ))}
      </div>
      {marking && (
        <UndoContext.Provider value={target.undoManager}>
          <InkToolbar />
        </UndoContext.Provider>
      )}
    </div>
  )
}
