import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import {
  DRAWING_WIDTH,
  eraseFromStroke,
  getDrawingHeight,
  getDrawingMeta,
  getStrokes,
  newId,
  recognizeShape,
  round1,
  round2,
  scaleStroke,
  strokeHit,
  strokeInLasso,
  strokeOpacity,
  strokePath,
  translateStroke,
  unionBounds,
  type Rect,
  type Stroke,
  type Tool,
} from '@reconnotes/core'
import { DRAW_ORIGIN } from '../editor/undo'
import { inkUi, selectTool, toolState, useInkUi, useTools } from './toolState'
import { inkClipboard } from './inkClipboard'
import { settings } from '../lib/settings'
import { WordHighlights } from '../editor/findHighlights'
import { inRecording, playFrom, replay, strokeAt, useReplay } from '../lib/replay'

interface Props {
  doc: Y.Doc
  drawingId: string
  undoManager: Y.UndoManager | null
  editable: boolean
  /**
   * Controls shown in a bar under the drawing while it's being edited, below
   * a resize handle. Kept outside the ink area so a Pencil tap on a control
   * never draws.
   */
  footer?: React.ReactNode
  /**
   * Ink on top of a picture: the canvas covers the picture exactly (height =
   * width × aspect, so the ink scales with it), never grows, and only takes
   * input while open – otherwise touches reach the picture underneath.
   */
  overlay?: { aspect: number }
  /** Find in note: words to highlight in the ink (drawing units) */
  highlights?: { rects: Rect[]; current: boolean }
}

const ERASER_RADIUS = 10
const GROW_MARGIN = 80
/** the selection's resize handle, in screen pixels */
const HANDLE = 14
const GROW_BY = 300
const MAX_HEIGHT = 20000

const isDark = () => document.documentElement.dataset.theme === 'dark'

/** Like Apple Notes, black ink shows as white in dark mode (and vice versa). */
function displayColor(c: string, dark: boolean) {
  if (!dark) return c
  const l = c.toLowerCase()
  if (l === '#000000' || l === '#000') return '#f5f5f5'
  if (l === '#5b5b5b') return '#bdbdbd'
  return c
}

/**
 * An ink canvas embedded in a note.
 *
 * Input handling mirrors Apple Notes on iPad:
 *  - Apple Pencil always draws; once a pencil has been used, fingers scroll
 *    instead (palm rejection) unless "draw with finger" is on.
 *  - Pressure, tilt-independent width and 240 Hz coalesced pencil samples are
 *    used for smooth, natural strokes.
 *  - Eraser (whole stroke or pixel), lasso select / move / resize / copy /
 *    paste / convert to text, and an undo history
 *    shared with the typed text.
 */
