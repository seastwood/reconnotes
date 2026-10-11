import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, noteDocName, noteToMarkdown } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { tidyNote } from '../src/tidy'
import { guardAddress, isPrivateHost, isPrivateIp } from '../src/netGuard'
import { samePicture } from '../src/webImport'
import { duration, recipeIn } from '../src/recipe'
import { amountFromReading, bustOutItems, normalizeColumns, fixBars, inCardOrder, isBoilerplate, joinAmountsToNames, isEquipment, isPantry, recipeFromPhotos, markUnreadAmounts, splitColumns, tidyIngredient, titleCase } from '../src/photoRecipe'
import { guessKind, kindFromWords, kindIn, notesFromPhotos, reflow, sameWords } from '../src/photoPages'

let app: App
let dir: string
let llm: http.Server
/** what the fake AI answers next */
let reply = 'none'
const prompts: string[] = []

beforeAll(async () => {
  llm = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url!.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gen' }] }))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const m = body.messages?.[0]?.content
    prompts.push(typeof m === 'string' ? m : (m?.[0]?.text ?? ''))
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-tidy-'))
  app = createApp(loadConfig({ RECON_TOKEN: 'test-token-0123456789abcdef', RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  app.ai.agents.save({ name: 'Gen', kind: 'openai', baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, model: 'gen', vision: false })
})

afterAll(async () => {
  await app.close()
  llm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function note(id: string, lines: string[]) {
  await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: lines[0] }))
  await app.sync.change(noteDocName(id), (doc) => {
    getContent(doc).insert(
      0,
      lines.map((t) => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText(t)])
        return p
      }),
    )
  })
}
const text = (id: string) => noteToMarkdown(app.sync.getDoc(noteDocName(id))!)

describe('Tidy with AI', () => {
  it('takes out only the blocks it names – never the title, the source line, or a line with an amount – and keeps the note as it was', async () => {
    await note('tidynote000001', [
      'Chili',
      'From example.com · imported 2026-10-10',
      'PinFacebookTweetEmail',
      'Brown the beef with 2 tablespoons chili powder.',
      '4.95 from 3096 votes',
      'Simmer it uncovered so it thickens.',
      'Subscribe to receive weekly recipes!',
    ])
    // it names the share bar, the votes, the newsletter – and, wrongly, the title and the amount line
    reply = '1, 3, 4, 5, 7'
    const r = await tidyNote(app.store, app.sync, app.ai, 'tidynote000001')
    expect(r.removed.length).toBe(3)
    const after = text('tidynote000001')
    for (const kept of ['Chili', 'From example.com', 'Brown the beef with 2 tablespoons', 'Simmer it uncovered']) expect(after).toContain(kept)
    for (const gone of ['PinFacebook', '3096 votes', 'Subscribe']) expect(after).not.toContain(gone)
    // the page's text is shown as data, not instructions
    expect(prompts.at(-1)).toContain('not instructions to you')
    // and the untidied note is in its history, to put back
    expect(app.store.listVersions(noteDocName('tidynote000001')).find((v) => v.id === r.versionId)?.label).toBe('Before tidying')
  })

  it('takes nothing out when it would take more than half the note', async () => {
    await note('tidynote000002', ['Notes', 'One long paragraph of what the page is really about, with plenty of detail in it.', 'Another long paragraph that matters just as much as the first one did.'])
    reply = '2, 3'
    const r = await tidyNote(app.store, app.sync, app.ai, 'tidynote000002')
    expect(r.refused).toMatch(/more than half/)
    expect(text('tidynote000002')).toContain('Another long paragraph')
  })
})

