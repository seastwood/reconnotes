import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Y from 'yjs'
import { findTextFor } from '../lib/findText'
import { AlarmClock, CalendarDays, ChevronLeft, ChevronRight, Plus, Repeat as RepeatIcon } from 'lucide-react'
import { Popover } from './Popover'
import { isoDate, occurrences, REPEAT_LABELS, type Repeat } from '@reconnotes/core'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { refuseIfReadOnly } from '../lib/readOnly'
import { addDueItem, completeDue, createNote, daysUntil, formatDue, formatTime, getContent, getNotes, newId, noteDocName, readNote, setDueDate } from '@reconnotes/core'
import { showToast } from '../lib/toast'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { sync } from '../lib/sync'
import { SubscribeCalendar } from './CalendarDigestSection'

interface Row {
  noteId: string
  noteTitle: string
  id: string
  date: string
  text: string
  checklist: boolean
  repeat?: Repeat | null
  time?: string | null
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
export function DueList({ activeNoteId, onOpen }: { activeNoteId: string | null; onOpen: (noteId: string, find?: string) => void }) {
  const ws = useWorkspace()
  const rows: Row[] = useMemo(
    () =>
      ws.notes
        .filter((n) => !n.trashedAt && !n.template)
        .flatMap((n) => n.due.filter((d) => !d.done).map((d) => ({ noteId: n.id, noteTitle: n.title || 'Untitled', ...d, checklist: true })))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '99').localeCompare(b.time ?? '99')),
    [ws.notes],
  )
  const [mode, setModeState] = useState<'list' | 'week' | 'calendar'>(() => safeLocalGet('reconnotes.dueMode', 'list'))
  const setMode = (m: 'list' | 'week' | 'calendar') => {
    setModeState(m)
    safeLocalSet('reconnotes.dueMode', m)
  }
  const switcher = (
    <li className="due-mode">
      <div className="segmented" role="tablist">
        <button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')} role="tab" aria-selected={mode === 'list'}>
          List
        </button>
        <button className={mode === 'week' ? 'on' : ''} onClick={() => setMode('week')} role="tab" aria-selected={mode === 'week'}>
          Week
        </button>
        <button className={mode === 'calendar' ? 'on' : ''} onClick={() => setMode('calendar')} role="tab" aria-selected={mode === 'calendar'}>
          Month
        </button>
      </div>
    </li>
  )
  if (mode === 'calendar') return <>{switcher}<DueCalendar rows={rows} activeNoteId={activeNoteId} onOpen={onOpen} /></>
  if (mode === 'week') return <>{switcher}<DueWeek rows={rows} activeNoteId={activeNoteId} onOpen={onOpen} /></>
  return <DueGroups rows={rows} switcher={switcher} activeNoteId={activeNoteId} onOpen={onOpen} />
}

/** "Fri 16" */
const shortDay = (date: string) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8))).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })

/** Days to drop an item on (or snooze it to): today, tomorrow, the weekend, next week. */
function soonDays(): { label: string; date: string }[] {
  const t = new Date()
  const at = (n: number) => isoDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n))
  const toSat = (6 - t.getDay() + 7) % 7
  const toMon = (8 - t.getDay()) % 7 || 7
  return [
    { label: 'Today', date: at(0) },
    { label: 'Tomorrow', date: at(1) },
    ...(toSat > 1 ? [{ label: 'This weekend', date: at(toSat) }] : []),
    { label: 'Next week', date: at(toMon) },
  ]
}

/** Put an item off to another day: tomorrow, the weekend, next week or a day you pick. */
function Snooze({ r }: { r: Row }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        className="icon due-snooze"
        aria-label="Snooze"
        title="Put off to another day"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <AlarmClock size={16} />
      </button>
      {open && (
        <Popover anchorRef={btn} align="right" onClose={() => setOpen(false)}>
          <div className="menu-label">Put off to</div>
          {soonDays()
            .filter((d) => d.date !== r.date && d.label !== 'Today')
            .map((d) => (
              <button
                key={d.label}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  void moveDue(r, d.date)
                }}
              >
                {d.label}
                <span className="menu-shortcut">{shortDay(d.date)}</span>
              </button>
            ))}
          <label className="due-snooze-pick" onClick={(e) => e.stopPropagation()}>
            <CalendarDays size={16} /> Pick a day
            <input
              type="date"
              value={r.date}
              aria-label="Pick a day"
              onChange={(e) => {
                if (!e.target.value) return
                setOpen(false)
                void moveDue(r, e.target.value)
              }}
            />
          </label>
        </Popover>
      )}
    </>
  )
}

