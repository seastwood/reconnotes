import crypto from 'node:crypto'
import * as Y from 'yjs'
import { WORKSPACE_DOC, completeDue, extractTasks, getContent, listFolders, folderPaths, effectiveFolderId, noteDocName, setTaskDone, type Repeat, type TaskItem } from '@reconnotes/core'
import type { Store } from './store'
import type { SyncEngine } from './sync'

/**
 * Tasks across all notes
 * ======================
 *
 * Every checklist item in every note, read from the notes themselves (so the
 * ones the AI wrote – meeting action items, extracted to-dos – are there
 * too, even before a device opened that note). Kept per note until the note
 * changes, so asking again is quick on a big library.
 */

export interface NoteTask extends TaskItem {
  noteId: string
  title: string
  /** the folder path, e.g. ["FRC", "Pit crew"] */
  folder: string[]
  noteUpdatedAt: number
}

export class Tasks {
  private cache = new Map<string, { at: number; tasks: TaskItem[] }>()

  constructor(
    private store: Store,
    private sync: SyncEngine,
  ) {}

  /** Every task (or only open ones) in the notes `allowed` lets through. */
  list(allowed: (noteId: string) => boolean, opts: { done?: boolean } = {}): NoteTask[] {
    const meta = this.sync.noteMeta()
    const ws = this.sync.getDoc(WORKSPACE_DOC)
    const folders = ws ? listFolders(ws) : []
    const paths = folderPaths(folders)
    const live = new Set(paths.keys())
    // when each note was last saved: re-read only those that changed
    const saved = new Map(
      (this.store.db.prepare("SELECT name, updated_at FROM documents WHERE name LIKE 'note:%'").all() as { name: string; updated_at: number }[]).map((r) => [r.name, r.updated_at]),
    )
    const out: NoteTask[] = []
    for (const m of meta.values()) {
      if (m.trashedAt || m.template || !allowed(m.id)) continue
      const name = noteDocName(m.id)
      // a note being edited right now: its saved copy may be a moment behind
      const at = this.sync.hocuspocus.documents.has(name) ? -1 : (saved.get(name) ?? 0)
      let hit = this.cache.get(m.id)
      if (!hit || hit.at !== at || at === -1) {
        const doc = this.sync.getDoc(name)
        hit = { at, tasks: doc ? extractTasks(doc).filter((t) => t.text) : [] }
        this.cache.set(m.id, hit)
      }
      const f = effectiveFolderId(m, live)
      for (const t of hit.tasks) {
        if (opts.done !== undefined && t.done !== opts.done) continue
        out.push({ ...t, noteId: m.id, title: m.title, folder: f ? (paths.get(f) ?? []) : [], noteUpdatedAt: m.updatedAt })
      }
    }
    return out
  }

  /** Tick or untick one (a repeating one moves to its next date instead). Returns false if the note changed. */
  async setDone(noteId: string, i: number, text: string, done: boolean): Promise<boolean> {
    let ok = false
    await this.sync.change(noteDocName(noteId), (doc) => {
      const t = extractTasks(doc)[i]
      if (done && t?.text === text && t.repeat && t.due) {
        // the due date's id: complete it the way the Due view does
        const id = dueIdAt(doc, i)
        if (id && completeDue(doc, id) !== null) return void (ok = true)
      }
      ok = setTaskDone(doc, i, text, done)
    })
    this.cache.delete(noteId)
    return ok
  }

  // ---------------------------------------------------------------------------
  // Calendar feed

  /** The secret in the calendar feed's address (made the first time). */
  feedToken(reset = false): string {
    let t = this.store.getSetting<string>('calendarFeedToken')
    if (!t || reset) {
      t = crypto.randomBytes(18).toString('base64url')
      this.store.setSetting('calendarFeedToken', t)
    }
    return t
  }

  /**
   * An iCalendar (.ics) feed of the open to-dos with a due date, as all-day
   * events – subscribe to it in Apple Calendar, Google Calendar or Outlook.
   * Locked folders are left out (a calendar app can't unlock them).
   */
  ics(allowed: (noteId: string) => boolean, appUrl: string): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`)
    const day = (d: string) => d.replace(/-/g, '')
    const nextDay = (d: string) => {
      const [y, m, dd] = d.split('-').map(Number)
      const n = new Date(Date.UTC(y, m - 1, dd + 1))
      return n.toISOString().slice(0, 10).replace(/-/g, '')
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ReconNotes//Due dates//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:ReconNotes', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H']
    for (const t of this.list(allowed, { done: false })) {
      if (!t.due) continue
      const uid = crypto.createHash('sha1').update(`${t.noteId}|${t.i}|${t.text}`).digest('hex').slice(0, 24)
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}@reconnotes`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${day(t.due)}`,
        `DTEND;VALUE=DATE:${nextDay(t.due)}`,
        `SUMMARY:${esc(t.text)}`,
        `DESCRIPTION:${esc(`From “${t.title || 'Untitled'}”${t.folder.length ? ` in ${t.folder.join(' › ')}` : ''}\nOpen it in the app: reconnotes://open?note=${t.noteId}&find=${encodeURIComponent(findText(t.text))}`)}`,
        // (opening it lands on the item in the note)
        `URL:${appUrl}/#note=${t.noteId}&find=${encodeURIComponent(findText(t.text))}`,
        ...(t.repeat ? [`RRULE:${RRULE[t.repeat]}`] : []),
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      )
    }
    lines.push('END:VCALENDAR')
    // lines of at most 75 octets, folded (RFC 5545)
    return lines.map(fold).join('\r\n') + '\r\n'
  }
}

const RRULE: Record<Repeat, string> = {
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
  biweekly: 'FREQ=WEEKLY;INTERVAL=2',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY',
}

function fold(line: string): string {
  const bytes = Buffer.from(line)
  if (bytes.length <= 75) return line
  const parts: string[] = []
  let cur = ''
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (parts.length ? 74 : 75)) {
      parts.push(cur)
      cur = ''
    }
    cur += ch
  }
  parts.push(cur)
  return parts.join('\r\n ')
}

/** The id of the due date inside checklist item i (counted the way extractTasks counts). */
function dueIdAt(doc: Y.Doc, i: number): string | null {
  const own = (el: Y.XmlElement): string | null => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement) || ['taskList', 'bulletList', 'orderedList'].includes(c.nodeName)) continue
      if (c.nodeName === 'dueDate') return (c.getAttribute('id') as string | undefined) ?? null
      const inner = own(c)
      if (inner) return inner
    }
    return null
  }
  let n = -1
  let hit: Y.XmlElement | null = null
  const walk = (el: Y.XmlElement | Y.XmlFragment) => {
    for (const c of el.toArray()) {
      if (hit || !(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'taskItem' && ++n === i) return void (hit = c)
      walk(c)
    }
  }
  walk(getContent(doc))
  return hit ? own(hit) : null
}

/** What to look for in a note to land on an item: its first words, without its due date, ▶ links or marks. */
export function findText(text: string): string {
  const plain = text
    .replace(/\s*\[▶[^\]]*\]\(listen:[^)]*\)/g, '')
    .replace(/\s*!\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let out = ''
  for (const w of plain.split(' ')) {
    if (`${out} ${w}`.trim().length > 48) break
    out = `${out} ${w}`.trim()
  }
  return out || plain.slice(0, 48)
}