describe('your own network, kept out of web imports', () => {
  it('knows private, local and reserved addresses', async () => {
    for (const ip of ['10.0.0.5', '192.168.1.1', '172.20.3.4', '127.0.0.1', '169.254.169.254', '100.100.1.1', '::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.1', '0.0.0.0'])
      expect(isPrivateIp(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '151.101.1.69', '2606:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false)
    expect(await isPrivateHost('localhost')).toBe(true)
    expect(await isPrivateHost('router.lan')).toBe(true)
    await expect(guardAddress('http://192.168.1.1/admin.png', false)).rejects.toThrow(/your own network/)
    await expect(guardAddress('http://192.168.1.1/admin.png', true)).resolves.toBeUndefined()
  })
})

describe('the same picture at another size', () => {
  it('is the same picture', () => {
    expect(samePicture('https://x.com/wp/chili-600x400.jpg')).toBe(samePicture('https://x.com/wp/chili.jpg'))
    expect(samePicture('https://cdn.x.com/a.jpg?w=300&h=200')).toBe(samePicture('https://cdn.x.com/a.jpg'))
    expect(samePicture('https://cdn.x.com/a.jpg?id=7')).not.toBe(samePicture('https://cdn.x.com/a.jpg?id=8'))
  })
})

describe('a recipe in a page’s data', () => {
  it('is read with its sections, times and yield', () => {
    expect(duration('PT1H5M')).toBe('1 hr 5 min')
    expect(duration('PT45M')).toBe('45 min')
    const r = recipeIn([
      JSON.stringify({
        '@type': ['Recipe'],
        name: 'Tacos',
        recipeYield: '4',
        recipeIngredient: ['1 lb beef'],
        recipeInstructions: [
          { '@type': 'HowToSection', name: 'Meat', itemListElement: [{ '@type': 'HowToStep', text: 'Brown it.' }] },
          { '@type': 'HowToSection', name: 'Serve', itemListElement: [{ '@type': 'HowToStep', text: 'Fill the shells.' }] },
        ],
      }),
    ])
    expect(r?.steps).toEqual([
      { section: 'Meat', steps: ['Brown it.'] },
      { section: 'Serve', steps: ['Fill the shells.'] },
    ])
    expect(recipeIn(['{"@type":"Article","name":"x"}'])).toBeNull()
  })
})

describe('a recipe from photos', () => {
  it('is set out like an imported one – checked against what was read: nothing made up, wrong amounts marked', async () => {
    const front = 'Cheesy Beef Chili\nwith Cornbread\nPREP 10 MIN TOTAL 35 MIN CALORIES 820'
    const back = `INGREDIENTS 2 PERSON | 4 PERSON
10 oz | 20 oz Ground Beef
1 | 2 Yellow Onion
1 | 2 Chili Powder
BUST OUT Large pot, Salt, Pepper
1 PREP Halve, peel, and finely chop onion.
2 COOK BEEF Heat a large drizzle of oil in a large pot. Add beef and onion; cook until browned, 4-5 minutes.
3 SIMMER Stir in chili powder and 1 cup water; simmer 10 minutes.`
    const atts = ['front', 'back'].map((n) => {
      const id = `photo${n}0000001`.slice(0, 16)
      app.store.putAttachment({ id, mime: 'image/png', name: `${n}.png`, size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
      return id
    })
    reply = JSON.stringify({
      name: 'Cheesy Beef Chili',
      servings: '2',
      prep: '10 min',
      total: '35 min',
      // the AI got one amount wrong (12, not 10) and made one ingredient up
      ingredients: ['12 oz Ground Beef', '1 Yellow Onion', '1 Chili Powder', '1 cup Brown Sugar'],
      steps: [
        { title: 'Prep', text: 'Halve, peel, and finely chop onion.' },
        { title: 'Cook beef', text: 'Heat a large drizzle of oil in a large pot. Add beef and onion; cook until browned, 4-5 minutes.' },
        { title: 'Simmer', text: 'Stir in chili powder and 1 cup water; simmer 10 minutes.' },
      ],
      notes: ['You’ll need: Large pot, Salt, Pepper', 'Amounts for 4 people are also on the card: 20 oz Ground Beef, 2 Yellow Onion, 2 Chili Powder'],
    })
    const r = await recipeFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: atts[0], text: front }, { attachmentId: atts[1], text: back }], null)
    expect(r.left).toEqual(['1 cup Brown Sugar'])
    expect(r.unsure).toBe(1)
    const md = text(r.noteId)
    expect(md).toMatch(/^# Cheesy Beef Chili/)
    expect(md).toContain('**Servings:** 2 · **Prep:** 10 min · **Total:** 35 min · #recipe')
    expect(md).toContain('- [ ] 10 oz Ground Beef'.replace('10', '12')) // as the AI wrote it…
    expect(getContent(app.sync.getDoc(noteDocName(r.noteId))!).toString()).toMatch(/<uncertain>12<\/uncertain>/) // …marked to check
    expect(md).toMatch(/1\. Prep: Halve, peel, and finely chop onion\.\n2\. Cook beef: Heat a large drizzle/)
    expect(md).toContain('## Notes')
    // (the AI's own note of the other column's amounts isn't used: they're worked out from the ingredients)
    expect(md).not.toContain('also on the card')
    expect(md).not.toContain('Brown Sugar')
    // the photos: the front as its picture, the back under "The original"
    expect(md).toContain('## The original')
    expect((getContent(app.sync.getDoc(noteDocName(r.noteId))!).toString().match(/<image /g) ?? []).length).toBe(2)
  })

  it('a card’s table: both columns split, no worked-out times, no gaps or stray allergen notes', async () => {
    const id = 'photocard0000001'
    app.store.putAttachment({ id, mime: 'image/png', name: 'back.png', size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
    const read = 'LEMON THYME PORK\nPREP: 10 MIN TOTAL: 35 MIN\nINGREDIENTS 2-person | 4-person\nZucchini 112\nJasmine Rice ½ Cup | 1 Cup\nSour Cream\n1 PREP Trim and halve zucchini lengthwise.\nInternal temperature reaches 145 degrees'
    reply = JSON.stringify({
      name: 'Lemon Thyme Pork',
      servings: '2',
      prep: '10 MIN',
      cook: '35 MIN',
      total: '45 MIN',
      ingredients: ['Zucchini 112', 'Jasmine Rice ½ Cup | 1 Cup', 'Sour Cream'],
      steps: [{ title: 'Prep', text: 'Trim and halve zucchini lengthwise.' }],
      notes: ['Amounts for N people are also on the card: 4-person amounts (Zucchini: ?, Jasmine Rice: 1 Cup)', '(Contains: Milk)'],
    })
    const r = await recipeFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: id, text: read }], null)
    const md = text(r.noteId)
    expect(md).toContain('**Servings:** 2 · **Prep:** 10 MIN · **Total:** 35 MIN · #recipe')
    expect(md).toContain('- [ ] 1 Zucchini\n- [ ] ½ Cup Jasmine Rice\n- [ ] Sour Cream')
    expect(md).toContain('Amounts for the other number of people on the card: 2 Zucchini, 1 Cup Jasmine Rice')
    expect(md).not.toContain('?')
    expect(md).not.toContain('Contains')
  })

  it('a card with a grid of pictures, swaps on its side and small print', async () => {
    const id = 'photogrid0000001'
    app.store.putAttachment({ id, mime: 'image/png', name: 'front.png', size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
    const read = [
      'APRICOT, ALMOND & CHICKPEA TAGINE',
      'INGREDIENTS 2 PERSON | 4 PERSON',
      '1 | 1',
      'Yellow Onion',
      '¼ oz | ¼ oz',
      'Parsley',
      'HelloCustom Ground Beef Calories: 1250 Ground Turkey Calories: 1190',
      'PREP: 10 MIN | COOK: 30 MIN | CALORIES: 930',
      '1 PREP Wash and dry produce. Halve, peel, and dice onion.',
      'BUST OUT Zester 2 Small bowls Kosher salt Olive oil (2 TBSP | 3 TBSP)',
      'GET SOCIAL Share your #HelloFreshPics with us @HelloFresh',
    ].join('\n')
    reply = JSON.stringify({
      name: 'Apricot, Almond & Chickpea Tagine',
      servings: '2',
      ingredients: ['ن/٦', '1 | 1', 'Yellow Onion', '¼ Oz Oz', 'Parsley'],
      steps: [{ title: 'Prep', text: 'Wash and dry produce. Halve, peel, and dice onion.' }],
      notes: ['BUST OUT • Zester • 2 Small bowls • Kosher salt • Olive oil (2 TBSP | 3 TBSP)', 'GET SOCIAL Share your #HelloFreshPics with us @HelloFresh'],
      nutrition: [['Calories', '1250'], ['Calories', '1190'], ['Calories', '930']],
    })
    const r = await recipeFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: id, text: read }], null)
    const md = text(r.noteId)
    expect(md).toContain('- [ ] 1 Yellow Onion\n- [ ] ¼ Oz Parsley\n')
    expect(md).not.toContain('ن')
    expect(md).toMatch(/Calories: 930(?!.*Calories)/s)
    expect(md).not.toContain('1250')
    expect(md).toContain('You’ll need: Zester, 2 Small bowls')
    expect(md).toContain('From your pantry: Kosher salt, Olive oil (2 TBSP | 3 TBSP)')
    expect(md).not.toMatch(/BUST OUT|HelloFreshPics/)
  })

  it('a column heading stuck on, calories, a step’s title repeated', async () => {
    const id = 'photohead0000001'
    app.store.putAttachment({ id, mime: 'image/png', name: 'front.png', size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
    const read = 'TAGINE\n2 PERSON | 4 PERSON\n1 | 1 | Yellow Onion\n1 | 1 | Lemon\nHelloCustom Calories: 1250\n4 COOK VEGGIES Heat a large drizzle of oil in a large pan.\nZester Small pot Kosher salt Butter'
    reply = JSON.stringify({
      name: 'Tagine',
      ingredients: ['2 PERSON | 4 PERSON Yellow Onion', '1 | 1 Lemon', 'Calories: 1250'],
      steps: [{ title: 'COOK VEGGIES', text: '4 COOK VEGGIES - Heat a large drizzle of oil in a large pan.' }],
      notes: ["You'll need: Zester | Small pot, Kosher salt |, Butter (2 TBSP | 4 TBSP). From your pantry: Salt, Pepper, Oil, Butter."],
    })
    const r = await recipeFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: id, text: read }], null)
    const md = text(r.noteId)
    // (no amount from the AI for the onion: the one read with it)
    expect(md).toContain('- [ ] 1 Yellow Onion\n- [ ] 1 Lemon\n')
    expect(md).not.toMatch(/PERSON|1250/)
    expect(md).toContain('1. COOK VEGGIES: Heat a large drizzle of oil in a large pan.')
    expect(md).toContain('You’ll need: Zester, Small pot')
    expect(md).toContain('From your pantry: Kosher salt, Butter (2 TBSP | 4 TBSP)')
    expect(md).not.toContain('Salt, Pepper, Oil')
  })

  it('what the AI made of a card’s grid last time: names repeated, bars everywhere', async () => {
    const id = 'photorepeat00001'
    app.store.putAttachment({ id, mime: 'image/png', name: 'front.png', size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
    const read =
      'APRICOT TAGINE\n1 | 1 Yellow Onion\n¼ oz | ¼ oz Parsley\n1 Clove | 2 Cloves Garlic\n1 | 2 Zucchini\n½ Cup | 1 Cup Basmati Rice\nHot Sauce\n' +
      '4 COOK VEGGIES Heat large drizzle oil in large pan.\nBUST OUT Zester 2 Small bowls Strainer Large pan Small pot Kosher salt Black pepper Olive oil (2 TBSP | 3 TBSP)'
    reply = JSON.stringify({
      name: 'Apricot Tagine',
      ingredients: ['Yellow Onion | Yellow Onion | Yellow Onion', '¼ oz | Parsley', '1 Clove | Garlic', '½ Zucchini | 1 Zucchini | Zucchini', '½ Cup | Basmati Rice', 'Hot Sauce | Hot Sauce | Hot Sauce'],
      steps: [{ title: 'COOK VEGGIES', text: '4 | 5 | Heat large drizzle oil in large pan.' }],
      notes: [
        'You’ll need: Zester',
        'From your pantry: Salt, pepper, oil, butter you supply.',
        'From your pantry: 2 Small bowls; Strainer, Large pan; Small pot, ; Kosher salt, ; Black pepper, ; Olive oil (2 TBSP | 3 TBSP)',
      ],
    })
    const r = await recipeFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: id, text: read }], null)
    const md = text(r.noteId)
    expect(md).toContain('- [ ] 1 Yellow Onion\n- [ ] ¼ oz Parsley\n- [ ] 1 Clove Garlic\n- [ ] ½ Zucchini\n- [ ] ½ Cup Basmati Rice\n- [ ] Hot Sauce\n')
    expect(md).toContain('1. COOK VEGGIES: Heat large drizzle oil in large pan.')
    expect(md).toContain('You’ll need: Zester, 2 Small bowls, Strainer, Large pan, Small pot')
    expect(md).toContain('From your pantry: Kosher salt, Black pepper, Olive oil (2 TBSP | 3 TBSP)')
    expect(md).not.toMatch(/you supply|Yellow Onion \||\| 5 \|/)
  })

  it('marks an amount that wasn’t read, however it’s written', () => {
    const read = new Set(['10', '1/2', '4'])
    expect(markUnreadAmounts('½ cup broth', read)).toBe('½ cup broth')
    expect(markUnreadAmounts('12 oz beef', read)).toBe('⸢12⸣ oz beef')
  })
})

