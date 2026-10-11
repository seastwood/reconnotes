import { describe, expect, it } from 'vitest'
import { linesFromTsv, plainFractions, suspectLine, tidyPrint } from '../src/printReader'

const HEAD = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
const word = (block: number, line: number, n: number, x: number, y: number, w: number, text: string, conf = 90) =>
  `5\t1\t${block}\t1\t${line}\t${n}\t${x}\t${y}\t${w}\t20\t${conf}\t${text}`

describe('reading print with Tesseract', () => {
  it('lines from its TSV, split where words are far apart (a grid’s cells), scraps left out', () => {
    const tsv = [
      HEAD,
      '1\t1\t0\t0\t0\t0\t0\t0\t1000\t1000\t-1\t',
      word(1, 1, 1, 100, 100, 30, '1'),
      word(1, 1, 2, 135, 100, 10, '|'),
      word(1, 1, 3, 150, 100, 30, '1'),
      word(1, 1, 4, 400, 100, 60, '1 Clove'),
      word(1, 1, 5, 470, 100, 10, '|'),
      word(1, 1, 6, 485, 100, 60, '2 Cloves'),
      word(1, 1, 7, 700, 100, 30, 'eo', 5),
      word(2, 1, 1, 100, 130, 80, 'Yellow'),
      word(2, 1, 2, 185, 130, 60, 'Onion'),
    ].join('\n')
    const lines = linesFromTsv(tsv)
    expect(lines.map((l) => l.text)).toEqual(['1 | 1', '1 Clove | 2 Cloves', 'Yellow Onion'])
    expect(lines[0]).toMatchObject({ x: 0.1, y: 0.1 })
    expect(lines[2].words).toHaveLength(2)
  })

  it('its usual slips on a card', () => {
    expect(tidyPrint('2 PERSON | 4 PERSON\n1/1\nYellow Onion\n1/2\nZucchini\n1oz|20z\nltsp |1tsp\nY%oz\\|10z')).toBe(
      '2 PERSON | 4 PERSON\n1 | 1\nYellow Onion\n1 | 2\nZucchini\n1 oz|2 oz\n1 tsp |1 tsp\nY%oz|1 oz',
    )
    // without columns for numbers of people, 1/2 is a half
    expect(tidyPrint('1/2\nCup flour')).toBe('1/2\nCup flour')
  })

  it('the fractions it misreads: the sure ones put right, the others marked for a look', () => {
    expect(plainFractions('Y2 Cup | 1 Cup')).toBe('½ Cup | 1 Cup')
    expect(plainFractions('into Vz-inch-thick half-moons')).toBe('into ½-inch-thick half-moons')
    expect(suspectLine('Y OZ | Ve oz')).toBe(true)
    expect(suspectLine('Add % of the onion; cook')).toBe(true)
    expect(suspectLine('Stir in rice, % cup water (1% cups for')).toBe(true)
    expect(suspectLine('Wash and dry produce.')).toBe(false)
    expect(suspectLine('3 TBSP | 6 TBSP')).toBe(false)
    expect(suspectLine('Y%oz|1 oz')).toBe(true)
    expect(suspectLine('Yellow Onion | 1 oz')).toBe(false)
  })
})
