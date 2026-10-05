import type { Stroke } from './schema'
import type { Rect } from './ink'

/**
 * Handwriting layout analysis
 * ===========================
 *
 * OCR models read text well but are poor at page structure: they split lines
 * into fragments and ignore indentation. Because we have the actual pen
 * strokes, we can recover the structure ourselves: group strokes into text
 * lines, spot bullet marks (– • ~ .) at the start of a line, and work out
 * how deeply each line is indented. Each line can then be recognised on its
 * own and reassembled as properly nested Markdown.
 */

export interface InkLine {
  /** strokes of the line's text, left to right (bullet mark excluded) */
  strokes: Stroke[]
  /** every stroke of the line, bullet mark included */
  allStrokes: Stroke[]
  /** the line starts with a bullet mark (dash, dot, tilde…) */
  bullet: boolean
  /** outline depth, 0 = leftmost */
  level: number
  bounds: Rect
}

interface Item {
  id: string
  b: Rect
  cy: number
}

/** A piece of ink (a pen stroke, or a blob of dark pixels in a picture). */
export interface InkBox {
  id: string
  box: Rect
}

/** Like InkLine, for boxes: which boxes form the line's text. */
export interface BoxLine {
  ids: string[]
  /** all boxes of the line, bullet mark included */
  allIds: string[]
  bullet: boolean
  level: number
  bounds: Rect
}

