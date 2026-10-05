import { describe, expect, it } from 'vitest'
import { findWordBoxes, parsePictureWords, transcriptLines, wordsInInk, type Stroke } from '../src'

let n = 0
/** A handwritten word: one zig-zag stroke per letter, 50 tall, letters 30 apart. */
function word(x: number, y: number, letters: number): Stroke[] {
  return Array.from({ length: letters }, (_, i) => ({
    id: `s${n++}`,
    tool: 'pen' as const,
    color: '#000',
    size: 3,
    pts: [x + i * 30, y + 50, 0.5, x + i * 30 + 10, y, 0.5, x + i * 30 + 20, y + 50, 0.5],
  }))
}

describe('locating words', () => {
  // "Monday plan" / "- order bins"
  const strokes = [...word(40, 40, 6), ...word(260, 40, 4), ...word(80, 160, 5), ...word(260, 160, 4)]
  const transcript = 'Monday plan\n\n- order bins'

  it('reads transcript lines without Markdown marks', () => {
    expect(transcriptLines(transcript)).toEqual(['Monday plan', 'order bins'])
    expect(transcriptLines('  - [x] **done** thing')).toEqual(['done thing'])
  })

  it('finds a word in the ink it was written with', () => {
    const lines = wordsInInk(strokes, transcript)
    const [plan] = findWordBoxes(lines, 'plan')
    expect(plan.x).toBe(260)
    expect(plan.y).toBe(40)
    expect(plan.w).toBe(110) // 4 letters
    const [bins] = findWordBoxes(lines, 'BINS')
    expect([bins.x, bins.y]).toEqual([260, 160])
  })

  it('highlights part of a word, and phrases across words', () => {
    const lines = wordsInInk(strokes, transcript)
    const [mon] = findWordBoxes(lines, 'mon')
    expect(mon.x).toBe(40)
    expect(mon.w).toBeCloseTo(170 / 2) // half of "Monday"
    const [phrase] = findWordBoxes(lines, 'monday plan')
    expect(phrase.x).toBe(40)
    expect(phrase.x + phrase.w).toBe(370)
    expect(findWordBoxes(lines, 'nothing')).toEqual([])
  })

  it('still places words when the recogniser joined the lines', () => {
    const lines = wordsInInk(strokes, 'Monday plan order bins')
    const [order] = findWordBoxes(lines, 'order')
    expect([order.x, order.y]).toEqual([80, 160])
  })

  it('reads picture word boxes', () => {
    const lines = parsePictureWords(JSON.stringify({ v: 1, lines: [[{ t: 'Bumper', x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, { t: 'kit', x: 0.45, y: 0.2, w: 0.1, h: 0.05 }]] }))!
    expect(findWordBoxes(lines, 'kit')).toEqual([{ x: 0.45, y: 0.2, w: 0.1, h: 0.05 }])
    expect(parsePictureWords('nope')).toBeNull()
  })
})
