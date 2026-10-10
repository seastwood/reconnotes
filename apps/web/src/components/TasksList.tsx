import { refuseIfReadOnly } from '../lib/readOnly'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { findTextFor } from '../lib/findText'
import { Repeat as RepeatIcon } from 'lucide-react'
import { formatDue, daysUntil, REPEAT_LABELS, type Repeat } from '@reconnotes/core'
import { apiUrl, authHeaders, isSyncConfigured } from '../lib/settings'
import { useFolderAccess } from '../lib/folderLock'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { showToast } from '../lib/toast'

interface Task {
  noteId: string
  title: string
  folder: string[]
  noteUpdatedAt: number
  i: number
  text: string
  done: boolean
  due?: string
  repeat?: Repeat | null
}

// the last list while the app is open: shown at once when you come back
let last: { key: string; tasks: Task[] } | null = null

/**
 * Tasks: every checklist item in every note (also the ones your AI wrote –
 * meeting action items, extracted to-dos), grouped by note. Tick them here.
 * Read by your server from the notes themselves.
 */
export function TasksList({ activeNoteId, onOpen }: { activeNoteId: string | null; onOpen: (noteId: string, find?: string) => void }) {
  const [state, setStateRaw] = useState<'open' | 'done'>(() => safeLocalGet('reconnotes.tasksState', 'open'))
  const setState = (s: 'open' | 'done') => (setStateRaw(s), safeLocalSet('reconnotes.tasksState', s))
  const unlocked = useFolderAccess().unlockedIds.join(',')
  const key = `${state}|${unlocked}`
  const [tasks, setTasks] = useState<Task[] | null>(() => (last?.key === key ? last.tasks : null))
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isSyncConfigured()) return setError('Tasks are gathered by your ReconNotes server – connect one in Settings.')
    try {
      const r = await fetch(apiUrl(`/api/tasks?state=${state}&unlocked=${encodeURIComponent(unlocked)}`), { headers: authHeaders() })
      if (!r.ok) throw new Error(`The server said ${r.status}`)
      const list = ((await r.json()) as { tasks: Task[] }).tasks
      last = { key, tasks: list }
      setTasks(list)
      setError(null)
    } catch (e) {
      setError(`Couldn’t get your tasks: ${(e as Error).message}`)
    }
  }, [state, unlocked, key])

  useEffect(() => {
    setTasks(last?.key === key ? last.tasks : null)
    void load()
    // fresh when you come back to the app, and now and then while it's open
    const onShow = () => !document.hidden && void load()
    document.addEventListener('visibilitychange', onShow)
    const t = setInterval(onShow, 30_000)
    return () => (document.removeEventListener('visibilitychange', onShow), clearInterval(t))
  }, [key, load])

  const toggle = async (t: Task) => {
    if (refuseIfReadOnly(t.noteId)) return
    // gone from this list straight away (a repeating one comes back with its next date)
    setTasks((cur) => cur?.filter((x) => !(x.noteId === t.noteId && x.i === t.i)) ?? cur)
    try {
      const r = await fetch(apiUrl('/api/tasks/done'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ noteId: t.noteId, i: t.i, text: t.text, done: !t.done }),
      })
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `The server said ${r.status}`)
      if (t.repeat && !t.done) showToast('Done – it moves to its next date')
    } catch (e) {
      showToast((e as Error).message)
    }
    void load()
  }

  // grouped by note, the most recently edited first; dated ones first within a note
  const groups = useMemo(() => {
    const by = new Map<string, Task[]>()
    for (const t of tasks ?? []) by.set(t.noteId, [...(by.get(t.noteId) ?? []), t])
    return [...by.values()]
      .sort((a, b) => b[0].noteUpdatedAt - a[0].noteUpdatedAt)
      .map((list) => list.sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9') || a.i - b.i))
  }, [tasks])

  const switcher = (
    <li className="due-mode">
      <div className="segmented" role="tablist">
        <button className={state === 'open' ? 'on' : ''} onClick={() => setState('open')} role="tab" aria-selected={state === 'open'}>
          To do
        </button>
        <button className={state === 'done' ? 'on' : ''} onClick={() => setState('done')} role="tab" aria-selected={state === 'done'}>
          Done
        </button>
      </div>
    </li>
  )
  if (error && !tasks)
    return (
      <>
        {switcher}
        <li className="empty-hint">{error}</li>
      </>
    )
  if (!tasks) return switcher
  if (!tasks.length)
    return (
      <>
        {switcher}
        <li className="empty-hint">{state === 'open' ? 'Nothing to do. Checklist items from all your notes show up here.' : 'Nothing ticked off yet.'}</li>
      </>
    )
  return (
    <>
      {switcher}
      {groups.map((list) => (
        <li key={list[0].noteId} className="due-group">
          <div className={`due-group-label tasks-note${list[0].noteId === activeNoteId ? ' current' : ''}`} title={list[0].noteId === activeNoteId ? 'The note that’s open' : undefined} onClick={() => onOpen(list[0].noteId)}>
            {list[0].title || 'Untitled'}
            {list[0].folder.length > 0 && <span className="muted"> · {list[0].folder.join(' › ')}</span>}
          </div>
          <ul>
            {list.map((t) => (
              <li key={`${t.i}|${t.text}`} className={`note-row due-row${t.done ? ' done' : ''}`} onClick={() => onOpen(t.noteId, findTextFor(t.text))}>
                <input type="checkbox" checked={t.done} aria-label={t.done ? 'Mark not done' : 'Mark done'} onClick={(e) => e.stopPropagation()} onChange={() => void toggle(t)} />
                <div>
                  <div className="note-title">{t.text}</div>
                  {t.due && (
                    <div className={`note-snippet${!t.done && daysUntil(t.due) < 0 ? ' overdue' : ''}`}>
                      {formatDue(t.due)}
                      {t.repeat && <RepeatIcon size={11} className="due-repeat" aria-label={REPEAT_LABELS[t.repeat]} />}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  )
}
