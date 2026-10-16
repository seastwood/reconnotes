import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { extractDue, extractTasks, getContent, noteToMarkdown, parseTime } from '../src'

describe('a time on a due date', () => {
  it('reads times as said', () => {
    expect(parseTime('3pm')).toBe('15:00')
    expect(parseTime('3:30 PM')).toBe('15:30')
    expect(parseTime('at 9am')).toBe('09:00')
    expect(parseTime('12am')).toBe('00:00')
    expect(parseTime('12pm')).toBe('12:00')
    expect(parseTime('15:00')).toBe('15:00')
    expect(parseTime('9.45am')).toBe('09:45')
    expect(parseTime('3')).toBeNull()
    expect(parseTime('13pm')).toBeNull()
    expect(parseTime('25:00')).toBeNull()
  })
  it('is kept in Markdown, Due and Tasks', () => {
    const d = new Y.Doc()
    const list = new Y.XmlElement('taskList')
    const item = new Y.XmlElement('taskItem')
    const p = new Y.XmlElement('paragraph')
    const due = new Y.XmlElement('dueDate')
    due.setAttribute('date', '2026-10-16')
    due.setAttribute('id', 'd1')
    due.setAttribute('time', '15:00')
    p.insert(0, [new Y.XmlText('Call the dentist '), due])
    item.insert(0, [p])
    list.insert(0, [item])
    getContent(d).insert(0, [list])
    expect(noteToMarkdown(d)).toContain('Call the dentist !2026-10-16@15:00')
    expect(extractDue(d)[0]).toMatchObject({ date: '2026-10-16', time: '15:00' })
    expect(extractTasks(d)[0]).toMatchObject({ due: '2026-10-16', time: '15:00' })
  })
})