function inkBounds(s: Stroke): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < s.pts.length; i += 3) {
    minX = Math.min(minX, s.pts[i])
    maxX = Math.max(maxX, s.pts[i])
    minY = Math.min(minY, s.pts[i + 1])
    maxY = Math.max(maxY, s.pts[i + 1])
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function union(items: Item[]): Rect {
  const x = Math.min(...items.map((i) => i.b.x))
  const y = Math.min(...items.map((i) => i.b.y))
  return { x, y, w: Math.max(...items.map((i) => i.b.x + i.b.w)) - x, h: Math.max(...items.map((i) => i.b.y + i.b.h)) - y }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Typical letter height in this drawing, ignoring dots and dashes. */
function letterHeight(items: Item[]): number {
  const hs = items.map((i) => i.b.h)
  const m = median(hs)
  return median(hs.filter((h) => h >= m * 0.5)) || m || 30
}

export function segmentLines(strokes: Stroke[]): InkLine[] {
  const usable = strokes.filter((s) => s.tool !== 'highlighter' && s.pts.length >= 3)
  const byId = new Map(usable.map((s) => [s.id, s]))
  return segmentBoxes(usable.map((s) => ({ id: s.id, box: inkBounds(s) }))).map((l) => ({
    strokes: l.ids.map((id) => byId.get(id)!),
    allStrokes: l.allIds.map((id) => byId.get(id)!),
    bullet: l.bullet,
    level: l.level,
    bounds: l.bounds,
  }))
}

/** Group ink boxes into text lines with bullets and indentation levels. */
export function segmentBoxes(boxes: InkBox[]): BoxLine[] {
  const items: Item[] = boxes.map(({ id, box }) => ({ id, b: box, cy: box.y + box.h / 2 }))
  if (!items.length) return []
  const h = letterHeight(items)

  // 1. Group ink into lines by chaining each piece to its neighbours on the
  //    left/right when they sit at the same height (like reading along a
  //    line). This follows sloped writing and keeps close or slightly
  //    overlapping lines apart, which grouping by height alone cannot.
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  const order = items.map((_, i) => i).sort((a, b) => items[a].b.x - items[b].b.x)
  for (let oi = 0; oi < order.length; oi++) {
    const a = items[order[oi]]
    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = items[order[oj]]
      const big = Math.max(a.b.h, b.b.h, 0.5 * h)
      const gapX = b.b.x - (a.b.x + a.b.w)
      if (gapX > 2 * big) break // sorted by x: everything further is further away
      const overlapY = Math.min(a.b.y + a.b.h, b.b.y + b.b.h) - Math.max(a.b.y, b.b.y)
      const small = Math.max(1, Math.min(a.b.h, b.b.h))
      if (overlapY / small > 0.4 && Math.abs(a.cy - b.cy) < 0.6 * big) join(order[oi], order[oj])
    }
  }
  const byRoot = new Map<number, Item[]>()
  items.forEach((it, i) => {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(it)
  })
  let groups: Item[][] = [...byRoot.values()]

  // Pieces of one line separated by a wide space (e.g. a date written far to
  // the right) sit at the same height: merge them.
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (groups[i].length <= 2 || groups[j].length <= 2) continue
        const a = union(groups[i])
        const b = union(groups[j])
        const ha = letterHeight(groups[i])
        const hb = letterHeight(groups[j])
        const ca = median(groups[i].map((x) => x.cy))
        const cb = median(groups[j].map((x) => x.cy))
        const horizontallyApart = b.x > a.x + a.w || a.x > b.x + b.w
        if (horizontallyApart && Math.abs(ca - cb) < 0.35 * Math.max(ha, hb)) {
          groups[i] = [...groups[i], ...groups[j]]
          groups = groups.filter((_, k) => k !== j)
          merged = true
          break outer
        }
      }
    }
  }

  // 2. Tiny groups (i-dots, stray marks, a lone accent) belong to the nearest line.
  const isTinyFor = (g: Item[], ref: Item[]) => g.length <= 2 && g.every((i) => Math.max(i.b.w, i.b.h) < 0.45 * letterHeight(ref))
  let changed = true
  while (changed && groups.length > 1) {
    changed = false
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      if (g.length > 2) continue
      const cy = median(g.map((i) => i.cy))
      let best = -1
      let bestD = Infinity
      groups.forEach((o, oi) => {
        if (oi === gi || o.length <= 2) return
        const b = union(o)
        const d = cy < b.y ? b.y - cy : cy > b.y + b.h ? cy - (b.y + b.h) : 0
        if (d < bestD) {
          bestD = d
          best = oi
        }
      })
      if (best >= 0 && isTinyFor(g, groups[best]) && bestD < 1.2 * letterHeight(groups[best])) {
        groups[best].push(...g)
        groups = groups.filter((_, i) => i !== gi)
        changed = true
        break
      }
    }
  }

  // 3. Per line: order left to right and detect a leading bullet mark.
  const lines = groups
    .map((g) => {
      const h = letterHeight(g)
      const byX = [...g].sort((a, b) => a.b.x - b.b.x)
      let bullet = false
      let markerX = byX[0].b.x
      if (byX.length > 1) {
        const f = byX[0]
        const next = byX[1]
        const dash = f.b.h < 0.45 * h && f.b.w >= 1.3 * Math.max(f.b.h, 1) && f.b.w < 1.3 * h // – ~ _
        const ratio = f.b.w / Math.max(f.b.h, 1)
        const gap = next.b.x - (f.b.x + f.b.w)
        // • . – small, narrow, and followed by a clear space (unlike a letter such as "a" or "o")
        const dot = Math.max(f.b.w, f.b.h) < 0.7 * h && Math.min(f.b.w, f.b.h) < 0.45 * h && ratio > 0.25 && ratio < 4 && gap >= 0.4 * h
        const separate = next.b.x >= f.b.x + f.b.w - 0.05 * h
        if ((dash || dot) && separate) {
          bullet = true
          byX.shift()
          markerX = f.b.x
        }
      }
      return { items: byX, all: g, bullet, markerX, h, bounds: union(byX.length ? byX : g) }
    })
    .sort((a, b) => a.bounds.y - b.bounds.y)

  // 4. Indentation → outline levels.
  const levels = outlineLevels(lines.map((l) => ({ x: l.markerX, bullet: l.bullet, h: l.h })))
  return lines.map((l, i) => ({
    ids: l.items.map((it) => it.id),
    allIds: l.all.map((it) => it.id),
    bullet: l.bullet,
    level: levels[i],
    bounds: l.bounds,
  }))
}

