import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { extractDue, extractTasks, getContent, noteToMarkdown, setTaskDone } from '../src'

const item = (text: string, opts: { checked?: boolean; due?: string } = {}) => {
  const i = new Y.XmlElement('taskItem')
  i.setAttribute('checked', (opts.checked ?? false) as unknown as string)
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  if (opts.due) {
    const d = new Y.XmlElement('dueDate')
    d.setAttribute('date', opts.due)
    d.setAttribute('id', `d-${text}`)
    p.insert(1, [d])
  }
  i.insert(0, [p])
  return i
}
const list = (items: Y.XmlElement[], kind?: string) => {
  const l = new Y.XmlElement('taskList')
  if (kind) l.setAttribute('kind', kind)
  l.insert(0, items)
  return l
}

describe('two kinds of checklist', () => {
  const doc = new Y.Doc()
  getContent(doc).insert(0, [list([item('milk'), item('eggs', { due: '2026-10-20' })], 'list'), list([item('pay rent', { due: '2026-11-01' })])])

  it('a plain checklist holds no tasks and no due dates', () => {
    expect(extractTasks(doc).map((t) => [t.i, t.text])).toEqual([[2, 'pay rent']])
    expect(extractDue(doc).map((d) => d.text)).toEqual(['pay rent'])
  })

  it('a to-do is still ticked by its place among all checklist items', () => {
    expect(setTaskDone(doc, 2, 'pay rent', true)).toBe(true)
    expect(extractTasks(doc)[0].done).toBe(true)
  })

  it('says which lists are plain in Markdown', () => {
    expect(noteToMarkdown(doc)).toMatch(/<!-- list -->\n- \[ \] milk/)
    expect(noteToMarkdown(doc)).not.toMatch(/<!-- list -->\n- \[x\] pay rent/)
  })
})
