import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Repeat as RepeatIcon } from 'lucide-react'
import { isoDate, occurrences, REPEAT_LABELS, type Repeat } from '@reconnotes/core'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { completeDue, daysUntil, formatDue, noteDocName } from '@reconnotes/core'
import { showToast } from '../lib/toast'
import { useWorkspace } from '../lib/workspace'
import { sync } from '../lib/sync'

interface Row {
  noteId: string
  noteTitle: string
  id: string
  date: string
  text: string
  checklist: boolean
  repeat?: Repeat | null
}

const GROUPS: { label: string; test: (days: number) => boolean }[] = [
  { label: 'Overdue', test: (d) => d < 0 },
  { label: 'Today', test: (d) => d === 0 },
  { label: 'Tomorrow', test: (d) => d === 1 },
  { label: 'This week', test: (d) => d > 1 && d < 7 },
  { label: 'Later', test: (d) => d >= 7 },
]

/** Tick a due item's checklist box from the Due list. */
async function complete(noteId: string, dueId: string) {
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    await handle.loaded
    const next = completeDue(handle.doc, dueId)
    if (next) showToast(`Done – next due: ${formatDue(next)}`)
  } finally {
    close()
  }
}

/** Open items with a due date, across every note, soonest first. */
export function DueList({ activeNoteId, onOpen }: { activeNoteId: string | null; onOpen: (noteId: string) => void }) {
  const ws = useWorkspace()
  const rows: Row[] = useMemo(
    () =>
      ws.notes
        .filter((n) => !n.trashedAt && !n.template)
        .flatMap((n) => n.due.filter((d) => !d.done).map((d) => ({ noteId: n.id, noteTitle: n.title || 'Untitled', ...d, checklist: true })))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [ws.notes],
  )
  const [mode, setModeState] = useState<'list' | 'calendar'>(() => safeLocalGet('reconnotes.dueMode', 'list'))
  const setMode = (m: 'list' | 'calendar') => {
    setModeState(m)
    safeLocalSet('reconnotes.dueMode', m)
  }
  const switcher = (
    <li className="due-mode">
      <div className="segmented" role="tablist">
        <button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')} role="tab" aria-selected={mode === 'list'}>
          List
        </button>
        <button className={mode === 'calendar' ? 'on' : ''} onClick={() => setMode('calendar')} role="tab" aria-selected={mode === 'calendar'}>
          Calendar
        </button>
      </div>
    </li>
  )
  if (mode === 'calendar') return <>{switcher}<DueCalendar rows={rows} activeNoteId={activeNoteId} onOpen={onOpen} /></>
  if (!rows.length)
    return (
      <>
        {switcher}
        <li className="empty-hint">Nothing due. Type “!friday” (or !tomorrow, !oct 12, !every monday) in a checklist item to give it a date.</li>
      </>
    )
  return (
    <>
      {switcher}
      {GROUPS.map((g) => {
        const items = rows.filter((r) => g.test(daysUntil(r.date)))
        if (!items.length) return null
        return (
          <li key={g.label} className="due-group">
            <div className={`due-group-label${g.label === 'Overdue' ? ' overdue' : ''}`}>{g.label}</div>
            <ul>
              {items.map((r) => (
                <li key={r.id} className={`note-row due-row${r.noteId === activeNoteId ? ' active' : ''}`} onClick={() => onOpen(r.noteId)}>
                  <input
                    type="checkbox"
                    aria-label="Mark done"
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => void complete(r.noteId, r.id)}
                  />
                  <div>
                    <div className="note-title">{r.text || 'Untitled item'}</div>
                    <div className="note-snippet">
                      {formatDue(r.date)}
                      {r.repeat && <RepeatIcon size={11} className="due-repeat" aria-label={REPEAT_LABELS[r.repeat]} />} · {r.noteTitle}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </>
  )
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 4 + i).toLocaleDateString(undefined, { weekday: 'narrow' }))

/** A month at a time: each day shows what's due (repeating items on every date they come up). */
function DueCalendar({ rows, activeNoteId, onOpen }: { rows: Row[]; activeNoteId: string | null; onOpen: (noteId: string) => void }) {
  const today = isoDate(new Date())
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [picked, setPicked] = useState<string>(today)
  const first = isoDate(month)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const last = isoDate(new Date(month.getFullYear(), month.getMonth(), days))
  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const r of rows) {
      for (const d of occurrences(r.date, r.repeat, first, last)) {
        if (!map.has(d)) map.set(d, [])
        map.get(d)!.push(r)
      }
    }
    return map
  }, [rows, first, last])
  const lead = month.getDay() // Sunday first
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => isoDate(new Date(month.getFullYear(), month.getMonth(), i + 1)))]
  while (cells.length % 7) cells.push(null)
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  const items = byDay.get(picked) ?? []
  return (
    <li className="due-calendar">
      <div className="cal-head">
        <button className="icon" onClick={() => shift(-1)} aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <span className="cal-title">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="icon" onClick={() => shift(1)} aria-label="Next month">
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((w, i) => (
          <span key={`w${i}`} className="cal-wd">
            {w}
          </span>
        ))}
        {cells.map((d, i) =>
          d ? (
            <button
              key={d}
              className={`cal-day${d === today ? ' today' : ''}${d === picked ? ' picked' : ''}${d < today && byDay.has(d) ? ' overdue' : ''}`}
              onClick={() => setPicked(d)}
              aria-label={`${d}${byDay.has(d) ? `, ${byDay.get(d)!.length} due` : ''}`}
            >
              <span>{Number(d.slice(8))}</span>
              {byDay.has(d) && <i className="cal-dots">{'•'.repeat(Math.min(3, byDay.get(d)!.length))}</i>}
            </button>
          ) : (
            <span key={`e${i}`} />
          ),
        )}
      </div>
      <div className="cal-day-label">{formatDue(picked)}</div>
      <ul>
        {items.map((r) => (
          <li key={`${r.id}-${picked}`} className={`note-row due-row${r.noteId === activeNoteId ? ' active' : ''}`} onClick={() => onOpen(r.noteId)}>
            {r.date === picked ? (
              <input type="checkbox" aria-label="Mark done" onClick={(e) => e.stopPropagation()} onChange={() => void complete(r.noteId, r.id)} />
            ) : (
              <RepeatIcon size={15} className="due-repeat" aria-label="Repeats" />
            )}
            <div>
              <div className="note-title">{r.text || 'Untitled item'}</div>
              <div className="note-snippet">
                {r.repeat ? `${REPEAT_LABELS[r.repeat]} · ` : ''}
                {r.noteTitle}
              </div>
            </div>
          </li>
        ))}
        {!items.length && <li className="empty-hint">Nothing due this day.</li>}
      </ul>
    </li>
  )
}
