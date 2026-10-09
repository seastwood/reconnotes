import { describe, expect, it } from 'vitest'
import { pdfSections } from '../src/pdf'
import { figurePdf, makePdf, manualPdf } from './pdfHelper'

describe('a PDF manual', () => {
  it('keeps a rule’s number ("R12.") – it isn’t a list marker', async () => {
    const pdf = makePdf([[[24, '7 Robot Rules'], [11, 'R11. Lubricants may be used only to reduce friction.'], [11, 'R12. BUMPERS are required.'], [11, 'a) a lettered item'], [11, 'b) another one']]])
    const html = (await pdfSections(pdf)).sections[0].html
    expect(html).toContain('R11. Lubricants may be used only to reduce friction.')
    expect(html).toContain('R12. BUMPERS are required.')
    expect(html).toContain('<li>a lettered item</li>')
  })

  it('is split at its chapters, with its sections, lists and paragraphs – without running headers and page numbers', async () => {
    const r = await pdfSections(manualPdf())
    expect(r.pages).toBe(4)
    expect(r.sections.map((s) => s.title)).toEqual(['1 Introduction', '6 Game Rules', '9 Robot Rules'])
    const intro = r.sections[0].html
    expect(intro).toContain('<p>Welcome to the game. Teams build robots to play matches on a field.</p>')
    expect(intro).toContain('<ul><li>Read every rule</li><li>Ask questions in the Q&amp;A</li></ul>')
    const rules = r.sections[1].html
    expect(rules).toMatch(/<h2>6\.1 Fouls<\/h2>/)
    expect(rules).toMatch(/<h2>6\.2 Scoring<\/h2>/)
    // a word hyphenated across lines, and a sentence across a page
    expect(rules).toContain('frame perimeter. Violation: minor foul. This rule continues on the next page with more detail about extension.')
    expect(r.sections[1].pages).toEqual([2, 3])
    for (const s of r.sections) {
      expect(s.html).not.toContain('GAME MANUAL')
      expect(s.html).not.toMatch(/Page \d/)
    }
  })
})

describe('figures', () => {
  it('a drawing under its caption becomes a picture there, its labels out of the text', async () => {
    const { sections } = await pdfSections(figurePdf())
    const html = sections.map((s) => s.html).join('')
    const img = /<img src="data:image\/png;base64,([^"]+)" alt="Figure 8-3 BUMPER coverage requirements">/.exec(html)
    expect(img).toBeTruthy()
    const png = Buffer.from(img![1], 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // between the caption and the next rule, in that order
    expect(html.indexOf('Figure 8-3 BUMPER coverage')).toBeLessThan(html.indexOf('<img'))
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('R402'))
    // the drawing's label is in the picture, not the text
    expect(html).not.toContain('ROBOT PERIMETER')
  })
})
