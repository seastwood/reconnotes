import { describe, expect, it } from 'vitest'
import { alignWordTimes, parseWordTimes, spanAt } from '../src/timing'

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