/** The list: overdue, today, tomorrow, this week, later – drag an item onto a day to move it, or snooze it. */
function DueGroups({ rows, switcher, activeNoteId, onOpen }: { rows: Row[]; switcher: React.ReactNode; activeNoteId: string | null; onOpen: (noteId: string, find?: string) => void }) {
  const drag = useDayDrag((r, date) => void moveDue(r, date))
  const soon = soonDays()
  const dropDate = (label: string) => soon.find((d) => d.label === label)?.date ?? null
  if (!rows.length)
    return (
      <>
        {switcher}
        <li className="empty-hint">Nothing due. Type “!friday” (or !tomorrow, !oct 12, !every monday) in a checklist item to give it a date – and a time after it (“!friday 3pm”) for a reminder then.</li>
      </>
    )
  return (
    <>
      {switcher}
      {/* while an item is dragged: the days it can go to */}
      {drag.dragging &&
        createPortal(
          <div className="due-drop-bar">
            {soon.map((d) => (
              <span key={d.label} data-date={d.date} className={drag.over === d.date ? 'drop-over' : ''}>
                {d.label}
                <small>{shortDay(d.date)}</small>
              </span>
            ))}
          </div>,
          document.body,
        )}
      {drag.layer}
      {GROUPS.map((g) => {
        const items = rows.filter((r) => g.test(daysUntil(r.date)))
        if (!items.length) return null
        return (
          <li key={g.label} className="due-group">
            <div
              className={`due-group-label${g.label === 'Overdue' ? ' overdue' : ''}${dropDate(g.label) && drag.over === dropDate(g.label) ? ' drop-over' : ''}`}
              {...(dropDate(g.label) ? { 'data-date': dropDate(g.label) } : {})}
            >
              {g.label}
            </div>
            <ul>
              {items.map((r) => (
                <li key={r.id} className={`note-row due-row movable${r.noteId === activeNoteId ? ' active' : ''}`} onClick={() => onOpen(r.noteId, findTextFor(r.text))} {...drag.handle(r)}>
                  <input
                    type="checkbox"
                    aria-label="Mark done"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => (refuseIfReadOnly(r.noteId) ? void (e.target.checked = false) : void complete(r.noteId, r.id))}
                  />
                  <div>
                    <div className="note-title">{r.text || 'Untitled item'}</div>
                    <div className="note-snippet">
                      {formatDue(r.date)}
                      {r.time && ` ${formatTime(r.time)}`}
                      {r.repeat && <RepeatIcon size={11} className="due-repeat" aria-label={REPEAT_LABELS[r.repeat]} />} · {r.noteTitle}
                    </div>
                  </div>
                  <Snooze r={r} />
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </>
  )
}

/**
 * A week at a time: each day with what's due (repeating items on each day they come up). Drag an
 * item to another day to move it; tick it done; snooze it. Side by side on a wide screen.
 */
function DueWeek({ rows, activeNoteId, onOpen }: { rows: Row[]; activeNoteId: string | null; onOpen: (noteId: string, find?: string) => void }) {
  const today = isoDate(new Date())
  const [start, setStart] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())
  })
  const box = useRef<HTMLLIElement>(null)
  const [roomy, setRoomy] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoomy(el.clientWidth >= 760))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const days = Array.from({ length: 7 }, (_, i) => isoDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)))
  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const r of rows) for (const d of occurrences(r.date, r.repeat, days[0], days[6])) map.set(d, [...(map.get(d) ?? []), r])
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, days[0]])
  const overdue = rows.filter((r) => r.date < today && days.includes(today))
  const drag = useDayDrag((r, date) => void moveDue(r, date))
  const shift = (n: number) => setStart(new Date(start.getFullYear(), start.getMonth(), start.getDate() + n * 7))
  const thisWeek = days.includes(today)
  const open = (r: Row) => onOpen(r.noteId, findTextFor(r.text))
  const item = (r: Row, d: string) => (
    <li
      key={`${r.id}-${d}`}
      className={`note-row due-row${r.noteId === activeNoteId ? ' active' : ''}${r.date === d ? ' movable' : ''}`}
      onClick={() => open(r)}
      {...(r.date === d ? drag.handle(r) : {})}
    >
      {r.date === d ? (
        <input type="checkbox" aria-label="Mark done" onClick={(e) => e.stopPropagation()} onChange={(e) => (refuseIfReadOnly(r.noteId) ? void (e.target.checked = false) : void complete(r.noteId, r.id))} />
      ) : (
        <RepeatIcon size={15} className="due-repeat" aria-label="Repeats" />
      )}
      <div>
        <div className="note-title">{r.text || 'Untitled item'}</div>
        <div className="note-snippet">
          {r.time ? `${formatTime(r.time)} · ` : ''}
          {r.noteTitle}
        </div>
      </div>
      {r.date === d && <Snooze r={r} />}
    </li>
  )
  return (
    <li ref={box} className={`due-week${roomy ? ' roomy' : ''}${drag.dragging ? ' dragging' : ''}`}>
      <div className="cal-head">
        <button className="icon" onClick={() => shift(-1)} aria-label="Previous week">
          <ChevronLeft size={18} />
        </button>
        <span className="cal-title">
          {new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – {new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
        {!thisWeek && (
          <button
            className="text cal-today"
            onClick={() => {
              const d = new Date()
              setStart(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()))
            }}
          >
            This week
          </button>
        )}
        <button className="icon" onClick={() => shift(1)} aria-label="Next week">
          <ChevronRight size={18} />
        </button>
      </div>
      {overdue.length > 0 && (
        <div className="week-overdue">
          <div className="due-group-label overdue">Overdue</div>
          <ul>{overdue.map((r) => item(r, r.date))}</ul>
        </div>
      )}
      <div className="week-days">
        {days.map((d) => {
          const here = byDay.get(d) ?? []
          const dt = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8)))
          return (
            <section key={d} data-date={d} className={`week-day${d === today ? ' today' : ''}${d < today ? ' past' : ''}${drag.over === d ? ' drop-over' : ''}`}>
              <div className="week-day-head">
                <span className="week-wd">{dt.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <span className="week-num">{dt.getDate()}</span>
              </div>
              <ul>{here.map((r) => item(r, d))}</ul>
              {!here.length && <div className="week-empty">{roomy ? '' : 'Nothing due'}</div>}
            </section>
          )
        })}
      </div>
      {drag.layer}
      <SubscribeCalendar />
    </li>
  )
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 4 + i).toLocaleDateString(undefined, { weekday: 'narrow' }))

