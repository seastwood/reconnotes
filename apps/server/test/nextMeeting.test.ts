import { describe, expect, it } from 'vitest'
import { addNextMeeting, nextMeetingIn } from '../src/meetingNotes'
import { dueDateIn } from '../src/timeRange'

// Wednesday 14 October 2026, noon UTC
const now = Date.UTC(2026, 9, 14, 12)
const due = (t: string) => dueDateIn(t, now, 0)

describe('the next meeting, from what was said', () => {
  it('finds the one agreed on', () => {
    expect(nextMeetingIn('Good progress. Speaker 1: Let’s meet again next Thursday to review.', due, '2026-10-14')).toEqual({ text: 'Let’s meet again next Thursday to review.', date: '2026-10-22' })
    expect(nextMeetingIn("We'll catch up on Friday. Actually, let's sync on Monday instead.", due, '2026-10-14')?.date).toBe('2026-10-19')
  })
  it('leaves out meetings that happened, and ones with no day', () => {
    expect(nextMeetingIn('At the last meeting on Monday we agreed the budget.', due, '2026-10-14')).toBeNull()
    expect(nextMeetingIn("We should meet again soon.", due, '2026-10-14')).toBeNull()
    expect(nextMeetingIn('The report is due on Friday.', due, '2026-10-14')).toBeNull()
  })
  it('puts it under Action items', () => {
    const md = '## Summary\n\nStuff.\n\n## Action items\n\n- [ ] Sam: send the deck\n\n## Open questions\n\n- Budget?'
    expect(addNextMeeting(md, { date: '2026-10-22' })).toBe('## Summary\n\nStuff.\n\n## Action items\n\n- [ ] Sam: send the deck\n- [ ] Next meeting !2026-10-22\n\n## Open questions\n\n- Budget?')
    expect(addNextMeeting('## Action items\n\n- [ ] No action items', { date: '2026-10-22' })).toBe('## Action items\n\n- [ ] Next meeting !2026-10-22')
    const already = '## Action items\n\n- [ ] Book the follow-up meeting !2026-10-22'
    expect(addNextMeeting(already, { date: '2026-10-22' })).toBe(already)
  })
})
