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

describe('video addresses', async () => {
  const { videoInfo } = await import('../src')
  it('knows YouTube in its many forms, with a start time', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0'])
      expect(videoInfo(u)?.id).toBe('dQw4w9WgXcQ')
    const t = videoInfo('https://youtu.be/dQw4w9WgXcQ?t=1m30s')!
    expect(t.start).toBe(90)
    expect(t.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1&start=90')
    expect(t.watchUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s')
  })
  it('knows Vimeo and video files, and nothing else', () => {
    expect(videoInfo('https://vimeo.com/76979871')?.embedUrl).toBe('https://player.vimeo.com/video/76979871?playsinline=1')
    expect(videoInfo('https://player.vimeo.com/video/76979871')?.provider).toBe('vimeo')
    expect(videoInfo('https://example.com/clips/demo.mp4')?.provider).toBe('file')
    expect(videoInfo('https://example.com/page')).toBeNull()
    expect(videoInfo('https://www.youtube.com/@channel')).toBeNull()
    expect(videoInfo('not a url')).toBeNull()
  })
})
