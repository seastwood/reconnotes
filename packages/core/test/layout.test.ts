import { describe, expect, it } from 'vitest'
import { linesToMarkdown, segmentLines, type Stroke } from '../src'

let n = 0
/** A "word" of handwriting: one zig-zag stroke per letter, ~h tall, with a little jitter. */
function word(x: number, y: number, letters: number, h = 50, opts: { descender?: boolean; slope?: number } = {}): Stroke[] {
  const out: Stroke[] = []
  for (let i = 0; i < letters; i++) {
    const lx = x + i * h * 0.6
    const ly = y + (opts.slope ?? 0) * i * h * 0.6
    const tall = i % 3 === 0 ? 0.35 * h : 0 // ascenders
    const down = opts.descender && i === letters - 1 ? 0.45 * h : 0
    out.push({
      id: `s${n++}`,
      tool: 'pen',
      color: '#000',
      size: 3,
      pts: [lx, ly + h, 0.5, lx + h * 0.2, ly - tall, 0.5, lx + h * 0.4, ly + h + down, 0.5],
    })
  }
  return out
}
const dash = (x: number, y: number, h = 50): Stroke => ({ id: `d${n++}`, tool: 'pen', color: '#000', size: 3, pts: [x, y + h * 0.55, 0.5, x + h * 0.5, y + h * 0.5, 0.5] })
const dot = (x: number, y: number, h = 50): Stroke => ({ id: `p${n++}`, tool: 'pen', color: '#000', size: 3, pts: [x, y + h * 0.6, 0.5, x + 3, y + h * 0.62, 0.5] })

describe('handwriting layout', () => {
  // Modelled on a real page:
  //   Leadership Meeting 9/3/26
  //   - Sprint goals - offer thoughts
  //   - Standardized task boards
  //        - how?
  //             - Templates?
  //
  //   . Focus on winning 2 awards
  //      ~ Imagery award
  const strokes: Stroke[] = [
    ...word(70, 60, 10), ...word(460, 60, 7, 50, { descender: true }), ...word(750, 55, 6),
    dash(110, 200), ...word(160, 200, 6), ...word(370, 205, 5, 50, { descender: true }), dash(560, 200), ...word(620, 200, 5), ...word(790, 195, 8, 50, { slope: -0.15 }),
    dash(110, 330), ...word(160, 330, 12), ...word(530, 335, 4), ...word(710, 330, 6),
    dash(220, 440), ...word(275, 440, 4),
    dash(365, 500), ...word(415, 500, 10, 50, { descender: true }),
    dot(105, 680), ...word(145, 680, 5), ...word(330, 690, 2), ...word(425, 680, 7, 50, { descender: true }), ...word(680, 660, 1), ...word(755, 650, 6),
    dash(170, 790), ...word(220, 790, 6, 50, { descender: true }), ...word(480, 790, 5),
  ]

  it('finds lines, bullets and indentation', () => {
    const lines = segmentLines(strokes)
    expect(lines.map((l) => [l.bullet, l.level])).toEqual([
      [false, 0],
      [true, 0],
      [true, 0],
      [true, 1],
      [true, 2],
      [true, 0],
      [true, 1],
    ])
    // the dash in the middle of "Sprint goals - offer" stays part of the text
    expect(lines[1].strokes.length).toBeGreaterThan(20)
  })

  it('assembles recognised lines into nested Markdown', () => {
    const lines = segmentLines(strokes)
    const md = linesToMarkdown(lines, [
      'Leadership Meeting 9/3/26',
      'Sprint goals - offer thoughts',
      'Standardized task boards',
      '- how?', // OCR read the dash itself
      'Templates?',
      'Focus on winning 2 awards',
      'Imagery award',
    ])
    expect(md).toBe(
      [
        'Leadership Meeting 9/3/26',
        '',
        '- Sprint goals - offer thoughts',
        '- Standardized task boards',
        '  - how?',
        '    - Templates?',
        '- Focus on winning 2 awards',
        '  - Imagery award',
      ].join('\n'),
    )
  })

  it('handles an empty drawing', () => {
    expect(segmentLines([])).toEqual([])
  })
})

describe('lines that are only a bullet mark', () => {
  it('skips them instead of producing an empty list item', () => {
    const lines = [
      { bullet: false, level: 0 },
      { bullet: true, level: 0 },
      { bullet: false, level: 0 },
    ]
    expect(linesToMarkdown(lines, ['Seth', '-', 'Hello'])).toBe('Seth\n\nHello')
  })
})
