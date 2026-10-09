import { useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { Mic, Users, X } from 'lucide-react'
import { applyMeetingSetup, meetingSetup, meetingStart, recentAttendees, splitNames } from '../lib/meeting'

/**
 * A new meeting's setup, at the top of its note: what it's called, who's there and the agenda –
 * all optional – then Start recording. The names help in three places: Whisper spells them
 * right, the voices in the transcript get their names, and the notes say who said what; an
 * agenda gives the notes their order.
 */
export function MeetingSetup({ noteId, doc, title, onStart }: { noteId: string; doc: Y.Doc; title: string; onStart?: () => void }) {
  const [name, setName] = useState('')
  const [people, setPeople] = useState('')
  const [agenda, setAgenda] = useState('')
  // how many people (no time to name them all): 0 – not said
  const [count, setCount] = useState(0)
  const recent = useMemo(recentAttendees, [])
  const chosen = splitNames(people)
  // never fewer than the names given
  const shown = Math.max(count, chosen.length)
  const add = (n: string) => setPeople((p) => (splitNames(p).includes(n) ? p : [...splitNames(p), n].join(', ')))
  const close = () => meetingSetup.set({ noteId: null })
  const start = (withSetup: boolean) => {
    if (withSetup) applyMeetingSetup(doc, { title: name, attendees: chosen, count: shown, agenda: agenda.split('\n') })
    close()
    // the recording (and what you write) goes under Notes, after the setup
    onStart?.()
    meetingStart.set({ noteId })
  }
  return (
    <div className="meeting-setup" role="form" aria-label="Meeting setup">
      <div className="meeting-setup-head">
        <Users size={16} /> <b>Before you start</b> <span className="muted">– all optional</span>
        <button className="icon" aria-label="Close without recording" title="Close without recording" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <label>
        Meeting
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={title || 'Meeting'} enterKeyHint="next" />
      </label>
      <label>
        Who’s there
        <input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="Seth, Jesse, Paul" autoCapitalize="words" enterKeyHint="next" />
      </label>
      {recent.length > 0 && (
        <div className="meeting-setup-chips">
          {recent.map((n) => (
            <button key={n} className={chosen.includes(n) ? 'on' : ''} onClick={() => add(n)}>
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="meeting-setup-count">
        <span>How many people</span>
        <div className="stepper" role="group" aria-label="How many people">
          <button type="button" aria-label="Fewer" disabled={shown <= Math.max(1, chosen.length)} onClick={() => setCount(shown <= 2 ? 0 : shown - 1)}>
            −
          </button>
          <b aria-live="polite">{shown || 'Not sure'}</b>
          <button type="button" aria-label="More" disabled={shown >= 30} onClick={() => setCount(Math.max(2, shown + 1))}>
            +
          </button>
        </div>
      </div>
      <label>
        Agenda
        <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder={'One topic per line\nGate project\nTractor quote'} rows={3} />
      </label>
      <p className="hint">
        Names are spelled right in the transcript and given to the voices that speak. No time for names? Just say how many – the speaker labels then find that
        many voices. The notes follow the agenda.
      </p>
      <div className="meeting-setup-actions">
        <button className="primary" onClick={() => start(true)}>
          <Mic size={16} /> Start recording
        </button>
        <button onClick={() => start(false)}>Just record</button>
      </div>
    </div>
  )
}