describe('a meal-kit card’s lines', () => {
  it('pictures read as letters, badges and stray marks off; a unit not twice', () => {
    expect(tidyIngredient('ن/٦').text).toBe('')
    expect(tidyIngredient('© Ground Beef**').text).toBe('Ground Beef**')
    expect(tidyIngredient('C Ground Beef is fully cooked').text).toBe('Ground Beef is fully cooked')
    expect(tidyIngredient('A Pinch of Salt').text).toBe('A Pinch of Salt')
    expect(tidyIngredient('¼ Oz Oz').text).toBe('¼ Oz')
    expect(tidyIngredient('1 Jalapeño').text).toBe('1 Jalapeño')
    expect(tidyIngredient('Crème fraîche').text).toBe('Crème fraîche')
    expect(normalizeColumns('Yellow Onion | Yellow Onion')).toBe('Yellow Onion')
    expect(tidyIngredient('Hot Sauce |').text).toBe('Hot Sauce')
    expect(tidyIngredient('½ oz Parsley | ¼ oz Parsley').text).toBe('½ oz Parsley | ¼ oz Parsley')
  })
  it('the same amount for both columns, the bar read as a 1', () => {
    expect(splitColumns('1 11 Jalapeño')).toEqual({ first: '1', other: '1', name: 'Jalapeño' })
    expect(fixBars('Lemon 111')).toBe('Lemon 1 | 1')
  })
  it('a line’s parts between bars, however the AI put them', () => {
    expect(normalizeColumns('Yellow Onion | Yellow Onion | Yellow Onion')).toBe('Yellow Onion')
    expect(normalizeColumns('½ Zucchini | 1 Zucchini | Zucchini')).toBe('½ | 1 Zucchini')
    expect(normalizeColumns('1 Clove | Garlic')).toBe('1 Clove Garlic')
    expect(normalizeColumns('¼ oz | ¼ oz | Parsley')).toBe('¼ oz | ¼ oz Parsley')
    expect(normalizeColumns('1 | 2 | Chickpeas')).toBe('1 | 2 Chickpeas')
    expect(normalizeColumns('Veggie Stock Concentrates | Veggie Stock Concentrate')).toBe('Veggie Stock Concentrates')
    expect(normalizeColumns('Cooking oil (1 TBSP | 1 TBSP)')).toBe('Cooking oil (1 TBSP | 1 TBSP)')
    expect(normalizeColumns('Salt | Pepper')).toBe('Salt | Pepper')
    expect(normalizeColumns('2 Lemons')).toBe('2 Lemons')
    expect(normalizeColumns('Jasmine Rice ½ Cup | 1 Cup')).toBe('½ Cup | 1 Cup Jasmine Rice')
  })
  it('an amount the AI left out, found with its name in what was read', () => {
    const read = ['2 PERSON | 4 PERSON', '1 | 1 | Yellow Onion', '¼ oz | ¼ oz', 'Parsley', 'Lemon zest to taste']
    expect(amountFromReading('Yellow Onion', read)).toBe('1 | 1 Yellow Onion')
    expect(amountFromReading('Parsley', read)).toBe('¼ oz | ¼ oz Parsley')
    expect(amountFromReading('Lemon', read)).toBe('Lemon')
    expect(amountFromReading('2 Zucchini', read)).toBe('2 Zucchini')
  })
  it('a grid’s amounts put back with their names', () => {
    expect(joinAmountsToNames(['1 | 1', 'Yellow Onion', '¼ Oz', 'Parsley', '1 Clove Garlic', ''])).toEqual(['1 | 1 Yellow Onion', '¼ Oz Parsley', '1 Clove Garlic'])
    expect(joinAmountsToNames(['2 TBSP', '1 Lemon'])).toEqual(['2 TBSP', '1 Lemon'])
  })
  it('the card’s small print, and its “Bust out” list', () => {
    expect(isBoilerplate('GET SOCIAL Share your #HelloFreshPics with us @HelloFresh (646) 846-3663 HelloFresh.com')).toBe(true)
    expect(isBoilerplate('In our ongoing effort toward sustainability, we’re working on reducing plastic')).toBe(true)
    expect(isBoilerplate('HelloCustom If you chose to modify your meal, follow the instructions on the flip side of this card.')).toBe(true)
    expect(isBoilerplate('Ground Beef is fully cooked when internal temperature reaches 160°.')).toBe(false)
    expect(bustOutItems('BUST OUT • Zester • 2 Small bowls • Kosher salt • Cooking oil (1 TBSP | 1 TBSP) 0 e • Olive oil (2 TBSP | 3 TBSP)')).toEqual([
      'Zester',
      '2 Small bowls',
      'Kosher salt',
      'Cooking oil (1 TBSP | 1 TBSP)',
      'Olive oil (2 TBSP | 3 TBSP)',
    ])
    expect(bustOutItems('Toast the almonds')).toBeNull()
    expect(bustOutItems('From your pantry: Salt, pepper, oil, butter you supply.')).toEqual([])
    expect(bustOutItems('From your pantry: 2 Small bowls; Strainer, Large pan; Small pot, ; Kosher salt, ; Olive oil (2 TBSP | 3 TBSP)')).toEqual([
      '2 Small bowls',
      'Strainer',
      'Large pan',
      'Small pot',
      'Kosher salt',
      'Olive oil (2 TBSP | 3 TBSP)',
    ])
    // the AI's own version: two columns with bars, and a pantry summary of its own
    expect(
      bustOutItems(
        "You'll need: Zester | 2 Small bowls, Strainer | Large pan, Small pot |, Kosher salt |, Black pepper |, Cooking oil (1 TBSP | 1 TBSP) (1 tsp | 1 tsp), Olive oil (2 TBSP | 3 TBSP), Butter (2 TBSP | 4 TBSP). From your pantry: Salt, Pepper, Oil, Butter.",
      ),
    ).toEqual(['Zester', '2 Small bowls', 'Strainer', 'Large pan', 'Small pot', 'Kosher salt', 'Black pepper', 'Cooking oil (1 TBSP | 1 TBSP) (1 tsp | 1 tsp)', 'Olive oil (2 TBSP | 3 TBSP)', 'Butter (2 TBSP | 4 TBSP)'])
  })

  it('allergen notes out of the ingredients, stray marks off', () => {
    expect(tidyIngredient('2 TBSP Contains: Milk Butter Garlic Herb')).toEqual({ text: '2 TBSP Butter Garlic Herb', allergens: ['Milk'] })
    expect(tidyIngredient('(Contains: Eggs, Potato Buns')).toEqual({ text: 'Potato Buns', allergens: ['Eggs'] })
    expect(tidyIngredient('Concentrate Chicken Stock (Contains: Milk, Wheat)')).toEqual({ text: 'Concentrate Chicken Stock', allergens: ['Milk', 'Wheat'] })
    expect(tidyIngredient('1 tsp Hot Sauce y').text).toBe('1 tsp Hot Sauce')
    expect(tidyIngredient('*Baking sheet').text).toBe('Baking sheet')
    expect(tidyIngredient('1 Eggplant').text).toBe('1 Eggplant')
  })
  it('equipment and pantry staples, however they’re written', () => {
    expect(isEquipment('*Baking sheet')).toBe(true)
    expect(isEquipment('2 Small bowls')).toBe(true)
    expect(isEquipment('2 Small onions')).toBe(false)
    expect(isPantry('Kosher salt')).toBe(true)
    expect(isPantry('Black pepper')).toBe(true)
    expect(isPantry('1 tsp salt')).toBe(false)
    expect(isPantry('Bell pepper')).toBe(false)
  })
  it('steps in the card’s order, without its numbers', () => {
    expect(inCardOrder(['4 COOK VEGGIES: Heat oil.', '5 SIMMER TAGINE: Add water.', '2 COOK RICE: Heat a pot.', '1 PREP: Wash.', '3 MIX: Combine.'])).toEqual([
      'PREP: Wash.',
      'COOK RICE: Heat a pot.',
      'MIX: Combine.',
      'COOK VEGGIES: Heat oil.',
      'SIMMER TAGINE: Add water.',
    ])
    expect(inCardOrder(['Heat oil.', 'Add 2 eggs.'])).toEqual(['Heat oil.', 'Add 2 eggs.'])
  })
  it('a name in capitals, in title case', () => {
    expect(titleCase('APRICOT, ALMOND & CHICKPEA TAGINE WITH ZUCCHINI, BASMATI RICE AND CHERMOULA')).toBe('Apricot, Almond & Chickpea Tagine with Zucchini, Basmati Rice and Chermoula')
    expect(titleCase('Lemon Thyme Pork')).toBe('Lemon Thyme Pork')
  })
  it('two amounts with the bar not read', () => {
    expect(splitColumns('½ oz Parsley | ¼ oz Parsley')).toEqual({ first: '½ oz', other: '¼ oz', name: 'Parsley' })
    expect(splitColumns('1 Clove Garlic | 2 Cloves Garlic')).toEqual({ first: '1 Clove', other: '2 Cloves', name: 'Garlic' })
    expect(splitColumns('1 Lemon | 2 Limes')).toBeNull()
    expect(splitColumns('Italian Seasoning 1 TBSP 1 TBSP')).toEqual({ first: '1 TBSP', other: '1 TBSP', name: 'Italian Seasoning' })
    expect(splitColumns('Bake 2 cups 350 degrees')).toBeNull()
  })

  it('amounts after the name, as in the card’s table, and bars read as letters or ones', () => {
    expect(splitColumns('Jasmine Rice ½ Cup | 1 Cup')).toEqual({ first: '½ Cup', other: '1 Cup', name: 'Jasmine Rice' })
    expect(splitColumns('Pork Cutlets* 12 oz | 24 oz')).toEqual({ first: '12 oz', other: '24 oz', name: 'Pork Cutlets*' })
    expect(splitColumns('Zucchini 112')).toEqual({ first: '1', other: '2', name: 'Zucchini' })
    expect(splitColumns('Thyme ¼ Oz I¼ Oz')).toEqual({ first: '¼ Oz', other: '¼ Oz', name: 'Thyme' })
    expect(splitColumns('Lemon 1|2')).toEqual({ first: '1', other: '2', name: 'Lemon' })
    expect(fixBars('Bake at 425 degrees')).toBe('Bake at 425 degrees')
    expect(fixBars('Chicken Stock Concentrate 113')).toBe('Chicken Stock Concentrate 113')
    expect(splitColumns('Sour Cream')).toBeNull()
  })

  it('amounts for 2 and 4 people: the first, the other kept apart', () => {
    expect(splitColumns('2 TBSP | 4 TBSP • Sour Cream')).toEqual({ first: '2 TBSP', other: '4 TBSP', name: 'Sour Cream' })
    expect(splitColumns('12 oz | 24 oz • Pork Cutlets*')).toEqual({ first: '12 oz', other: '24 oz', name: 'Pork Cutlets*' })
    expect(splitColumns('1|2 • Lemon')).toEqual({ first: '1', other: '2', name: 'Lemon' })
    expect(splitColumns('½ Cup | 1 Cup • Jasmine Rice')).toEqual({ first: '½ Cup', other: '1 Cup', name: 'Jasmine Rice' })
    expect(splitColumns('(Contains: Milk) • Butter (1 TBSP | 2 TBSP)')).toEqual({ first: '1 TBSP', other: '2 TBSP', name: 'Butter' })
    expect(splitColumns('Vegetable oil (2 tsp | 2 tsp)')).toEqual({ first: '2 tsp', other: '2 tsp', name: 'Vegetable oil' })
    expect(splitColumns('10 oz Ground Beef')).toBeNull()
  })
  it('equipment isn’t an ingredient', () => {
    for (const t of ['Large pan', 'Paper towels', 'Baking sheet', 'Small pot', 'Mixing bowl']) expect(isEquipment(t), t).toBe(true)
    for (const t of ['Zucchini', 'Kosher salt', 'Black pepper', '1 pot of stock', 'Lemon']) expect(isEquipment(t), t).toBe(false)
  })
})

