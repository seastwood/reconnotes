import type { Stroke } from './schema'

/** Geometry helpers for ink strokes (eraser, lasso, bounds). */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function strokeBounds(s: Stroke): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < s.pts.length; i += 3) {
    const x = s.pts[i]
    const y = s.pts[i + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const pad = s.size
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

export function unionBounds(strokes: Stroke[]): Rect | null {
  if (!strokes.length) return null
  let r = strokeBounds(strokes[0])
  for (const s of strokes.slice(1)) {
    const b = strokeBounds(s)
    const x = Math.min(r.x, b.x)
    const y = Math.min(r.y, b.y)
    r = { x, y, w: Math.max(r.x + r.w, b.x + b.w) - x, h: Math.max(r.y + r.h, b.y + b.h) - y }
  }
  return r
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px
  const cy = ay + t * dy - py
  return cx * cx + cy * cy
}

/** Does a circle at (x, y) with radius r touch the stroke? (object eraser) */
export function strokeHit(s: Stroke, x: number, y: number, r: number): boolean {
  const rr = (r + s.size / 2) ** 2
  const p = s.pts
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr
  for (let i = 0; i + 5 < p.length; i += 3) {
    if (distToSegmentSq(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= rr) return true
  }
  return false
}

/**
 * Pixel eraser: remove the parts of a stroke within radius r of (x, y).
 * Returns null when the stroke is untouched, otherwise the list of point runs
 * that remain (possibly empty) — each becomes a new stroke.
 */
export function eraseFromStroke(s: Stroke, x: number, y: number, r: number): number[][] | null {
  const rr = (r + s.size / 2) ** 2
  const p = s.pts
  const runs: number[][] = []
  let cur: number[] = []
  let touched = false
  for (let i = 0; i < p.length; i += 3) {
    const inside = (p[i] - x) ** 2 + (p[i + 1] - y) ** 2 <= rr
    if (inside) {
      touched = true
      if (cur.length) runs.push(cur)
      cur = []
    } else {
      cur.push(p[i], p[i + 1], p[i + 2])
    }
  }
  if (cur.length) runs.push(cur)
  if (!touched) return null
  return runs.filter((run) => run.length >= 6)
}

/** Even-odd point in polygon test; poly is a flat [x0, y0, x1, y1, ...] list. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i]
    const yi = poly[i + 1]
    const xj = poly[j]
    const yj = poly[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A stroke is lasso-selected when most of its points are inside the lasso. */
export function strokeInLasso(s: Stroke, poly: number[]): boolean {
  let inside = 0
  let total = 0
  for (let i = 0; i < s.pts.length; i += 3) {
    total++
    if (pointInPolygon(s.pts[i], s.pts[i + 1], poly)) inside++
  }
  return total > 0 && inside / total >= 0.5
}

export function translateStroke(s: Stroke, dx: number, dy: number, id: string): Stroke {
  const pts = s.pts.slice()
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = round1(pts[i] + dx)
    pts[i + 1] = round1(pts[i + 1] + dy)
  }
  return { ...s, id, pts }
}

/** Make a stroke bigger or smaller (k = 2 is twice the size) around the point ox, oy; its line scales too. */
export function scaleStroke(s: Stroke, ox: number, oy: number, k: number, id: string): Stroke {
  const pts = s.pts.slice()
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = round1(ox + (pts[i] - ox) * k)
    pts[i + 1] = round1(oy + (pts[i + 1] - oy) * k)
  }
  return { ...s, id, pts, size: Math.max(0.5, Math.round(s.size * k * 10) / 10) }
}

export const round1 = (n: number) => Math.round(n * 10) / 10
export const round2 = (n: number) => Math.round(n * 100) / 100
