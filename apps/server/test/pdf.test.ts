import { describe, expect, it } from 'vitest'
import { pdfSections } from '../src/pdf'
import { manualPdf } from './pdfHelper'

describe('a PDF manual', () => {
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
