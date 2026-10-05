import * as Y from 'yjs'
import { getContent } from './schema'

/**
 * Due dates
 * =========
 *
 * Typing "!friday", "!tomorrow", "!oct 12" or "!2026-10-12" puts a date chip
 * (a `dueDate` node holding a fixed YYYY-MM-DD date) in the note. Due items
 * are collected per note so a "Due" view can list them across all notes.
 */

export interface DueItem {
  /** the dueDate node's id */
  id: string
  /** YYYY-MM-DD */
  date: string
  /** the checklist item's (or paragraph's) text */
  text: string
  /** the checklist item is ticked */
  done: boolean
  /** repeats: when ticked it moves to the next date instead (see Repeat) */
  repeat?: Repeat | null
}

/** How a due date repeats. */
export type Repeat = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly'

export const REPEAT_LABELS: Record<Repeat, string> = {
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  monthly: 'Every month',
  yearly: 'Every year',
}

/**
 * "every monday", "every day", "daily", "weekly", "every 2 weeks",
 * "monthly", "every month", "yearly", "every weekday": the first date and
 * how it repeats. Null if it isn't a repeat.
 */
export function parseRepeat(word: string, now = new Date()): { date: string; repeat: Repeat } | null {
  const w = word.trim().toLowerCase().replace(/\s+/g, ' ')
  const today = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
  const simple: Record<string, Repeat> = {
    daily: 'daily',
    'every day': 'daily',
    weekdays: 'weekdays',
    'every weekday': 'weekdays',
    weekly: 'weekly',
    'every week': 'weekly',
    biweekly: 'biweekly',
    fortnightly: 'biweekly',
    'every 2 weeks': 'biweekly',
    'every other week': 'biweekly',
    monthly: 'monthly',
    'every month': 'monthly',
    yearly: 'yearly',
    annually: 'yearly',
    'every year': 'yearly',
  }
  if (simple[w]) {
    const repeat = simple[w]
    // weekdays starting on a weekend: the next Monday
    return { date: repeat === 'weekdays' ? nextDue(today, 'weekdays', addDays(today, -1)) : today, repeat }
  }
  const m = /^every (\S+)$/.exec(w)
  if (m) {
    const date = parseDue(m[1], now)
    if (date && DAYS.some((d) => d.startsWith(m[1]) && m[1].length >= 3)) return { date, repeat: 'weekly' }
  }
  return null
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return isoDate(new Date(y, m - 1, d + n))
}

function addMonths(date: string, n: number, anchorDay: number): string {
  const [y, m] = date.split('-').map(Number)
  const first = new Date(y, m - 1 + n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(anchorDay, last)))
}

/** The date after `date` in the repeat. */
function step(date: string, repeat: Repeat, anchorDay: number): string {
  switch (repeat) {
    case 'daily':
      return addDays(date, 1)
    case 'weekdays': {
      let next = addDays(date, 1)
      while ([0, 6].includes(new Date(next + 'T12:00').getDay())) next = addDays(next, 1)
      return next
    }
    case 'weekly':
      return addDays(date, 7)
    case 'biweekly':
      return addDays(date, 14)
    case 'monthly':
      return addMonths(date, 1, anchorDay)
    case 'yearly':
      return addMonths(date, 12, anchorDay)
  }
}

/**
 * The next date of a repeating item that is due on `date`: the first one
 * after both `date` and `after` (normally today), so finishing late skips
 * the dates already missed. Monthly/yearly keep the day of the month
 * (the 31st becomes the last day of shorter months).
 */
export function nextDue(date: string, repeat: Repeat, after: string = isoDate(new Date())): string {
  const anchor = Number(date.split('-')[2])
  let next = step(date, repeat, anchor)
  for (let i = 0; next <= after && i < 5000; i++) next = step(next, repeat, anchor)
  return next
}

