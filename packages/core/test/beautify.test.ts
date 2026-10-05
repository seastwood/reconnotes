import { describe, expect, it } from 'vitest'
import { segmentLines, strokeBounds, tidyHandwriting, type Stroke } from '../src'

let n = 0
const ids = () => `t${n++}`
/** Letters as zig-zag strokes along a line through (x, y) with the given slope. */
function line(x: number, y: number, letters: number, slope: number, h = 40): Stroke[] {
  const out: Stroke[] = []
  for (let i = 0; i < letters; i++) {
    const lx = x + i * h * 0.6 + (i % 4 === 0 && i ? h * 0.5 : 0) * Math.floor(i / 4)
    const ly = y + slope * (lx - x)
    out.push({ id: `l${n++}`, tool: 'pen', color: '#000', size: 3, pts: [lx, ly + h, 0.5, lx + h * 0.2, ly, 0.5, lx + h * 0.4, ly + h, 0.5] })
  }
  return out
}
const centreSlope = (strokes: Stroke[]) => {
  const c = strokes.map((s) => strokeBounds(s)).map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }))
  return (c[c.length - 1].y - c[0].y) / (c[c.length - 1].x - c[0].x)
}

describe('tidyHandwriting', () => {
  it('straightens a slanted line', () => {
    const slanted = line(50, 100, 14, 0.12)
    expect(Math.abs(centreSlope(slanted))).toBeGreaterThan(0.1)
    const tidy = tidyHandwriting(slanted, ids)
    expect(tidy).toHaveLength(slanted.length)
    expect(Math.abs(centreSlope(tidy))).toBeLessThan(0.02)
    // still one line, in the same place roughly
    expect(segmentLines(tidy)).toHaveLength(1)
    expect(Math.abs(strokeBounds(tidy[0]).x - strokeBounds(slanted[0]).x)).toBeLessThan(10)
  })

  it('lines up margins of lines that start close together', () => {
    const a = line(50, 100, 10, 0)
    const b = line(62, 200, 10, 0)
    const tidy = tidyHandwriting([...a, ...b], ids)
    const left = (s: Stroke[]) => Math.min(...s.map((x) => strokeBounds(x).x))
    expect(Math.abs(left(tidy.slice(0, a.length)) - left(tidy.slice(a.length)))).toBeLessThan(1)
  })

  it('leaves a sketch alone apart from smoothing', () => {
    const circle: Stroke = {
      id: 'c',
      tool: 'pen',
      color: '#000',
      size: 3,
      pts: Array.from({ length: 40 }, (_, i) => [300 + 150 * Math.cos(i / 6), 300 + 150 * Math.sin(i / 6), 0.5]).flat(),
    }
    const [t] = tidyHandwriting([circle], ids)
    const b0 = strokeBounds(circle)
    const b1 = strokeBounds(t)
    expect(Math.abs(b0.x - b1.x)).toBeLessThan(5)
    expect(Math.abs(b0.y - b1.y)).toBeLessThan(5)
  })
})