describe('a note from photos of pages', () => {
  const photo = (n: string) => {
    const id = `pg${n}00000000000000`.slice(0, 16)
    app.store.putAttachment({ id, mime: 'image/png', name: `${n}.png`, size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
    return id
  }

  it('joins lines broken by the page back into paragraphs', () => {
    expect(reflow('The trail begins at the north\nparking lot and climbs steadily\nthrough the pines.\n\n- Water\n- Map')).toBe(
      'The trail begins at the north parking lot and climbs steadily through the pines.\n\n- Water\n- Map',
    )
    expect(reflow('a hyphen-\nated word')).toBe('a hyphenated word')
    expect(reflow('Milk\nEggs')).toBe('Milk\nEggs')
  })

  it('takes the layout only when the words are the same', () => {
    const read = 'Turn left at the big oak.\nWalk 0.5 miles to the creek.'
    expect(sameWords(read, '# Turn left\n\n1. Turn left at the big oak.\n2. Walk 0.5 miles to the creek.')).toBe(true)
    // a number changed, a sentence dropped, words added
    expect(sameWords(read, '1. Turn left at the big oak.\n2. Walk 0.7 miles to the creek.')).toBe(false)
    expect(sameWords(read, '1. Turn left at the big oak.')).toBe(false)
    expect(sameWords(read, '1. Turn left at the big oak, a lovely ancient tree loved by visitors and squirrels alike.\n2. Walk 0.5 miles to the creek.')).toBe(false)
  })

  it('directions over two pages: numbered in order, the photos kept', async () => {
    const a = photo('dir1')
    const b = photo('dir2')
    const p1 = 'Cedar Falls Loop\nDistance: 3.2 miles\nFrom the trailhead kiosk, take the\nright fork. Cross the footbridge.'
    const p2 = 'At the junction turn left onto the\nRidge Trail. Follow it 1.1 miles to the falls.'
    reply = '# Cedar Falls Loop\n\n- Distance: 3.2 miles\n\n1. From the trailhead kiosk, take the right fork.\n2. Cross the footbridge.\n3. At the junction turn left onto the Ridge Trail.\n4. Follow it 1.1 miles to the falls.'
    const r = await notesFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: a, text: p1 }, { attachmentId: b, text: p2 }], 'directions', null)
    expect(prompts.at(-1)).toContain('directions')
    expect(prompts.at(-1)).toContain('--- Page 2 ---')
    expect(r.title).toBe('Cedar Falls Loop')
    expect(r.asRead).toBe(false)
    const md = text(r.noteId)
    expect(md).toMatch(/^# Cedar Falls Loop\n/)
    expect(md.match(/# Cedar Falls Loop/g)).toHaveLength(1)
    expect(md).toContain('4. Follow it 1.1 miles to the falls.')
    expect(md).toContain('## The original')
    expect((getContent(app.sync.getDoc(noteDocName(r.noteId))!).toString().match(/<image /g) ?? []).length).toBe(2)
  })

  it('a general note: the text laid out plainly', async () => {
    const a = photo('gen1')
    reply = '# Whiteboard\n\n- Ship the release on Friday\n- Ask Pat about the budget'
    const r = await notesFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: a, text: 'Whiteboard\n- Ship the release on Friday\n- Ask Pat about the budget' }], 'general', null)
    expect(prompts.at(-1)).toContain('plain Markdown note')
    expect(r.asRead).toBe(false)
    expect(text(r.noteId)).toMatch(/^# Whiteboard\n[\s\S]*- Ask Pat about the budget/)
  })

  it('a layout that changes the words: kept as read', async () => {
    const a = photo('book1')
    reply = '# Chapter One\n\nIt was a dark and stormy night, and the wind howled terribly across the moors.'
    const r = await notesFromPhotos(app.store, app.sync, app.ai, [{ attachmentId: a, text: 'It was a bright cold day in April, and\nthe clocks were striking thirteen.' }], 'printed', null)
    expect(r.asRead).toBe(true)
    const md = text(r.noteId)
    expect(md).toContain('It was a bright cold day in April, and the clocks were striking thirteen.')
    expect(md).not.toContain('stormy')
    expect(md).toContain('kept as read')
  })
})

