import { describe, expect, it } from 'vitest'
import { shapeInBox } from '../src'

const bounds = (pts: [number, number][]) => {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => Math.round(n))
}

describe('the shapes tool', () => {
  it('fills the dragged box, whichever way it was dragged', () => {
    expect(bounds(shapeInBox('rectangle', [100, 80], [20, 10]))).toEqual([20, 10, 100, 80])
    expect(bounds(shapeInBox('ellipse', [20, 10], [100, 80]))).toEqual([20, 10, 100, 80])
    expect(bounds(shapeInBox('triangle', [20, 10], [100, 80]))).toEqual([20, 10, 100, 80])
  })

  it('keeps it square (a circle) or a straight angle when asked', () => {
    expect(bounds(shapeInBox('ellipse', [0, 0], [100, 40], true))).toEqual([0, 0, 100, 100])
    const line = shapeInBox('line', [0, 0], [100, 7], true)
    expect(Math.round(line[line.length - 1][1])).toBe(0)
  })

  it('draws an arrow with its head at the end', () => {
    const pts = shapeInBox('arrow', [0, 0], [100, 0])
    expect(pts.some(([x, y]) => x < 100 && x > 70 && y > 5)).toBe(true)
    expect(pts.some(([x, y]) => x < 100 && x > 70 && y < -5)).toBe(true)
  })
})
