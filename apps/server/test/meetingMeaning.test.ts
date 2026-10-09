import { describe, expect, it } from 'vitest'
import { cosine, cutAt, isMeant, peak, stretches, topicCuts } from '../src/meetingMeaning'
import { listenTimes } from '../src/listen'
import { groundMeetingNotes } from '../src/meetingNotes'
import { meetingParts, meetingPartsByTopic } from '../src/ai'

/** a stand-in for an embedding model: each subject its own direction, plus a little of everything */
const SUBJECTS = ['fence', 'lights', 'dumpster', 'tractor']
const vec = (text: string) => {
  const t = text.toLowerCase()
  const v = SUBJECTS.map((s) => (t.match(new RegExp(s, 'g')) ?? []).length + 0.15)
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0))
  return v.map((x) => x / n)
}

describe('a meeting read by meaning', () => {
  // three subjects: 3,000 characters of fence, 5,500 of lights, 4,500 of the dumpster
  const talk = (subject: string, n: number) => Array.from({ length: n }, (_, i) => `We talked about the ${subject} again, point ${i}.`).join(' ')
  const text = [talk('fence', 75), talk('lights', 135), talk('dumpster', 110)].join('\n')

  it('cuts the parts where the subject changes, not at fixed lengths', () => {
    const parts = stretches(text)
    const cuts = topicCuts(text, parts, parts.map((p) => vec(p.text)), 4500)
    const pieces = cutAt(text, cuts)
    // each subject (nearly) all in one part – cut within a sentence or two of where it changed
    const share = (parts: string[], subject: string) => Math.max(...parts.map((p) => (p.match(new RegExp(subject, 'g')) ?? []).length)) / (text.match(new RegExp(subject, 'g')) ?? []).length
    for (const s of ['fence', 'lights', 'dumpster']) expect(share(pieces, s)).toBeGreaterThan(0.95)
    // fixed lengths cut the lights in two
    expect(share(meetingParts(text, 4500), 'lights')).toBeLessThan(0.8)
    // and the meeting's own entry point gives the same
    const viaMeeting = meetingPartsByTopic(text, 4500, { stretches: parts, vecs: parts.map((p) => vec(p.text)) })
    expect(viaMeeting).toEqual(pieces)
    expect(meetingPartsByTopic(text, 4500, null)).toBeNull()
  })

  it('knows a point that stands out from one that’s like everything', () => {
    expect(peak([0.3, 0.32, 0.8, 0.31])).toMatchObject({ at: 2, best: 0.8 })
    expect(isMeant([0.3, 0.32, 0.8, 0.31])).toBe(true)
    // vague: about as like every stretch
    expect(isMeant([0.6, 0.62, 0.63, 0.61, 0.6])).toBe(false)
    // nothing like anything
    expect(isMeant([0.2, 0.3, 0.25, 0.22])).toBe(false)
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })

  it('places a ▶ link where a point was meant, though worded unlike what was said', () => {
    const words = 'we should put the new bulbs in the shop they are cheaper to run and brighter too okay then the bin comes on tuesday across the road'
      .split(' ')
      .map((w, i) => ({ word: w, start: i * 2, end: i * 2 + 1 }))
    const lines = ['## Decisions', '- Switch to LEDs']
    // no shared words: by words alone, no link
    expect(listenTimes(lines, words)).toEqual([null, null])
    // by meaning: the first stretch (the bulbs), not the second (the bin)
    const byMeaning = { starts: [0, 30], sims: [null, [0.78, 0.31]] }
    expect(listenTimes(lines, words, byMeaning)).toEqual([null, 0])
  })

  it('keeps a point that says what was said in other words – but not one with a name nobody said', () => {
    const transcript = 'We should put the new bulbs in the shop, they are cheaper to run and brighter too. Okay, do it.'
    const made = '## Decisions\n- Switch the shop over to LED lighting for efficiency\n- Margaret approved switching to LED lighting'
    const meant = new Set(['- Switch the shop over to LED lighting for efficiency', '- Margaret approved switching to LED lighting'])
    expect(groundMeetingNotes(made, transcript, '')).not.toContain('LED')
    const out = groundMeetingNotes(made, transcript, '', { meant })
    expect(out).toContain('Switch the shop over to LED lighting')
    expect(out).not.toContain('Margaret')
  })
})

