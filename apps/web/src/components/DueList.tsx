import { useMemo } from 'react'
import { daysUntil, formatDue, noteDocName, setDueDone } from '@reconnotes/core'
import { useWorkspace } from '../lib/workspace'
import { sync } from '../lib/sync'

interface Row {
  noteId: string
  noteTitle: string
  id: string
  date: string
  text: string
  checklist: boolean
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
    setDueDone(handle.doc, dueId, true)
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
  if (!rows.length) return <li className="empty-hint">Nothing due. Type “!friday” (or !tomorrow, !oct 12) in a checklist item to give it a date.</li>
  return (
    <>
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
                      {formatDue(r.date)} · {r.noteTitle}
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