export function DrawingCanvas({ doc, drawingId, undoManager, editable, footer, overlay, highlights }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [storedHeight, setHeight] = useState(() => getDrawingHeight(doc, drawingId))
  const height = overlay ? DRAWING_WIDTH * overlay.aspect : storedHeight
  const open = useInkUi((s) => s.activeDrawing === drawingId)
  const openRef = useRef(open)
  openRef.current = open
  /** two or more fingers are down: they scroll, nothing draws */
  const multiTouch = useRef(false)
  const [selection, setSelection] = useState<{ ids: Set<string>; bounds: Rect } | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const tool = useTools((s) => s.tool)

  const strokes = getStrokes(doc, drawingId)
  const scale = width / DRAWING_WIDTH

  // Keep ink in the undo history.
  useEffect(() => {
    undoManager?.addToScope(strokes)
  }, [undoManager, strokes])

  // Track width (ink is stored in a fixed 1000-unit-wide coordinate space).
  useEffect(() => {
    const el = wrapRef.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Height is shared between devices.
  useEffect(() => {
    const meta = getDrawingMeta(doc)
    const update = () => setHeight(getDrawingHeight(doc, drawingId))
    meta.observe(update)
    return () => meta.unobserve(update)
  }, [doc, drawingId])

  // --- Rendering ------------------------------------------------------------
  const pathCache = useRef(new Map<string, Path2D>())
  const pathFor = (s: Stroke) => {
    let p = pathCache.current.get(s.id)
    if (!p) {
      p = new Path2D(strokePath(s))
      pathCache.current.set(s.id, p)
    }
    return p
  }

  const prepare = (canvas: HTMLCanvasElement | null) => {
    if (!canvas || !width) return null
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(width * dpr)
    const h = Math.round(height * scale * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
    return ctx
  }

  const paintStroke = (ctx: CanvasRenderingContext2D, s: Stroke, dark: boolean, path?: Path2D) => {
    // replaying a recording: ink not yet written at this point is faded
    const r = replay.get()
    const later = r.playhead !== null && inRecording(s, r) && (s.t ?? 0) > r.playhead
    ctx.globalAlpha = strokeOpacity(s) * (later ? 0.15 : 1)
    ctx.fillStyle = displayColor(s.color, dark)
    ctx.fill(path ?? pathFor(s))
  }

  const hiddenIds = useRef<Set<string>>(new Set())

  const renderBase = () => {
    const ctx = prepare(baseRef.current)
    if (!ctx) return
    const dark = isDark()
    // Highlighter goes underneath other ink, like a real highlighter.
    const all = strokes.toArray().filter((s) => !hiddenIds.current.has(s.id))
    for (const s of all) if (s.tool === 'highlighter') paintStroke(ctx, s, dark)
    for (const s of all) if (s.tool !== 'highlighter') paintStroke(ctx, s, dark)
    ctx.globalAlpha = 1
  }

  useEffect(() => {
    renderBase()
    const obs = () => {
      // drop cached paths for strokes that no longer exist
      const ids = new Set(strokes.toArray().map((s) => s.id))
      for (const id of pathCache.current.keys()) if (!ids.has(id)) pathCache.current.delete(id)
      renderBase()
      const sel = selectionRef.current
      if (sel && ![...sel.ids].every((id) => ids.has(id))) setSelection(null)
    }
    strokes.observe(obs)
    // replay: redraw as the recording plays (at most once a frame)
    let frame = 0
    const unReplay = replay.subscribe(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(renderBase)
    })
    const mo = new MutationObserver(renderBase)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      strokes.unobserve(obs)
      unReplay()
      cancelAnimationFrame(frame)
      mo.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, width, height])

  // Clear lasso selection when switching tools.
  useEffect(() => {
    if (tool !== 'lasso') setSelection(null)
  }, [tool])

  // --- Input --------------------------------------------------------------
  type Gesture =
    /** focusTap: the drawing was opened by this touch – a mere tap leaves no dot */
    | { kind: 'ink'; stroke: Stroke; focusTap?: boolean; snapped?: boolean }
    | { kind: 'erase' }
    | { kind: 'lasso'; poly: number[] }
    | { kind: 'move'; startX: number; startY: number; dx: number; dy: number }
    /** dragging the selection's corner: k = how much bigger (uniform, around its top-left) */
    | { kind: 'scale'; k: number }

  const gesture = useRef<Gesture | null>(null)
  const activePointer = useRef<number | null>(null)

  const toLocal = (e: { clientX: number; clientY: number }) => {
    // the on-screen size, so this is right when the drawing is zoomed (picture viewer) too
    const r = liveRef.current!.getBoundingClientRect()
    const s = r.width / DRAWING_WIDTH || scale
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }
  }

  const canDraw = (e: React.PointerEvent | PointerEvent) => {
    if (!editable) return false
    if (e.pointerType === 'pen') return true
    if (e.pointerType === 'mouse') return e.button === 0 || e.buttons === 1
    // touch: fingers scroll the page. With "draw with finger" (phones), one
    // finger draws once the drawing is open; a second finger scrolls instead.
    return settings.get().fingerDrawing && openRef.current && !multiTouch.current
  }

  // iOS: stop the Pencil (and a drawing finger) from scrolling the page, but
  // let fingers scroll otherwise. In an open drawing with finger drawing on,
  // two fingers scroll the note (and cancel the stroke the first one began).
  useEffect(() => {
    const el = liveRef.current!
    let lastMid: number | null = null
    const onTouch = (e: TouchEvent) => {
      if (!editable) return
      const t = e.touches[0] as Touch & { touchType?: string }
      if (t?.touchType === 'stylus') return e.preventDefault()
      if (!settings.get().fingerDrawing || !openRef.current) return // fingers scroll normally
      e.preventDefault()
      if (e.touches.length >= 2) {
        if (!multiTouch.current) {
          multiTouch.current = true
          cancelGesture()
        }
        const mid = (e.touches[0].clientY + e.touches[1].clientY) / 2
        const scroller = el.closest('.editor-scroll')
        if (lastMid !== null && scroller) scroller.scrollTop -= mid - lastMid
        lastMid = mid
      }
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) lastMid = null
      if (e.touches.length === 0) multiTouch.current = false
    }
    el.addEventListener('touchstart', onTouch, { passive: false })
    el.addEventListener('touchmove', onTouch, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onTouch)
      el.removeEventListener('touchmove', onTouch)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable])

  /** Drop the stroke in progress (a second finger turned it into a scroll). */
  const cancelGesture = () => {
    stopHold()
    const id = activePointer.current
    if (id === null) return
    activePointer.current = null
    gesture.current = null
    try {
      liveRef.current?.releasePointerCapture(id)
    } catch {
      /* already released */
    }
    hiddenIds.current = new Set()
    renderBase()
    drawLive()
  }

  const growIfNeeded = (y: number) => {
    if (overlay) return
    const h = getDrawingHeight(doc, drawingId)
    if (y > h - GROW_MARGIN && h < MAX_HEIGHT) getDrawingMeta(doc).set(drawingId, { height: h + GROW_BY })
  }

  const eraseAt = (x: number, y: number) => {
    const mode = toolState.get().eraserMode
    const arr = strokes.toArray()
    doc.transact(() => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = arr[i]
        if (mode === 'object') {
          if (strokeHit(s, x, y, ERASER_RADIUS)) strokes.delete(i, 1)
        } else {
          const runs = eraseFromStroke(s, x, y, ERASER_RADIUS)
          if (runs) {
            strokes.delete(i, 1)
            strokes.insert(
              i,
              runs.map((pts) => ({ ...s, id: newId(), pts })),
            )
          }
        }
      }
    }, DRAW_ORIGIN)
  }

  const drawLive = () => {
    const ctx = prepare(liveRef.current)
    if (!ctx) return
    const g = gesture.current
    const dark = isDark()
    if (g?.kind === 'ink' && g.stroke.pts.length) {
      paintStroke(ctx, g.stroke, dark, new Path2D(strokePath(g.stroke)))
    }
    if (g?.kind === 'lasso' && g.poly.length > 2) {
      ctx.globalAlpha = 1
      ctx.setLineDash([6, 6])
      ctx.lineWidth = 1.5 / scale
      ctx.strokeStyle = dark ? '#e5e5e5' : '#444'
      ctx.beginPath()
      ctx.moveTo(g.poly[0], g.poly[1])
      for (let i = 2; i < g.poly.length; i += 2) ctx.lineTo(g.poly[i], g.poly[i + 1])
      ctx.stroke()
    }
    const sel = selectionRef.current
    if (sel) {
      const dx = g?.kind === 'move' ? g.dx : 0
      const dy = g?.kind === 'move' ? g.dy : 0
      const k = g?.kind === 'scale' ? g.k : 1
      const { x: bx, y: by } = sel.bounds
      for (const s of strokes.toArray()) {
        if (sel.ids.has(s.id)) {
          ctx.save()
          ctx.translate(dx + bx, dy + by)
          ctx.scale(k, k)
          ctx.translate(-bx, -by)
          paintStroke(ctx, s, dark)
          ctx.restore()
        }
      }
      ctx.globalAlpha = 1
      ctx.setLineDash([6, 6])
      ctx.lineWidth = 1.5 / scale
      ctx.strokeStyle = '#0a84ff'
      const w = sel.bounds.w * k
      const h = sel.bounds.h * k
      ctx.strokeRect(bx + dx, by + dy, w, h)
      // the corner handle: drag it to make the selection bigger or smaller
      if (editable) {
        const r = HANDLE / scale
        ctx.setLineDash([])
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(bx + dx + w, by + dy + h, r / 2, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  useEffect(drawLive)

  /** Replay mode: a tap on writing plays the recording from when it was written. */
  const onReplayTap = (e: React.MouseEvent) => {
    if (!replay.get().attachmentId) return
    const { x, y } = toLocal(e)
    const hit = strokeAt(strokes.toArray(), x, y, 18 / scale)
    if (hit) playFrom(hit)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (replay.get().attachmentId) return // replaying: taps play, they don't write
    if (e.pointerType === 'pen' && !inkUi.get().pencilSeen) inkUi.set({ pencilSeen: true })
    if (activePointer.current !== null || !canDraw(e)) return
    e.preventDefault()
    // The first touch on a drawing that isn't open only opens it: a tap
    // leaves no dot (and never erases or selects), but writing straight away
    // still draws.
    const opening = inkUi.get().activeDrawing !== drawingId
    inkUi.set({ activeDrawing: drawingId, palette: null })
    activePointer.current = e.pointerId
    liveRef.current!.setPointerCapture(e.pointerId)
    const { x, y } = toLocal(e)
    const t = toolState.get()
    undoManager?.stopCapturing()

    const isInk = !(t.tool === 'eraser' || t.tool === 'lasso' || (e.pointerType === 'pen' && e.button === 5))
    if (opening && !isInk) {
      activePointer.current = null
      liveRef.current!.releasePointerCapture(e.pointerId)
      return
    }

    if (t.tool === 'eraser' || (e.pointerType === 'pen' && e.button === 5)) {
      gesture.current = { kind: 'erase' }
      eraseAt(x, y)
    } else if (t.tool === 'lasso') {
      const sel = selectionRef.current
      const grab = (HANDLE * 1.5) / scale
      if (sel && Math.hypot(x - (sel.bounds.x + sel.bounds.w), y - (sel.bounds.y + sel.bounds.h)) <= grab) {
        gesture.current = { kind: 'scale', k: 1 }
        hiddenIds.current = new Set(sel.ids)
        renderBase()
      } else if (sel && x >= sel.bounds.x && x <= sel.bounds.x + sel.bounds.w && y >= sel.bounds.y && y <= sel.bounds.y + sel.bounds.h) {
        gesture.current = { kind: 'move', startX: x, startY: y, dx: 0, dy: 0 }
        hiddenIds.current = new Set(sel.ids)
        renderBase()
      } else {
        setSelection(null)
        gesture.current = { kind: 'lasso', poly: [x, y] }
      }
    } else {
      const inkTool = t.tool as Tool
      gesture.current = {
        kind: 'ink',
        stroke: {
          id: newId(),
          tool: inkTool,
          color: t.colors[inkTool],
          size: t.sizes[inkTool],
          pts: [round1(x), round1(y), round2(e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5)],
          t: Date.now(),
        },
        focusTap: opening,
      }
    }
    drawLive()
  }

  // Shape snapping: hold the pen still at the end of a stroke and a wobbly
  // line, box, triangle, circle or arrow becomes a clean one.
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number }>({ timer: null, x: 0, y: 0 })
  const stopHold = () => {
    if (hold.current.timer) clearTimeout(hold.current.timer)
    hold.current.timer = null
  }
  const watchHold = (x: number, y: number) => {
    const h = hold.current
    // ignore tiny tremor (≈3 screen pixels) while holding still
    if (h.timer && Math.hypot(x - h.x, y - h.y) * scale < 3) return
    stopHold()
    h.x = x
    h.y = y
    h.timer = setTimeout(() => {
      h.timer = null
      const g = gesture.current
      if (!g || g.kind !== 'ink' || g.snapped || settings.get().shapeSnap === false) return
      const pts: [number, number][] = []
      for (let i = 0; i < g.stroke.pts.length; i += 3) pts.push([g.stroke.pts[i], g.stroke.pts[i + 1]])
      const shape = recognizeShape(pts)
      if (!shape) return
      g.snapped = true
      g.stroke.pts = shape.points.flatMap(([px, py]) => [round1(px), round1(py), 0.5])
      drawLive()
    }, 550)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointer.current) return
    const g = gesture.current
    if (!g) return
    if (g.kind === 'ink' && g.snapped) return // the shape is set; lifting the pen keeps it
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const { x, y } = toLocal(ev)
      if (g.kind === 'ink') {
        const p = g.stroke.pts
        const lx = p[p.length - 3]
        const ly = p[p.length - 2]
        if (Math.abs(lx - x) + Math.abs(ly - y) < 0.4) continue
        p.push(round1(x), round1(y), round2(ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5))
        watchHold(x, y)
      } else if (g.kind === 'erase') {
        eraseAt(x, y)
      } else if (g.kind === 'lasso') {
        g.poly.push(round1(x), round1(y))
      } else if (g.kind === 'move') {
        g.dx = x - g.startX
        g.dy = y - g.startY
      } else if (g.kind === 'scale') {
        const b = selectionRef.current?.bounds
        if (b) g.k = Math.min(6, Math.max(0.15, ((x - b.x) / Math.max(b.w, 1) + (y - b.y) / Math.max(b.h, 1)) / 2))
      }
    }
    drawLive()
  }

  const finish = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointer.current) return
    stopHold()
    activePointer.current = null
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (g.kind === 'ink' && g.focusTap && isTap(g.stroke, scale)) {
      // just opened the drawing with a tap: no dot
    } else if (g.kind === 'ink' && g.stroke.pts.length >= 3) {
      undoManager?.stopCapturing()
      doc.transact(() => strokes.push([g.stroke]), DRAW_ORIGIN)
      // keep the cached path so the committed stroke renders without a flicker
      pathCache.current.set(g.stroke.id, new Path2D(strokePath(g.stroke)))
      growIfNeeded(Math.max(...g.stroke.pts.filter((_, i) => i % 3 === 1)))
    } else if (g.kind === 'lasso') {
      const chosen = strokes.toArray().filter((s) => strokeInLasso(s, g.poly))
      const bounds = unionBounds(chosen)
      setSelection(bounds ? { ids: new Set(chosen.map((s) => s.id)), bounds } : null)
    } else if (g.kind === 'move') {
      const sel = selectionRef.current
      hiddenIds.current = new Set()
      if (sel && (g.dx || g.dy)) {
        const arr = strokes.toArray()
        const moved: Stroke[] = []
        undoManager?.stopCapturing()
        doc.transact(() => {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (!sel.ids.has(arr[i].id)) continue
            const s = translateStroke(arr[i], g.dx, g.dy, newId())
            moved.push(s)
            strokes.delete(i, 1)
            strokes.insert(i, [s])
          }
        }, DRAW_ORIGIN)
        const bounds = unionBounds(moved)!
        setSelection({ ids: new Set(moved.map((s) => s.id)), bounds })
        growIfNeeded(bounds.y + bounds.h)
      } else renderBase()
    } else if (g.kind === 'scale') {
      const sel = selectionRef.current
      hiddenIds.current = new Set()
      if (sel && Math.abs(g.k - 1) > 0.01) {
        const arr = strokes.toArray()
        const out: Stroke[] = []
        undoManager?.stopCapturing()
        doc.transact(() => {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (!sel.ids.has(arr[i].id)) continue
            const s = scaleStroke(arr[i], sel.bounds.x, sel.bounds.y, g.k, newId())
            out.push(s)
            strokes.delete(i, 1)
            strokes.insert(i, [s])
          }
        }, DRAW_ORIGIN)
        const bounds = unionBounds(out)!
        setSelection({ ids: new Set(out.map((s) => s.id)), bounds })
        growIfNeeded(bounds.y + bounds.h)
      } else renderBase()
    }
    drawLive()
  }

  const selectedStrokes = () => {
    const sel = selectionRef.current
    return sel ? strokes.toArray().filter((s) => sel.ids.has(s.id)) : []
  }
  const copySelection = () => {
    const chosen = selectedStrokes()
    if (chosen.length) inkClipboard.set({ strokes: chosen, from: drawingId })
  }
  /** Add strokes (a copy, offset by dx, dy) and select them. */
  const addCopies = (from: Stroke[], dx: number, dy: number) => {
    if (!from.length) return
    const copies = from.map((s) => translateStroke(s, dx, dy, newId()))
    undoManager?.stopCapturing()
    doc.transact(() => strokes.push(copies), DRAW_ORIGIN)
    const bounds = unionBounds(copies)!
    if (toolState.get().tool !== 'lasso') selectTool('lasso')
    setSelection({ ids: new Set(copies.map((s) => s.id)), bounds })
    growIfNeeded(bounds.y + bounds.h)
  }
  const pasteInk = () => {
    const { strokes: clip, from } = inkClipboard.get()
    if (!clip.length) return
    // into the drawing it came from: a little lower and to the right, so it's seen
    const b = unionBounds(clip)!
    const off = from === drawingId && strokes.toArray().some((s) => s.id === clip[0].id) ? 24 : 0
    // keep it inside this drawing
    const dx = Math.min(off, DRAWING_WIDTH - b.x - b.w)
    addCopies(clip, Math.max(dx, -b.x), off)
  }
  const convertSelection = () => {
    const sel = selectionRef.current
    if (sel) window.dispatchEvent(new CustomEvent('reconnotes:convert-ink', { detail: { drawingId, strokeIds: [...sel.ids] } }))
  }

  const deleteSelection = () => {
    const sel = selectionRef.current
    if (!sel) return
    const arr = strokes.toArray()
    undoManager?.stopCapturing()
    doc.transact(() => {
      for (let i = arr.length - 1; i >= 0; i--) if (sel.ids.has(arr[i].id)) strokes.delete(i, 1)
    }, DRAW_ORIGIN)
    setSelection(null)
  }

  const recolorSelection = (color: string) => {
    const sel = selectionRef.current
    if (!sel) return
    const arr = strokes.toArray()
    const ids = new Set<string>()
    doc.transact(() => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!sel.ids.has(arr[i].id)) continue
        const s = { ...arr[i], id: newId(), color }
        ids.add(s.id)
        strokes.delete(i, 1)
        strokes.insert(i, [s])
      }
    }, DRAW_ORIGIN)
    setSelection({ ids, bounds: sel.bounds })
  }

  // Expose selection actions to the toolbar.
  useEffect(() => {
    const onAction = (e: Event) => {
      const { drawingId: id, action, color } = (e as CustomEvent).detail
      if (id !== drawingId) return
      if (action === 'delete-selection') deleteSelection()
      if (action === 'recolor-selection') recolorSelection(color)
      if (action === 'copy-selection') copySelection()
      if (action === 'cut-selection') (copySelection(), deleteSelection())
      if (action === 'duplicate-selection') addCopies(selectedStrokes(), 24, 24)
      if (action === 'paste') pasteInk()
      if (action === 'convert-selection') convertSelection()
    }
    window.addEventListener('reconnotes:ink-action', onAction)
    return () => window.removeEventListener('reconnotes:ink-action', onAction)
  })

  // keyboard (iPad keyboard, Mac): ⌘C ⌘X ⌘V ⌘D, Delete – while this drawing is open and nothing typed has focus
  useEffect(() => {
    if (!open || !editable) return
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea')
      if (typing) return
      const cmd = e.metaKey || e.ctrlKey
      const sel = selectionRef.current
      const k = e.key.toLowerCase()
      if (sel && cmd && k === 'c') copySelection()
      else if (sel && cmd && k === 'x') (copySelection(), deleteSelection())
      else if (sel && cmd && k === 'd') addCopies(selectedStrokes(), 24, 24)
      else if (sel && !cmd && (e.key === 'Backspace' || e.key === 'Delete')) deleteSelection()
      else if (cmd && k === 'v' && toolState.get().tool === 'lasso' && inkClipboard.get().strokes.length) pasteInk()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    if (!selection) return
    window.dispatchEvent(new CustomEvent('reconnotes:ink-selection', { detail: { drawingId, count: selection.ids.size } }))
    return () => {
      window.dispatchEvent(new CustomEvent('reconnotes:ink-selection', { detail: { drawingId, count: 0 } }))
    }
  }, [selection, drawingId])

  // Resize handle: drag to make the drawing taller or shorter. Pointer
  // capture keeps the drag going (finger, mouse or Pencil) even when the
  // pointer leaves the handle.
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    const id = e.pointerId
    handle.setPointerCapture(id)
    handle.classList.add('dragging')
    const startY = e.clientY
    const startH = getDrawingHeight(doc, drawingId)
    const ink = unionBounds(strokes.toArray())
    const minH = Math.max(150, (ink?.y ?? 0) + (ink?.h ?? 0) + 20)
    const heightAt = (y: number) => Math.min(MAX_HEIGHT, Math.max(minH, startH + (y - startY) / scale))
    let last = startY
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      last = ev.clientY
      setHeight(heightAt(last))
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      handle.classList.remove('dragging')
      if (ev.type === 'pointerup') last = ev.clientY
      getDrawingMeta(doc).set(drawingId, { height: Math.round(heightAt(last)) })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const replaying = useReplay((r) => Boolean(r.attachmentId))
  const cssHeight = height * scale
  // fingers draw only in an open drawing (and only with "draw with finger"); otherwise they scroll
  const touchAction = settings.get().fingerDrawing && open ? 'none' : 'pan-y pinch-zoom'

  return (
    <>
    {/* the drawing's buttons sit above it, so they never cover the ink */}
    {editable && footer && !overlay && <div className="drawing-header">{footer}</div>}
    <div
      ref={wrapRef}
      className={`drawing-canvas${overlay ? ' overlay' : ''}${overlay && open ? ' open' : ''}${replaying ? ' replay' : ''}`}
      style={overlay ? undefined : { height: cssHeight || 200 }}
    >
      <canvas ref={baseRef} className="ink-layer" style={{ width: '100%', height: cssHeight }} />
      <canvas
        ref={liveRef}
        className={`ink-layer ink-input tool-${tool}`}
        style={{ width: '100%', height: cssHeight, touchAction }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClick={onReplayTap}
        onContextMenu={(e) => e.preventDefault()}
      />
      {highlights && <WordHighlights rects={highlights.rects} current={highlights.current} scale={scale} />}
    </div>
    {editable && footer && !overlay && (
      <div className="drawing-footer">
        <div
          className="drawing-resize-bar"
          onPointerDown={onResizeDown}
          title="Drag to make the drawing taller or shorter"
          aria-label="Resize drawing"
          role="separator"
        >
          <span className="resize-grip" aria-hidden="true" />
        </div>
      </div>
    )}
    </>
  )
}

/** A stroke that barely moved (under ~6 screen pixels across): a tap, not writing. */
function isTap(s: Stroke, scale: number): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < s.pts.length; i += 3) {
    minX = Math.min(minX, s.pts[i])
    maxX = Math.max(maxX, s.pts[i])
    minY = Math.min(minY, s.pts[i + 1])
    maxY = Math.max(maxY, s.pts[i + 1])
  }
  return Math.max(maxX - minX, maxY - minY) * scale < 6
}