/**
 * Outline levels from where each line starts. Bullet lines form a list whose
 * nesting follows how far each bullet is indented relative to the ones
 * above. A plain line at (or left of) the list's margin is a paragraph and
 * ends the list; an indented plain line continues it as a sub-item.
 * `h` is the line's letter height; indents smaller than `tol × h` are noise.
 */
export function outlineLevels(lines: { x: number; bullet: boolean; h: number }[], tol = 0.6): number[] {
  let stack: number[] = []
  return lines.map((l) => {
    const t = tol * l.h
    if (!l.bullet && (!stack.length || l.x <= stack[0] + t)) {
      stack = []
      return 0
    }
    while (stack.length && l.x < stack[stack.length - 1] - t) stack.pop()
    if (!stack.length || l.x > stack[stack.length - 1] + t) stack.push(l.x)
    return stack.length - 1
  })
}

const BULLET_TEXT = /^\s*(?:[-–—•·*~.]|\[\s?\]|\[x\])\s*/i

/**
 * Assemble recognised lines into Markdown. `texts[i]` is the text read from
 * `lines[i]`. Indented lines become nested list items.
 */
export function linesToMarkdown(lines: { bullet: boolean; level: number }[], texts: string[]): string {
  const out: string[] = []
  lines.forEach((l, i) => {
    let t = (texts[i] ?? '').replace(/\s*\n\s*/g, ' ').trim()
    if (!t) return
    let bullet = l.bullet
    // the OCR may have read the bullet mark itself
    const checkbox = /^\s*\[(x| )?\]\s*/i.exec(t)
    if (BULLET_TEXT.test(t) && !/^\.\d/.test(t)) {
      bullet = true
      t = t.replace(BULLET_TEXT, '').trim()
    }
    if (!t) return // the line was only a bullet mark
    const item = checkbox ? `[${checkbox[1]?.toLowerCase() === 'x' ? 'x' : ' '}] ${t}` : t
    if (bullet || l.level > 0) out.push(`${'  '.repeat(l.level)}- ${item}`)
    else {
      if (out.length && /^\s*- /.test(out[out.length - 1])) out.push('')
      out.push(item, '')
    }
  })
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Turn text lines found by a recogniser that reports positions (e.g. Apple
 * Vision; boxes normalised 0–1, origin top-left) into structured Markdown:
 * pieces on the same row are joined left to right, and indentation becomes
 * list nesting.
 */
export function positionedLinesToMarkdown(found: { text: string; x: number; y: number; w: number; h: number }[]): string {
  const usable = found.filter((l) => l.text.trim())
  if (!usable.length) return ''
  const boxes = usable.map((l, i) => ({ id: String(i), box: { x: l.x * 1000, y: l.y * 1000, w: l.w * 1000, h: l.h * 1000 } }))
  const grouped = segmentBoxes(boxes)
  const rows = grouped.map((g) => {
    const parts = g.ids.map((id) => usable[Number(id)]).sort((a, b) => a.x - b.x)
    const text = parts.map((l) => l.text.trim()).join(' ')
    return {
      text,
      // here bullet marks arrive as text ("- how?"), not as separate ink
      bullet: BULLET_TEXT.test(text) && !/^\.\d/.test(text),
      x: parts[0].x * 1000,
      // these boxes are whole text lines, so a smaller share of their height marks an indent
      h: (parts.reduce((sum, l) => sum + l.h, 0) / parts.length) * 1000 * 0.6,
    }
  })
  const levels = outlineLevels(rows)
  return linesToMarkdown(
    rows.map((r, i) => ({ bullet: r.bullet, level: levels[i] })),
    rows.map((r) => r.text),
  )
}
