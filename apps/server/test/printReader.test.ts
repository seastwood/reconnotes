import { describe, expect, it } from 'vitest'
import { colourBands, grayPng } from '../src/images'
import { linesFromTsv, plainFractions, suspectLine, tidyPrint, withBanners, withoutScraps, closeUps, type PrintLine } from '../src/printReader'
import { withoutSmallPrint } from '../src/photoRecipe'

const line = (text: string, conf = 90, x = 0.1, y = 0.1, w = 0.2, h = 0.02): PrintLine => ({ text, conf, x, y, w, h, words: [] })

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

  it('the bar between two amounts read as a 1, on a card with columns', () => {
    expect(tidyPrint('2 PERSON | 4 PERSON\n111\nLemon\n2/14\nVeggie Stock\n214\n1 | 12\n1 | 15')).toBe(
      '2 PERSON | 4 PERSON\n1 | 1\nLemon\n2 | 4\nVeggie Stock\n2 | 4\n1 | 2\n1 | 15',
    )
    expect(tidyPrint('PREP: 1O MIN\n10 oz |200z\n10 oz | 20 0z\n%oz|1o0z\n1Cup')).toBe('PREP: 10 MIN\n10 oz |20 oz\n10 oz | 20 oz\n%oz|1 oz\n1 Cup')
  })

  it('scraps of icons and pictures left out, bullets made bullets', () => {
    const out = withoutScraps([
      line('titi', 32),
      line('eR', 23),
      line('#', 63),
      line('(', 82),
      line('O', 90),
      line('4', 87),
      line('Jalapeno pf', 57),
      line('© Ground Turkey', 96),
      line('« Zester', 90),
      line('¢ Heat a drizzle of oil', 90),
      line('|  BUST OUT  |', 90),
      line('1 | 2', 55),
      line('Add % of the onion', 50),
      line('cook it up', 95),
      line('& Chermoula', 95),
      line('& 6 FINISH & SERVE', 95),
      line('and lightly browned, then set it aside ok', 95),
    ])
    expect(out.map((l) => l.text)).toEqual(['Jalapeno', 'Ground Turkey', '• Zester', '• Heat a drizzle of oil', 'BUST OUT', '1 | 2', 'Add % of the onion', 'cook it up', '& Chermoula', '6 FINISH & SERVE', 'and lightly browned, then set it aside ok'])
  })

  it('a banner’s reading takes the place of what was read inside it, unless that read the same', () => {
    const page = [line('1 PRFP', 40, 0.3, 0.2, 0.05), line('4 COOK VEGGIES', 90, 0.3, 0.6, 0.1), line('Heat a drizzle', 95, 0.3, 0.25, 0.2)]
    const banners = [line('1 PREP', 90, 0.29, 0.2, 0.06), line('“COOK VEGGIES', 70, 0.29, 0.6, 0.12)]
    expect(withBanners(page, banners).map((l) => l.text).sort()).toEqual(['1 PREP', '4 COOK VEGGIES', 'Heat a drizzle'])
  })

  it('finds a band of colour with light writing on it, not a ragged photo', () => {
    const W = 400
    const H = 300
    const rgba = new Uint8Array(W * H * 4).fill(255)
    const set = (x: number, y: number, r: number, g: number, b: number) => rgba.set([r, g, b, 255], (y * W + x) * 4)
    // a green band 40–360 × 100–124, with white "letters" in it
    for (let y = 100; y < 124; y++) for (let x = 40; x < 360; x++) set(x, y, 120, 180, 60)
    for (let x = 60; x < 200; x += 12) for (let y = 106; y < 118; y++) for (let k = 0; k < 4; k++) set(x + k, y, 255, 255, 255)
    // a ragged patch of colour (a photo): no band
    for (let y = 200; y < 280; y++) for (let x = 40; x < 40 + ((y * 37) % 200); x++) set(x, y, 200, 90, 40)
    const bands = colourBands({ width: W, height: H, rgba })
    expect(bands).toHaveLength(1)
    expect(bands[0].y).toBeGreaterThanOrEqual(96)
    expect(bands[0].y + bands[0].h).toBeLessThanOrEqual(128)
    expect(bands[0].w).toBeGreaterThan(280)
  })
})