/** Move a due item to another day (a repeating one: its series starts there) – with Undo. */
async function moveDue(r: Row, date: string) {
  if (date === r.date || refuseIfReadOnly(r.noteId)) return
  const set = async (to: string) => {
    const { handle, close } = sync.open(noteDocName(r.noteId))
    try {
      await handle.loaded
      return setDueDate(handle.doc, r.id, to)
    } finally {
      close()
    }
  }
  if (await set(date)) showToast(`Moved to ${formatDue(date)}`, () => void set(r.date))
}

/** A new to-do due on `date`, in the "To-dos" note (made the first time). */
async function addTodo(text: string, date: string) {
  const notes = getNotes(workspaceDoc)
  let id: string | null = null
  notes.forEach((m, k) => {
    const n = readNote(m)
    if (!id && !n.trashedAt && !n.template && /^to-?dos$/i.test(n.title.trim())) id = k
  })
  const made = !id
  if (!id) id = createNote(workspaceDoc, { folderId: null, title: 'To-dos' })
  const { handle, close } = sync.open(noteDocName(id))
  try {
    await handle.loaded
    if (made) {
      const title = new Y.XmlElement('paragraph')
      title.insert(0, [new Y.XmlText('To-dos')])
      getContent(handle.doc).insert(0, [title])
    }
    addDueItem(handle.doc, text, date, newId())
  } finally {
    close()
  }
  showToast(`Added to To-dos, due ${formatDue(date)}`)
}