describe('notes in the shape asked for, from what a model actually wrote', async () => {
  const { normalizeMeetingNotes, partTopics } = await import('../src/meetingNotes')
  it('drops the parts’ labels from the Summary, and filler from Open questions', () => {
    const transcript =
      'Let’s get that crate loaded up. Actually, no, don’t load it up. Leave it where it is. Let’s make a space across the road for the dumpster that’s coming up Tuesday. The water meter contractor is getting his box on Tuesday. Maybe put it in the middle of the lot like a dumpster.'
    const made = `## Summary
- **Topic: Crate Loading and Dumpster Space** – Initial plan to load a crate was changed; the crate stays where it is, with space made for a dumpster coming Tuesday. Outcome: Changed (crate not loaded).
- **Topic: Water Meter Box** – The contractor's box comes Tuesday; the middle of the lot was suggested. Outcome: Open.

## Open Questions
- **Water Meter Box**: Where the box goes – the middle of the lot was suggested.
- **Crate Loading**: No action item assigned.
- **Miscellaneous Tasks**: No actionable decisions; small talk omitted.
- **Waste**: No formal task assigned, but informal agreement to handle it.`
    const dropped: string[] = []
    const out = groundMeetingNotes(made, transcript, '', { dropped })
    expect(out).toContain('- **Crate Loading and Dumpster Space**: Initial plan to load a crate was changed')
    expect(out).toContain('Changed (crate not loaded).')
    expect(out).toContain('- **Water Meter Box**: The contractor\'s box comes Tuesday; the middle of the lot was suggested.\n')
    expect(out).not.toMatch(/Topic:|Outcome:/)
    expect(out).toContain('- **Water Meter Box**: Where the box goes')
    expect(out).not.toMatch(/No action item assigned|small talk|No formal task/)
    expect(dropped).toHaveLength(3)
    // as a model wrote them another time: labels without bold, and "unresolved" for every topic
    const t2 =
      'The water meter contractor gets his box on Tuesday. Maybe the middle of the lot, or eight feet off the fence. The toilet piano clutter thing in the bathroom. We should look at the lights in the boiler room, LEDs.'
    const more = groundMeetingNotes(
      `## Open questions
- Bathroom clutter and toilet piano issue: Unresolved.
- Events and gas locates: No formal decision made.
- Boiler room lighting: LED replacement suggested but timing/method unresolved.
- Water meter contractor's box placement: No consensus on exact location; suggestions include the middle of the lot or eight feet from the fence.`,
      t2,
      '',
    )
    expect(more).not.toMatch(/Bathroom clutter|gas locates/)
    expect(more).toContain('Water meter contractor')
    // a statement that something's undecided isn't a question either
    expect(more).not.toContain('Boiler room lighting')

    // this run's list: most of it only named a topic
    const t3 =
      'Johnson Controls or Summit for the maintenance. The water meter box, the middle of the lot or 8 feet off the fence. Air freshener for the press. The crate stays, make space for the dumpster Tuesday. Gas locates.'
    const run = groundMeetingNotes(
      `## Open questions
- Maintenance/service agreement provider (Johnson Controls vs Summit).
- Crate loading task canceled; dumpster space needed by Tuesday.
- Air freshener purchase for press area.
- Event prep and gas locates tasks pending.
- Water meter box placement (middle of lot or 8 ft off fence).

## Action items
- [ ] Unspecified: Make space for the dumpster on Tuesday.`,
      t3,
      '',
    )
    expect(run).toContain('Johnson Controls vs Summit')
    expect(run).toContain('Water meter box placement')
    expect(run).not.toMatch(/Air freshener|gas locates|Crate loading/)
    expect(run).toContain('- [ ] Make space for the dumpster on Tuesday.')
    expect(normalizeMeetingNotes('## Summary\n- **Topic: Gate** – starts Monday')).toBe('## Summary\n- **Gate**: starts Monday')
  })

  it('reads the parts’ topics written as headings with "Details"', () => {
    const part = '#### **Topic: 20-Year Sample Testing of Sprinklers**\n- **Details**: Mentioned as a requirement for quick response sprinklers.\n- **Outcome**: Open.\n\n#### **Topic: Crate Loading**\n- **Details**: The crate stays where it is.'
    expect(partTopics([part])).toEqual([
      { topic: '20-Year Sample Testing of Sprinklers', said: 'Mentioned as a requirement for quick response sprinklers.' },
      { topic: 'Crate Loading', said: 'The crate stays where it is.' },
    ])
  })
})

describe('decisions only for what was agreed', async () => {
  const { keepAgreedDecisions, partOutcomes } = await import('../src/meetingNotes')
  const parts = [
    `#### **Topic: Water Meter Box Placement**
- **Details**: Box comes Tuesday; middle of the lot or 8 ft off the fence suggested.
- **Outcome**: Open: no consensus on the spot.

#### **Topic: Project Start Date**
- **Details**: Starting on the 19th.
- **Outcome**: Agreed: "We're on board for the 19th."`,
    `- Topic: Parking during the gate project
  - Said: park on the west side Tuesday
  - Outcome: Agreed: "Done. You got it."
- Topic: Water meter box placement (continued)
  - Said: the box goes in the elbow
  - Outcome: Agreed: put it in the elbow`,
  ]
  it('reads each part’s topics and how they were left', () => {
    expect(partOutcomes(parts).map((o) => [o.topic, o.outcome])).toEqual([
      ['Water Meter Box Placement', 'open'],
      ['Project Start Date', 'agreed'],
      ['Parking during the gate project', 'agreed'],
      ['Water meter box placement (continued)', 'agreed'],
    ])
  })
  it('leaves out a decision about a topic left open – unless a later part settled it', () => {
    const outcomes = partOutcomes([parts[0]])
    const md = '## Summary\n- x\n\n## Decisions\n- Box placed in the middle of the lot, 8 ft off the fence\n- Start on the 19th\n\n## Action items\n- [ ] y'
    const match = (l: string) => (/box/i.test(l) ? 0 : /19th/.test(l) ? 1 : -1)
    const dropped: string[] = []
    const out = keepAgreedDecisions(md, outcomes, match, dropped)
    expect(out).toContain('## Decisions\n- Start on the 19th')
    expect(out).not.toContain('middle of the lot')
    expect(dropped[0]).toMatch(/^Decisions \(left open in the meeting\)/)
    // the later part settled it: kept
    expect(keepAgreedDecisions(md, partOutcomes(parts), match)).toContain('middle of the lot')
    // nothing agreed left: no Decisions heading
    expect(keepAgreedDecisions('## Decisions\n- Box in the middle of the lot\n\n## Action items\n- [ ] y', outcomes, () => 0)).toBe('## Action items\n- [ ] y')
  })
})