describe('photos whose kind is worked out (Auto)', () => {
  it('a recipe or a route is plain from the words', () => {
    expect(kindFromWords('INGREDIENTS\n2 tbsp butter\n1 cup rice\nPreheat oven. Stir in the chopped thyme, simmer, season.')).toBe('recipe')
    expect(kindFromWords('From the trailhead parking, turn left at the junction. After 0.5 miles bear right at the fork toward the ridge and summit.')).toBe('directions')
    expect(kindFromWords('Dear Sam, thanks for the lovely weekend.')).toBeNull()
  })
  it('the kind named in a model’s reply', () => {
    expect(kindIn('HANDWRITING')).toBe('handwriting')
    expect(kindIn('<think>maybe a recipe?</think>\nIt is PRINTED.')).toBe('printed')
    expect(kindIn('recipe or printed')).toBeNull()
    expect(kindIn('no idea')).toBeNull()
  })
  it('otherwise the AI says, from the text (a general note when it can’t tell)', async () => {
    const id = 'guessphoto000001'
    app.store.putAttachment({ id, mime: 'image/png', name: 'p.png', size: 3, created_at: Date.now() }, Buffer.from('png'), 'skipped')
    reply = 'HANDWRITING'
    expect(await guessKind(app.store, app.ai, [{ attachmentId: id }], 'Call mum about Sunday\nbuy stamps')).toEqual({ kind: 'handwriting', by: 'the text' })
    expect(prompts.at(-1)).toContain('Call mum about Sunday')
    reply = 'not sure'
    expect((await guessKind(app.store, app.ai, [{ attachmentId: id }], 'Chapter one')).kind).toBe('general')
    reply = 'OTHER'
    expect((await guessKind(app.store, app.ai, [{ attachmentId: id }], 'Parking permit 2026')).kind).toBe('general')
  })
})