/**
 * Dragging due items onto another day: a mouse drags straight away; a finger holds a moment first
 * (so a swipe still scrolls). The day under it lights up; let go on one and the item moves there.
 */
function useDayDrag(onDrop: (r: Row, date: string) => void) {
  const [over, setOver] = useState<string | null>(null)
  const [ghost, setGhost] = useState<{ text: string; x: number; y: number } | null>(null)
  const swallowClick = useRef(false)
  const dayAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-date]') as HTMLElement | null)?.dataset.date ?? null
  const begin = (r: Row, x0: number, y0: number, touch: boolean) => {
    let dragging = false
    let hold: ReturnType<typeof setTimeout> | null = null
    const go = (x: number, y: number) => {
      dragging = true
      swallowClick.current = true
      navigator.vibrate?.(10)
      setGhost({ text: r.text || 'Untitled item', x, y })
      setOver(dayAt(x, y))
    }
    const moveTo = (x: number, y: number) => {
      setGhost((g) => (g ? { ...g, x, y } : g))
      setOver(dayAt(x, y))
    }
    const finish = (x: number, y: number) => {
      if (hold) clearTimeout(hold)
      cleanup()
      setGhost(null)
      setOver(null)
      if (!dragging) return void (swallowClick.current = false)
      const day = dayAt(x, y)
      if (day) onDrop(r, day)
      setTimeout(() => (swallowClick.current = false), 50)
    }
    const mm = (e: MouseEvent) => {
      if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) > 5) go(e.clientX, e.clientY)
      else if (dragging) moveTo(e.clientX, e.clientY)
    }
    const mu = (e: MouseEvent) => finish(e.clientX, e.clientY)
    const tm = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      if (!dragging) {
        // moved before the hold: it's a scroll
        if (Math.hypot(t.clientX - x0, t.clientY - y0) > 8) finish(t.clientX, t.clientY)
        return
      }
      e.preventDefault()
      moveTo(t.clientX, t.clientY)
    }
    const te = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      if (dragging) e.preventDefault()
      finish(t?.clientX ?? x0, t?.clientY ?? y0)
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', mu)
      window.removeEventListener('touchmove', tm)
      window.removeEventListener('touchend', te)
      window.removeEventListener('touchcancel', te)
    }
    if (touch) {
      hold = setTimeout(() => go(x0, y0), 300)
      window.addEventListener('touchmove', tm, { passive: false })
      window.addEventListener('touchend', te, { passive: false })
      window.addEventListener('touchcancel', te)
    } else {
      window.addEventListener('mousemove', mm)
      window.addEventListener('mouseup', mu)
    }
  }
  /** what makes an item draggable */
  const handle = (r: Row) => ({
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input, button')) return
      e.preventDefault()
      begin(r, e.clientX, e.clientY, false)
    },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t || e.touches.length !== 1 || (e.target as HTMLElement).closest('input, button')) return
      begin(r, t.clientX, t.clientY, true)
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (swallowClick.current) {
        e.stopPropagation()
        e.preventDefault()
      }
    },
  })
  const layer = ghost
    ? createPortal(
        <div className="due-drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.text}
        </div>,
        document.body,
      )
    : null
  return { over, handle, layer, dragging: Boolean(ghost) }
}

/**
 * A month at a time: each day shows what's due (repeating items on every date they come up) – on a
 * wide screen as the items themselves. Drag an item to another day to move it (or pick its date);
 * tick it done; add a to-do to the day you picked.
 */
