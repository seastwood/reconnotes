import type { Stroke } from './schema'
import { segmentLines } from './layout'
import { round1, round2, strokeBounds } from './ink'

/**
 * "Tidy handwriting": make handwritten notes look neater without changing
 * the writing itself.
 *
 *  - Lines written on a slant are straightened.
 *  - Words that drift above or below their line are brought back onto it.
 *  - Lines that start at nearly the same place are lined up on one margin.
 *  - Small wobbles in each stroke are smoothed out (corners are kept).
 *
 * Sketches and diagrams (tall or short groups of ink) are left alone. Returns
 * the strokes in the same order; changed strokes get a new id from `newId`.
 */
export function tidyHandwriting(strokes: Stroke[], newId: () => string): Stroke[] {
  const moved = new Map<string, Stroke>() // id → transformed copy (same id for now)
  const get = (s: Stroke) => moved.get(s.id) ?? s
  const put = (s: Stroke) => moved.set(s.id, s)

  const lines = segmentLines(strokes)
  const textLines: { strokes: Stroke[]; level: number; h: number }[] = []

  for (const line of lines) {
    const all = line.allStrokes
    const h = letterHeight(line.strokes.length ? line.strokes : all)
    const b = line.bounds
    // not a line of writing: a drawing, a lone mark, a column of text…
    if (all.length < 2 || b.h > 3.5 * h || b.w < 2.5 * h) continue

    // 1. Straighten: robust slope through the centres of the strokes.
    const centres = line.strokes.map((s) => {
      const r = strokeBounds(s)
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
    })
    const slope = theilSen(centres)
    const angle = Math.atan(slope)
    const deg = (Math.abs(angle) * 180) / Math.PI
    if (deg > 0.8 && deg < 15) {
      const px = b.x
      const py = median(centres.map((c) => c.y - slope * (c.x - px)))
      const cos = Math.cos(-angle)
      const sin = Math.sin(-angle)
      for (const s of all) put(mapPoints(get(s), (x, y) => [px + (x - px) * cos - (y - py) * sin, py + (x - px) * sin + (y - py) * cos]))
    }

    // 2. Level the words: each word's middle onto the line's middle.
    const words = groupWords(line.strokes.map(get), h)
    const lineMid = median(words.map((w) => w.mid))
    for (const w of words) {
      const d = lineMid - w.mid
      if (Math.abs(d) > 0.2 * h && Math.abs(d) < 0.9 * h) for (const s of w.strokes) put(mapPoints(get(s), (x, y) => [x, y + d]))
    }
    textLines.push({ strokes: all, level: line.level, h })
  }

  // 3. Common margins: lines at the same outline level that start close
  //    together are lined up with each other.
  const byLevel = new Map<number, { strokes: Stroke[]; x: number; h: number }[]>()
  for (const l of textLines) {
    const x = Math.min(...l.strokes.map((s) => strokeBounds(get(s)).x))
    if (!byLevel.has(l.level)) byLevel.set(l.level, [])
    byLevel.get(l.level)!.push({ strokes: l.strokes, x, h: l.h })
  }
  for (const group of byLevel.values()) {
    if (group.length < 2) continue
    const margin = median(group.map((g) => g.x))
    for (const g of group) {
      const d = margin - g.x
      if (Math.abs(d) > 1 && Math.abs(d) < g.h) for (const s of g.strokes) put(mapPoints(get(s), (x, y) => [x + d, y]))
    }
  }

  // 4. Smooth small wobbles (every pen stroke, not highlighter).
  return strokes.map((s) => {
    const t = get(s)
    const smooth = t.tool === 'highlighter' ? t : smoothStroke(t)
    if (smooth === s) return s
    return { ...smooth, id: newId(), pts: smooth.pts.map((v, i) => (i % 3 === 2 ? round2(v) : round1(v))) }
  })
}

function mapPoints(s: Stroke, f: (x: number, y: number) => [number, number]): Stroke {
  const pts = s.pts.slice()
  for (let i = 0; i < pts.length; i += 3) {
    const [x, y] = f(pts[i], pts[i + 1])
    pts[i] = x
    pts[i + 1] = y
  }
  return { ...s, pts }
}

/**
 * Remove small wobbles: a light [1 2 1] filter whose correction is capped at
 * a fraction of a unit, and which skips corners, so letter shapes (the
 * points of an N, the loop of an e) are kept.
 */
function smoothStroke(s: Stroke): Stroke {
  const n = s.pts.length / 3
  if (n < 5) return s
  const p = s.pts
  const q = p.slice()
  const MAX_SHIFT = 0.8
  for (let i = 1; i < n - 1; i++) {
    const ax = p[i * 3] - p[(i - 1) * 3]
    const ay = p[i * 3 + 1] - p[(i - 1) * 3 + 1]
    const bx = p[(i + 1) * 3] - p[i * 3]
    const by = p[(i + 1) * 3 + 1] - p[i * 3 + 1]
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    if (la && lb && (ax * bx + ay * by) / (la * lb) < Math.cos((50 * Math.PI) / 180)) continue // a corner
    for (let k = 0; k < 2; k++) {
      const target = (p[(i - 1) * 3 + k] + 2 * p[i * 3 + k] + p[(i + 1) * 3 + k]) / 4
      const d = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, target - p[i * 3 + k]))
      q[i * 3 + k] = p[i * 3 + k] + d
    }
  }
  return { ...s, pts: q }
}

function groupWords(strokes: Stroke[], h: number) {
  const items = strokes.map((s) => ({ s, b: strokeBounds(s) })).sort((a, b) => a.b.x - b.b.x)
  const words: { strokes: Stroke[]; mid: number }[] = []
  let cur: typeof items = []
  let right = -Infinity
  const flush = () => {
    if (cur.length) words.push({ strokes: cur.map((i) => i.s), mid: median(cur.map((i) => i.b.y + i.b.h / 2)) })
    cur = []
  }
  for (const it of items) {
    if (cur.length && it.b.x - right > 0.6 * h) flush()
    cur.push(it)
    right = Math.max(right, it.b.x + it.b.w)
  }
  flush()
  return words
}

function letterHeight(strokes: Stroke[]): number {
  const hs = strokes.map((s) => strokeBounds(s).h)
  const m = median(hs)
  return median(hs.filter((h) => h >= m * 0.5)) || m || 30
}

function theilSen(pts: { x: number; y: number }[]): number {
  const slopes: number[] = []
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x
      if (Math.abs(dx) > 1) slopes.push((pts[j].y - pts[i].y) / dx)
    }
  return slopes.length ? median(slopes) : 0
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
