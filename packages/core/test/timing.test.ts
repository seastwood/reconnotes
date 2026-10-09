import { describe, expect, it } from 'vitest'
import { alignWordTimes, encodeWordTimes, parseWordTimes, spanAt } from '../src/timing'

describe('following a transcript as it plays', () => {
  const words = parseWordTimes(
    JSON.stringify({ v: 1, w: [['We', 0, 20], ['need', 20, 40], ['to', 40, 50], ['figure', 50, 80], ['out', 80, 95], ['plans', 95, 130], ['for', 130, 140], ['tomorrow.', 140, 200], ['Ha', 210, 220], ['ha', 220, 230], ['One,', 240, 260], ['two', 260, 280]] }),
  )!
  it('lays the timed words onto the transcript’s own text, even where it differs', () => {
    // punctuation differs, a repeat ("Ha ha") was taken out of the text
    const text = 'We need to figure out plans for tomorrow! One, two.'
    const spans = alignWordTimes(text, words)
    expect(spans.map((s) => text.slice(s.from, s.to))).toEqual(['We', 'need', 'to', 'figure', 'out', 'plans', 'for', 'tomorrow!', 'One,', 'two.'])
    expect(spans[7].start).toBe(1.4)
    expect(spans[8].start).toBe(2.4)
  })
  it('finds the word being said', () => {
    const spans = alignWordTimes('We need to figure out plans', words)
    expect(spanAt(spans, 0)).toBe(0)
    expect(spanAt(spans, 0.6)).toBe(3)
    expect(spanAt(spans, 99)).toBe(5)
  })
})

describe('word times worth keeping', () => {
  it('keeps real ones, not a recogniser’s zeros', () => {
    const real = [{ word: 'We', start: 0, end: 0.2 }, { word: 'need', start: 0.2, end: 0.4 }, { word: 'plans', start: 0.5, end: 0.9 }]
    expect(parseWordTimes(encodeWordTimes(real))!.map((w) => w.start)).toEqual([0, 0.2, 0.5])
    expect(encodeWordTimes(real.map((w) => ({ ...w, start: 0, end: 0 })))).toBeNull()
    expect(encodeWordTimes([])).toBeNull()
  })
})
