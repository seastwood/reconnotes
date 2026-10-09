import { describe, expect, it } from 'vitest'
import { addListenLinks, clock, listenTimes, type TimedWord } from '../src/listen'

/** a meeting, a word every 0.4 s */
function said(text: string): TimedWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 }))
}
const filler = (n: number) => Array.from({ length: n }, (_, i) => ['so', 'yeah', 'and', 'then', 'we', 'were', 'talking', 'about', 'stuff'][i % 9]).join(' ')
const meeting = said(
  [
    filler(20),
    'The locates need to keep up with the gas line, call the locate company today before the crew digs.',
    filler(30),
    'For the fence, offset the fence line eight feet away from the garage so the cottage box fits.',
    filler(30),
    'Make space across the road for the dumpster, it comes out Tuesday morning for the delivery.',
    filler(20),
  ].join(' '),
)
const at = (phrase: string) => meeting.findIndex((w, i) => meeting.slice(i, i + phrase.split(' ').length).map((x) => x.word).join(' ') === phrase) * 0.4

describe('listen links on meeting notes', () => {
  it('finds where each point was talked about, in other words than were said', () => {
    const lines = [
      '## Summary',
      '- Locates must keep up with the gas line work',
      '- Fence line offset 8 feet from the garage for the cottage box',
      '',
      '## Action items',
      '- [ ] Clear space across the road for the dumpster by Tuesday !2026-10-13',
      '- [ ] Order pizza for the team',
      '- [ ] We will get that company',
    ]
    const t = listenTimes(lines, meeting)
    expect(t[0]).toBeNull() // a heading
    expect(t[1]!).toBeGreaterThanOrEqual(at('The locates') - 3)
    expect(t[1]!).toBeLessThanOrEqual(at('The locates') + 2)
    expect(t[2]!).toBeGreaterThanOrEqual(at('For the fence') - 3) // not at "gas line", said before it
    expect(t[2]!).toBeLessThanOrEqual(at('fence line eight'))
    expect(t[5]!).toBeGreaterThanOrEqual(at('Make space') - 3)
    expect(t[5]!).toBeLessThanOrEqual(at('Make space across') + 3)
    // never said: no link
    expect(t[6]).toBeNull()
    // only one telling word ("company" – like "we'll get that pasta"), said once: found by it
    expect(t[7]!).toBeGreaterThanOrEqual(at('The locates') - 3)
    expect(t[7]!).toBeLessThanOrEqual(at('locate company'))
  })

  it('puts a ▶ link at the end of each point found – before a due date, which stays last', () => {
    const md = '## Action items\n- [ ] Clear space across the road for the dumpster by Tuesday !2026-10-13\n- [ ] Order pizza for the team\n- No action items.'
    const r = addListenLinks(md, meeting, 'att123')
    const lines = r.markdown.split('\n')
    expect(r.links).toBe(1)
    expect(lines[1]).toMatch(/^- \[ \] Clear space across the road for the dumpster by Tuesday \[▶ \d+:\d\d\]\(listen:att123@\d+\) !2026-10-13$/)
    expect(lines[2]).toBe('- [ ] Order pizza for the team')
    expect(lines[3]).toBe('- No action items.')
  })

  it('writes times like a player does', () => {
    expect(clock(5)).toBe('0:05')
    expect(clock(754)).toBe('12:34')
    expect(clock(3725)).toBe('1:02:05')
  })
})