function DueCalendar({ rows, activeNoteId, onOpen }: { rows: Row[]; activeNoteId: string | null; onOpen: (noteId: string, find?: string) => void }) {
  const today = isoDate(new Date())
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [picked, setPicked] = useState<string>(today)
  // room for the items themselves in each day (else dots)
  const box = useRef<HTMLLIElement>(null)
  const [roomy, setRoomy] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoomy(el.clientWidth >= 620))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
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
  const drag = useDayDrag((r, date) => {
    setPicked(date)
    void moveDue(r, date)
  })
  const lead = month.getDay() // Sunday first
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => isoDate(new Date(month.getFullYear(), month.getMonth(), i + 1)))]
  while (cells.length % 7) cells.push(null)
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  const items = byDay.get(picked) ?? []
  const [adding, setAdding] = useState('')
  const open = (r: Row) => onOpen(r.noteId, findTextFor(r.text))
  return (
    <li ref={box} className={`due-calendar${roomy ? ' roomy' : ''}${drag.dragging ? ' dragging' : ''}`}>
      <div className="cal-head">
        <button className="icon" onClick={() => shift(-1)} aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <span className="cal-title">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        {(month.getFullYear() !== new Date().getFullYear() || month.getMonth() !== new Date().getMonth()) && (
          <button className="text cal-today" onClick={() => (setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), setPicked(today))}>
            Today
          </button>
        )}
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
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />
          const here = byDay.get(d) ?? []
          return (
            <div
              key={d}
              role="button"
              tabIndex={0}
              data-date={d}
              className={`cal-day${d === today ? ' today' : ''}${d === picked ? ' picked' : ''}${d < today && here.length ? ' overdue' : ''}${drag.over === d ? ' drop-over' : ''}`}
              onClick={() => setPicked(d)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setPicked(d)}
              aria-label={`${d}${here.length ? `, ${here.length} due` : ''}`}
            >
              <span className="cal-num">{Number(d.slice(8))}</span>
              {roomy ? (
                <span className="cal-chips">
                  {here.slice(0, 3).map((r) => (
                    <span
                      key={r.id}
                      className={`cal-chip${r.date !== d ? ' repeat' : ''}${d < today ? ' overdue' : ''}`}
                      title={`${r.text} – ${r.noteTitle}${r.date === d ? ' (drag to another day to move it)' : ''}`}
                      onClick={(e) => (e.stopPropagation(), open(r))}
                      {...(r.date === d ? drag.handle(r) : {})}
                    >
                      {r.repeat && <RepeatIcon size={10} />} {r.time && <b>{formatTime(r.time)}</b>} {r.text || 'Untitled item'}
                    </span>
                  ))}
                  {here.length > 3 && <span className="cal-more">+{here.length - 3} more</span>}
                </span>
              ) : (
                here.length > 0 && <i className="cal-dots">{'•'.repeat(Math.min(3, here.length))}</i>
              )}
            </div>
          )
        })}
      </div>
      <div className="cal-day-label">{formatDue(picked)}</div>
      <ul>
        {items.map((r) => (
          <li
            key={`${r.id}-${picked}`}
            className={`note-row due-row${r.noteId === activeNoteId ? ' active' : ''}${r.date === picked ? ' movable' : ''}`}
            onClick={() => open(r)}
            {...(r.date === picked ? drag.handle(r) : {})}
          >
            {r.date === picked ? (
              <input type="checkbox" aria-label="Mark done" onClick={(e) => e.stopPropagation()} onChange={(e) => (refuseIfReadOnly(r.noteId) ? void (e.target.checked = false) : void complete(r.noteId, r.id))} />
            ) : (
              <RepeatIcon size={15} className="due-repeat" aria-label="Repeats" />
            )}
            <div>
              <div className="note-title">{r.text || 'Untitled item'}</div>
              <div className="note-snippet">
                {r.time ? `${formatTime(r.time)} · ` : ''}
                {r.repeat ? `${REPEAT_LABELS[r.repeat]} · ` : ''}
                {r.noteTitle}
              </div>
            </div>
            {r.date === picked && (
              <label className="due-move" title="Move to another day" onClick={(e) => e.stopPropagation()}>
                <CalendarDays size={16} />
                <input type="date" value={r.date} aria-label="Due date" onChange={(e) => e.target.value && void moveDue(r, e.target.value)} />
              </label>
            )}
          </li>
        ))}
        {!items.length && <li className="empty-hint">Nothing due this day.</li>}
        <li className="due-add">
          <Plus size={16} />
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adding.trim()) {
                void addTodo(adding, picked)
                setAdding('')
              }
            }}
            placeholder={`Add a to-do for ${formatDue(picked)}…`}
            aria-label="Add a to-do for this day"
          />
        </li>
      </ul>
      <SubscribeCalendar />
      {drag.layer}
    </li>
  )
}
