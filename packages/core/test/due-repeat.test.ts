import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { completeDue, extractDue, extractTasks, setTaskDone, getContent, nextDue, occurrences, parseRepeat } from '../src'

const NOW = new Date(2026, 9, 7) // Wed Oct 7 2026

describe('repeating due dates', () => {
  it('understands the ways people say it', () => {
    expect(parseRepeat('every monday', NOW)).toEqual({ date: '2026-10-12', repeat: 'weekly' })
    expect(parseRepeat('every fri', NOW)).toEqual({ date: '2026-10-09', repeat: 'weekly' })
    expect(parseRepeat('daily', NOW)).toEqual({ date: '2026-10-07', repeat: 'daily' })
    expect(parseRepeat('every 2 weeks', NOW)?.repeat).toBe('biweekly')
    expect(parseRepeat('monthly', NOW)).toEqual({ date: '2026-10-07', repeat: 'monthly' })
    expect(parseRepeat('every weekday', new Date(2026, 9, 10))).toEqual({ date: '2026-10-12', repeat: 'weekdays' }) // Saturday → Monday
    expect(parseRepeat('friday', NOW)).toBeNull()
  })

  it('moves on to the next date, skipping ones already missed', () => {
    expect(nextDue('2026-10-07', 'weekly', '2026-10-07')).toBe('2026-10-14')
    expect(nextDue('2026-09-02', 'weekly', '2026-10-07')).toBe('2026-10-14') // done late
    expect(nextDue('2026-10-09', 'weekdays', '2026-10-07')).toBe('2026-10-12') // Fri → Mon
    expect(nextDue('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28') // short month
    expect(nextDue('2026-02-28', 'monthly', '2026-02-28')).toBe('2026-03-28')
    expect(nextDue('2028-02-29', 'yearly', '2028-02-29')).toBe('2029-02-28')
  })

  it('lists the dates in a month for the calendar', () => {
    expect(occurrences('2026-10-05', 'weekly', '2026-10-01', '2026-10-31')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
    expect(occurrences('2026-10-05', null, '2026-10-01', '2026-10-31')).toEqual(['2026-10-05'])
  })

  it('ticking a repeating item moves its date instead', () => {
    const doc = new Y.Doc()
    const item = new Y.XmlElement('taskItem')
    item.setAttribute('checked', false as unknown as string)
    const p = new Y.XmlElement('paragraph')
    const due = new Y.XmlElement('dueDate')
    due.setAttribute('id', 'd1')
    due.setAttribute('date', '2026-10-07')
    due.setAttribute('repeat', 'weekly')
    p.insert(0, [new Y.XmlText('Water plants '), due])
    item.insert(0, [p])
    const list = new Y.XmlElement('taskList')
    list.insert(0, [item])
    getContent(doc).insert(0, [list])
    expect(extractDue(doc)[0]).toMatchObject({ date: '2026-10-07', repeat: 'weekly', done: false })
    expect(completeDue(doc, 'd1', NOW)).toBe('2026-10-14')
    expect(extractDue(doc)[0]).toMatchObject({ date: '2026-10-14', done: false })
  })
})

describe('checklist items', () => {
  it('lists every item (nested too) and ticks one only if it is unchanged', () => {
    const doc = new Y.Doc()
    const item = (text: string, checked: boolean, children: Y.XmlElement[] = []) => {
      const li = new Y.XmlElement('taskItem')
      li.setAttribute('checked', checked as unknown as string)
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(text)])
      li.insert(0, [p, ...children])
      return li
    }
    const list = (items: Y.XmlElement[]) => {
      const l = new Y.XmlElement('taskList')
      l.insert(0, items)
      return l
    }
    getContent(doc).insert(0, [list([item('Buy milk', false, [list([item('Oat milk', false)])]), item('Call Bob', true)])])
    expect(extractTasks(doc).map((t) => [t.i, t.text, t.done])).toEqual([
      [0, 'Buy milk', false],
      [1, 'Oat milk', false],
      [2, 'Call Bob', true],
    ])
    expect(setTaskDone(doc, 1, 'Something else', true)).toBe(false)
    expect(setTaskDone(doc, 1, 'Oat milk', true)).toBe(true)
    expect(extractTasks(doc)[1].done).toBe(true)
    expect(extractTasks(doc)[0].done).toBe(false)
  })
})
