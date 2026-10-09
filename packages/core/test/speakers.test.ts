import { describe, expect, it } from 'vitest'
import { encodeSpeakers, mergeMinorVoices, labelledTranscript, parseSpeakerNames, parseSpeakers, speakerAt, speakerTurns, voiceCount } from '../src/speakers'

const seg = [
  { start: 0.3, end: 3.0, speaker: 0 },
  { start: 3.4, end: 6.0, speaker: 1 },
  { start: 6.2, end: 8.0, speaker: 0 },
]
const words = 'Jesse, what is this sample testing? It is a code requirement. Okay, thanks.'
  .split(' ')
  .map((word, i) => ({ word, start: 0.4 + i * 0.6, end: 0.4 + i * 0.6 + 0.5 }))

describe('who said what', () => {
  it('gives each word its speaker and groups them into turns', () => {
    const turns = speakerTurns(words, seg)
    expect(turns.map((t) => t.speaker)).toEqual([0, 1, 0])
    expect(turns[0].text).toBe('Jesse, what is this sample')
    expect(turns[1].text).toBe('testing? It is a code')
    expect(voiceCount(turns)).toBe(2)
  })
  it('writes the transcript as named turns – "Speaker N" where no name was given', () => {
    const turns = speakerTurns(words, seg)
    expect(labelledTranscript(turns, { 1: 'Jesse' })).toBe('Speaker 1: Jesse, what is this sample\nJesse: testing? It is a code\nSpeaker 1: requirement. Okay, thanks.')
  })
  it('a word in a pause goes to the nearest turn within a second', () => {
    expect(speakerAt(seg, 3.1, 3.3)).toBe(0)
    expect(speakerAt(seg, 20, 21)).toBeNull()
  })
  it('keeps the turns and names compactly in the note', () => {
    expect(parseSpeakers(encodeSpeakers(seg))).toEqual(seg)
    expect(parseSpeakers('nonsense')).toBeNull()
    expect(parseSpeakerNames('{"0":"Seth","1":" ","x":"y"}')).toEqual({ 0: 'Seth' })
  })
})

describe('the people at a meeting', () => {
  it('reads the Attendees line, however it is written', async () => {
    const { attendeeNames } = await import('../src/speakers')
    expect(attendeeNames('# Meeting\n\nAttendees: Seth, Jesse and Paul\n\n## Notes')).toEqual(['Seth', 'Jesse', 'Paul'])
    expect(attendeeNames('**Attendees:** Q; Brandon & Seth')).toEqual(['Q', 'Brandon', 'Seth'])
    expect(attendeeNames('Attendees: ')).toEqual([])
    expect(attendeeNames('No list here')).toEqual([])
  })
})

describe('voices heard for a moment', () => {
  it('fold into the voice around them, and the rest are numbered again', () => {
    const segs = [
      { start: 0, end: 30, speaker: 0 },
      { start: 30.5, end: 31.5, speaker: 5 }, // a cough
      { start: 32, end: 60, speaker: 0 },
      { start: 61, end: 62, speaker: 7 }, // a word from someone passing
      { start: 62.2, end: 120, speaker: 2 },
      { start: 121, end: 160, speaker: 0 },
    ]
    const out = mergeMinorVoices(segs)
    expect(new Set(out.map((s) => s.speaker))).toEqual(new Set([0, 1]))
    // the cough joins the turn around it: one turn from 0 to 60
    expect(out[0]).toEqual({ start: 0, end: 60, speaker: 0 })
    // the passing word goes to the nearer voice (the one right after it)
    expect(out[1]).toEqual({ start: 61, end: 120, speaker: 1 })
    expect(out[2]).toEqual({ start: 121, end: 160, speaker: 0 })
  })

  it('leave a short clip as it is', () => {
    const segs = [
      { start: 0, end: 3, speaker: 0 },
      { start: 3.5, end: 6, speaker: 1 },
    ]
    expect(mergeMinorVoices(segs)).toEqual(segs)
  })
})