describe('a meal-kit card’s small print', () => {
  it('goes before the recipe is set out; the swaps come back as a note', () => {
    const text = [
      '--- Page 1 ---',
      '1 | 1\nYellow Onion',
      '• ANY ISSUES WITH YOUR ORDER?\nas, WE\'D BE SIMMERING LIKE STEW_OVER\nTHERE TOO. SCAN HERE TO GET HELP!',
      '“In our ongoing effort toward sustainability, we\'re working on reducing plastic\nin your order! You may have received 4 servings\nrest assured it contains the correct amount.',
      'HelloCustom',
      'If you chose to modify your meal, follow the\nHelloCustom instructions on the flip side of this card',
      '10 oz |20 oz\nGround Beef”',
      'Calories: 1250',
      '10 oz | 20 oz\nGround Turkey',
      'PREP: 10 MIN COOK: 30 MIN CALORIES: 930',
      '--- Page 2 ---',
      'GET SOCIAL',
      'Share your #HelloFreshPics\nwith us @HelloFresh\n(646) 846-3663\nHelloFresh.com',
      '"Ground Beef is fully cooked when internal temperature\nreaches 160".\nTurkey is fully cooked when internal temperature\nreaches 165".',
      '1 PREP\n• Wash and dry produce.',
    ].join('\n\n')
    const r = withoutSmallPrint(text)
    expect(r.swaps).toEqual(['Ground Beef (10 oz |20 oz)', 'Ground Turkey (10 oz | 20 oz)'])
    expect(r.safety).toEqual(['Ground Beef is fully cooked when internal temperature reaches 160°.', 'Turkey is fully cooked when internal temperature reaches 165°.'])
    expect(r.text).toBe('--- Page 1 ---\n\n1 | 1\nYellow Onion\n\nPREP: 10 MIN COOK: 30 MIN CALORIES: 930\n\n--- Page 2 ---\n\n1 PREP\n• Wash and dry produce.')
  })

  it('doubtful lines looked at close up: taken only when the words are the same, a missing grid amount filled in', async () => {
    const asked: string[] = []
    const ai = {
      canImages: true,
      lookAtPhoto: async (_d: Buffer, mime: string, prompt: string) => {
        asked.push(prompt)
        expect(mime).toBe('image/png')
        return '<think>hm</think>{"1": "1 | 1", "2": "Add ¼ of the onion", "3": "Add a whole new sentence here", "4": "1 | 2"}'
      },
    }
    const photo = grayPng(200, 200, new Uint8Array(200 * 200).fill(200))
    const lines = [
      line('2 PERSON | 4 PERSON', 90, 0.1, 0.02, 0.4),
      line('111', 50, 0.1, 0.1, 0.05),
      line('Lemon', 95, 0.1, 0.13, 0.08),
      line('Zucchini', 95, 0.5, 0.13, 0.1),
      line('Add % of the onion', 80, 0.1, 0.5, 0.5),
      line('Stir in % cup water', 80, 0.1, 0.6, 0.5),
    ]
    const out = await closeUps(ai as never, photo, 'image/png', lines)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('4: (nothing)')
    const texts = out.map((l) => l.text)
    expect(texts).toContain('1 | 1')
    expect(texts).toContain('Add ¼ of the onion')
    // its words weren't Tesseract's: kept as read
    expect(texts).toContain('Stir in % cup water')
    const added = out.find((l) => l.text === '1 | 2')!
    expect(added.y).toBeCloseTo(0.1)
    expect(added.x + added.w / 2).toBeCloseTo(0.55)
  })
})
