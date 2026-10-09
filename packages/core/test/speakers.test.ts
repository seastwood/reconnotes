import { describe, expect, it } from 'vitest'
import { encodeSpeakers, labelledTranscript, parseSpeakerNames, parseSpeakers, speakerAt, speakerTurns, voiceCount } from '../src/speakers'

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
