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
