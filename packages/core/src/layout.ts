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
  /** the line starts with a bullet mark (dash, dot, tilde…) */
  bullet: boolean
  /** outline depth, 0 = leftmost */
  level: number
  bounds: Rect
}

interface Item {
  s: Stroke
  b: Rect
  cy: number
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
  const items: Item[] = strokes
    .filter((s) => s.tool !== 'highlighter' && s.pts.length >= 3)
    .map((s) => {
      const b = inkBounds(s)
      return { s, b, cy: b.y + b.h / 2 }
    })
  if (!items.length) return []
  const h = letterHeight(items)

  // 1. Group strokes into lines: sort by vertical centre and start a new line
  //    wherever there is a clear vertical gap.
  const sorted = [...items].sort((a, b) => a.cy - b.cy)
  let groups: Item[][] = [[sorted[0]]]
  for (const it of sorted.slice(1)) {
    const cur = groups[groups.length - 1]
    const last = cur[cur.length - 1]
    if (it.cy - last.cy > Math.max(0.55 * h, 8)) groups.push([it])
    else cur.push(it)
  }

  // 2. Tiny groups (i-dots, stray marks, a lone accent) belong to the nearest line.
  const isTiny = (g: Item[]) => g.length <= 2 && g.every((i) => Math.max(i.b.w, i.b.h) < 0.45 * h)
  let changed = true
  while (changed && groups.length > 1) {
    changed = false
    for (let gi = 0; gi < groups.length; gi++) {
      if (!isTiny(groups[gi])) continue
      const g = groups[gi]
      const cy = median(g.map((i) => i.cy))
      let best = -1
      let bestD = Infinity
      groups.forEach((o, oi) => {
        if (oi === gi || isTiny(o)) return
        const b = union(o)
        const d = cy < b.y ? b.y - cy : cy > b.y + b.h ? cy - (b.y + b.h) : 0
        if (d < bestD) {
          bestD = d
          best = oi
        }
      })
      if (best >= 0 && bestD < 1.2 * h) {
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
      const byX = [...g].sort((a, b) => a.b.x - b.b.x)
      let bullet = false
      let markerX = byX[0].b.x
      if (byX.length > 1) {
        const f = byX[0]
        const next = byX[1]
        const small = Math.max(f.b.w, f.b.h) < 0.75 * h
        const dash = f.b.w >= 1.4 * f.b.h && f.b.h < 0.4 * h // – ~ _
        const dot = f.b.w < 0.3 * h && f.b.h < 0.3 * h // • .
        const separate = next.b.x >= f.b.x + f.b.w - 0.05 * h
        if (small && (dash || dot) && separate) {
          bullet = true
          byX.shift()
          markerX = f.b.x
        }
      }
      return { items: byX, bullet, markerX, bounds: union(byX.length ? byX : g) }
    })
    .sort((a, b) => a.bounds.y - b.bounds.y)

  // 4. Indentation → outline levels, relative to the lines above (like an outline editor).
  const tol = 0.8 * h
  const stack: number[] = []
  return lines.map((l) => {
    const x = l.markerX
    while (stack.length && x < stack[stack.length - 1] - tol) stack.pop()
    if (!stack.length || x > stack[stack.length - 1] + tol) stack.push(x)
    return { strokes: l.items.map((i) => i.s), bullet: l.bullet, level: stack.length - 1, bounds: l.bounds }
  })
}

const BULLET_TEXT = /^\s*(?:[-–—•·*~.]|\[\s?\]|\[x\])\s*/i

/**
 * Assemble recognised lines into Markdown. `texts[i]` is the text read from
 * `lines[i]`. Indented lines become nested list items.
 */
export function linesToMarkdown(lines: InkLine[], texts: string[]): string {
  const out: string[] = []
  lines.forEach((l, i) => {
    let t = (texts[i] ?? '').replace(/\s*\n\s*/g, ' ').trim()
    if (!t) return
    let bullet = l.bullet
    // the OCR may have read the bullet mark itself
    const checkbox = /^\s*\[(x| )?\]\s*/i.exec(t)
    if (BULLET_TEXT.test(t) && !/^\.\d/.test(t)) {
      bullet = true
      t = t.replace(BULLET_TEXT, '')
    }
    const item = checkbox ? `[${checkbox[1]?.toLowerCase() === 'x' ? 'x' : ' '}] ${t}` : t
    if (bullet || l.level > 0) out.push(`${'  '.repeat(l.level)}- ${item}`)
    else {
      if (out.length && /^\s*- /.test(out[out.length - 1])) out.push('')
      out.push(item, '')
    }
  })
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
