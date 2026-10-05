/**
 * Shape snapping
 * ==============
 *
 * Draw a line, box, triangle, circle/ellipse or arrow and hold the pen still
 * at the end: the wobbly stroke is replaced by a clean shape. Works on the
 * stroke's points (x, y pairs) and returns the shape as a new point path.
 */

export type ShapeKind = 'line' | 'rectangle' | 'triangle' | 'ellipse' | 'arrow' | 'polygon'
type P = [number, number]

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1])

function pathLength(pts: P[]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

function distToSegment(p: P, a: P, b: P) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Ramer–Douglas–Peucker: the stroke's corners. */
function simplify(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts
  let max = 0
  let idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], pts[0], pts[pts.length - 1])
    if (d > max) {
      max = d
      idx = i
    }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)]
}

/** Snap a line's angle to horizontal / vertical / 45° when it's within 6°. */
function snapAngle(a: P, b: P): P {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  const step = Math.PI / 4
  const snapped = Math.round(ang / step) * step
  if (Math.abs(ang - snapped) > (6 * Math.PI) / 180) return b
  const len = dist(a, b)
  return [a[0] + Math.cos(snapped) * len, a[1] + Math.sin(snapped) * len]
}

/** Points along straight segments, dense enough to draw crisply (corners repeated). */
function polyline(vertices: P[], step = 4): P[] {
  const out: P[] = []
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]
    const b = vertices[i + 1]
    const n = Math.max(1, Math.ceil(dist(a, b) / step))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
    out.push(b, b) // keep the corner sharp
  }
  return out
}

function ellipse(cx: number, cy: number, rx: number, ry: number): P[] {
  const n = Math.max(32, Math.ceil((Math.PI * (rx + ry)) / 4))
  const out: P[] = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2
    out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry])
  }
  return out
}

/** Recognise a shape in a stroke; null when it doesn't look like one. */
export function recognizeShape(pts: P[]): { kind: ShapeKind; points: P[] } | null {
  if (pts.length < 4) return null
  const len = pathLength(pts)
  if (len < 12) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const diag = Math.hypot(maxX - minX, maxY - minY)
  const start = pts[0]
  const end = pts[pts.length - 1]

  // straight line
  if (dist(start, end) / len > 0.94) return { kind: 'line', points: polyline([start, snapAngle(start, end)]) }

  const closed = dist(start, end) < Math.max(0.22 * diag, 6)
  const corners = simplify(pts, Math.max(2, 0.07 * diag))

  if (closed) {
    // ellipse: every point about the same (normalised) distance from the centre
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const rx = (maxX - minX) / 2 || 1
    const ry = (maxY - minY) / 2 || 1
    const radii = pts.map((p) => Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry))
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length
    const sd = Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length)
    // vertices without the duplicated start/end
    const v = dist(corners[0], corners[corners.length - 1]) < Math.max(0.22 * diag, 6) ? corners.slice(0, -1) : corners
    if (v.length === 3) return { kind: 'triangle', points: polyline([...v, v[0]]) }
    if (v.length === 4) {
      // a box drawn roughly square to the page → axis-aligned rectangle
      const tilt = v.every((p, i) => {
        const q = v[(i + 1) % 4]
        const a = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2)
        return a < 0.2 || a > Math.PI / 2 - 0.2
      })
      if (tilt)
        return {
          kind: 'rectangle',
          points: polyline([
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
            [minX, minY],
          ]),
        }
      return { kind: 'polygon', points: polyline([...v, v[0]]) }
    }
    if (sd / mean < 0.13) {
      // nearly round → a true circle
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.18) {
        const r = (rx + ry) / 2
        return { kind: 'ellipse', points: ellipse(cx, cy, r, r) }
      }
      return { kind: 'ellipse', points: ellipse(cx, cy, rx, ry) }
    }
    if (v.length >= 5 && v.length <= 8) return { kind: 'polygon', points: polyline([...v, v[0]]) }
    return null
  }

  // arrow in one stroke: a long shaft, then the head scribbled around its tip
  if (corners.length >= 3) {
    const shaft = dist(corners[0], corners[1])
    const tip = corners[1]
    const rest = pts.slice(pts.findIndex((p) => p[0] === tip[0] && p[1] === tip[1]))
    if (shaft > 0.55 * len && rest.every((p) => dist(p, tip) < 0.4 * shaft)) {
      const a = corners[0]
      const b = snapAngle(a, tip)
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
      const head = Math.min(0.25 * shaft, Math.max(...rest.map((p) => dist(p, tip))) || 0.15 * shaft)
      const h1: P = [b[0] - Math.cos(ang - 0.5) * head, b[1] - Math.sin(ang - 0.5) * head]
      const h2: P = [b[0] - Math.cos(ang + 0.5) * head, b[1] - Math.sin(ang + 0.5) * head]
      return { kind: 'arrow', points: polyline([a, b, h1, b, h2]) }
    }
  }
  return null
}