/** Dates of a repeating item that fall in [from, to] (for calendars). */
export function occurrences(date: string, repeat: Repeat | null | undefined, from: string, to: string): string[] {
  if (!repeat) return date >= from && date <= to ? [date] : []
  const anchor = Number(date.split('-')[2])
  const out: string[] = []
  for (let d = date, i = 0; d <= to && i < 2000; d = step(d, repeat, anchor), i++) if (d >= from) out.push(d)
  return out
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Parse what follows "!" into a date (relative words are fixed to `now`); null if it isn't a date. */
export function parseDue(word: string, now = new Date()): string | null {
  const w = word.trim().toLowerCase().replace(/\s+/g, ' ')
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const add = (days: number) => isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days))
  if (w === 'today' || w === 'tod') return add(0)
  if (w === 'tomorrow' || w === 'tmr' || w === 'tom') return add(1)
  if (w === 'next week') return add(7)
  const day = DAYS.findIndex((d) => d === w || (w.length >= 3 && d.startsWith(w)))
  if (day >= 0) return add((day - today.getDay() + 7) % 7) // today counts
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(w)
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]))
  // "oct 12", "12 oct", "october 12": this year, or next year if it's already past
  m = /^([a-z]+)\.? (\d{1,2})$/.exec(w) ?? null
  const m2 = /^(\d{1,2}) ([a-z]+)\.?$/.exec(w)
  const monthWord = m ? m[1] : m2 ? m2[2] : null
  const dayNum = m ? Number(m[2]) : m2 ? Number(m2[1]) : null
  if (monthWord && dayNum) {
    const month = MONTHS.findIndex((x) => monthWord.startsWith(x))
    if (month < 0) return null
    let year = today.getFullYear()
    if (new Date(year, month, dayNum) < today) year++
    return valid(year, month + 1, dayNum)
  }
  return null
}

function valid(y: number, mo: number, d: number): string | null {
  const dt = new Date(y, mo - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? isoDate(dt) : null
}

/** "Today", "Tomorrow", "Fri, Oct 9", "Oct 9, 2027" – for chips and lists. */
export function formatDue(date: string, now = new Date()): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((dt.getTime() - today.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff < 7) return dt.toLocaleDateString(undefined, { weekday: 'long' })
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(y !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

/** Days from today (negative = overdue). */
export function daysUntil(date: string, now = new Date()): number {
  const [y, m, d] = date.split('-').map(Number)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000)
}

/** Every due date in a note, with the text of the item it belongs to. */
export function extractDue(doc: Y.Doc): DueItem[] {
  const out: DueItem[] = []
  const textOf = (el: Y.XmlElement | Y.XmlFragment): string => {
    let s = ''
    for (const c of el.toArray()) {
      if (c instanceof Y.XmlText) s += c.toString().replace(/<[^>]+>/g, '')
      else if (c instanceof Y.XmlElement && c.nodeName !== 'dueDate' && c.nodeName !== 'taskList' && c.nodeName !== 'bulletList') s += textOf(c)
    }
    return s
  }
  const walk = (el: Y.XmlElement | Y.XmlFragment, item: { el: Y.XmlElement; done: boolean } | null) => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'dueDate') {
        const date = c.getAttribute('date') as string | undefined
        const id = c.getAttribute('id') as string | undefined
        const repeat = (c.getAttribute('repeat') as Repeat | undefined) ?? null
        if (date && id)
          out.push({ id, date, done: item?.done ?? false, text: (item ? textOf(item.el) : textOf(el)).replace(/\s+/g, ' ').trim(), ...(repeat ? { repeat } : {}) })
        continue
      }
      const checked = c.getAttribute('checked') as unknown
      walk(c, c.nodeName === 'taskItem' ? { el: c, done: checked === true || checked === 'true' } : item)
    }
  }
  walk(getContent(doc), null)
  return out
}

/** Tick (or untick) the checklist item holding a due date. Returns false if it isn't in a checklist. */
export function setDueDone(doc: Y.Doc, dueId: string, done: boolean): boolean {
  let found = false
  const walk = (el: Y.XmlElement | Y.XmlFragment, item: Y.XmlElement | null) => {
    for (const c of el.toArray()) {
      if (found || !(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'dueDate' && c.getAttribute('id') === dueId) {
        if (item) {
          item.setAttribute('checked', done as unknown as string)
          found = true
        }
        return
      }
      walk(c, c.nodeName === 'taskItem' ? c : item)
    }
  }
  doc.transact(() => walk(getContent(doc), null))
  return found
}

/**
 * Finish a due item: a repeating one moves on to its next date (and stays
 * unticked); any other is ticked. Returns the next date for a repeating item.
 */
export function completeDue(doc: Y.Doc, dueId: string, now = new Date()): string | null {
  let next: string | null = null
  const walk = (el: Y.XmlElement | Y.XmlFragment): boolean => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'dueDate' && c.getAttribute('id') === dueId) {
        const repeat = c.getAttribute('repeat') as Repeat | undefined
        if (repeat) {
          next = nextDue(c.getAttribute('date') as string, repeat, isoDate(now))
          c.setAttribute('date', next)
        }
        return true
      }
      if (walk(c)) return true
    }
    return false
  }
  doc.transact(() => {
    walk(getContent(doc))
    if (!next) setDueDone(doc, dueId, true)
  })
  return next
}
