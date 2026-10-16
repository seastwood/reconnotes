import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { applyEdit, blockKey, diffBlocks, findPart, revertEdit } from '../src/noteEdit'

const para = (t: string, attrs: Record<string, string> = {}) => {
  const p = new Y.XmlElement('paragraph')
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v)
  p.insert(0, [new Y.XmlText(t)])
  return p
}
const checklist = (items: string[]) => {
  const l = new Y.XmlElement('taskList')
  l.insert(
    0,
    items.map((t) => {
      const i = new Y.XmlElement('taskItem')
      i.setAttribute('checked', false as unknown as string)
      i.insert(0, [para(t)])
      return i
    }),
  )
  return l
}
const doc = (nodes: Y.XmlElement[]) => {
  const d = new Y.Doc()
  d.getXmlFragment('content').insert(0, nodes)
  return d
}
const texts = (d: Y.Doc) => d.getXmlFragment('content').toArray().map((n) => blockKey(n as Y.XmlElement))

describe('editing a note with AI', () => {
  it('finds the stretches that changed', () => {
    expect(diffBlocks(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'])).toEqual([{ i0: 1, i1: 3, j0: 1, j1: 3 }])
    expect(diffBlocks(['a', 'b'], ['a', 'b', 'c'])).toEqual([{ i0: 2, i1: 2, j0: 2, j1: 3 }])
    expect(diffBlocks(['a', 'b', 'c'], ['b'])).toEqual([
      { i0: 0, i1: 1, j0: 0, j1: 0 },
      { i0: 2, i1: 3, j0: 1, j1: 1 },
    ])
  })

  it('swaps in only what changed, keeps the rest as it was, and reverts exactly', () => {
    const note = doc([para('Groceries'), para('milk'), para('eggs'), para('Call mom', { color: 'blue' })])
    const ai = doc([para('Groceries'), checklist(['milk', 'eggs']), para('Call mom')])
    const keptBlock = note.getXmlFragment('content').get(3)
    const { record, changed } = applyEdit(note.getXmlFragment('content'), ai.getXmlFragment('content'))
    expect(changed).toBe(2)
    expect(texts(note)).toEqual(texts(ai))
    // the untouched block is the very same one (its attributes kept)
    expect(note.getXmlFragment('content').get(2)).toBe(keptBlock)
    expect((note.getXmlFragment('content').get(2) as Y.XmlElement).getAttribute('color')).toBe('blue')

    // typed meanwhile, elsewhere: revert still finds the change
    note.getXmlFragment('content').insert(0, [para('Added later')])
    const back = revertEdit(note.getXmlFragment('content'), record)
    expect(back).not.toBeNull()
    expect(texts(note).map((k) => k.replace(/<[^>]+>/g, ''))).toEqual(['Added later', 'Groceries', 'milk', 'eggs', 'Call mom'])
    // and back again (to compare), and back once more
    const again = revertEdit(note.getXmlFragment('content'), back!)
    expect(again).not.toBeNull()
    expect(texts(note).slice(1)).toEqual(texts(ai))
    expect(revertEdit(note.getXmlFragment('content'), again!)).not.toBeNull()
    expect(texts(note).map((k) => k.replace(/<[^>]+>/g, ''))).toEqual(['Added later', 'Groceries', 'milk', 'eggs', 'Call mom'])
  })

  it('says what each change took out and put in', () => {
    const note = doc([para('Groceries'), para('milk'), para('eggs')])
    const ai = doc([para('Groceries'), checklist(['milk', 'eggs'])])
    const { changes } = applyEdit(note.getXmlFragment('content'), ai.getXmlFragment('content'))
    expect(changes).toEqual([{ before: 'milk\n\neggs', after: '- [ ] milk\n- [ ] eggs' }])
  })

  it("won't revert over blocks changed since", () => {
    const note = doc([para('one'), para('two')])
    const ai = doc([para('one'), para('TWO')])
    const { record } = applyEdit(note.getXmlFragment('content'), ai.getXmlFragment('content'))
    const f = note.getXmlFragment('content')
    ;(f.get(1) as Y.XmlElement).get(0) instanceof Y.XmlText && ((f.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(3, '!')
    expect(revertEdit(f, record)).toBeNull()
  })
})

describe('plain checklists in Markdown', () => {
  it('reads "<!-- list -->" before a checklist as a plain one', async () => {
    const { markdownToNodes } = await import('../src/importNotes')
    const d = new Y.Doc()
    const ctx = { attach: () => null, noteFor: () => null }
    d.getXmlFragment('content').insert(0, markdownToNodes('Shopping\n\n<!-- list -->\n\n- [ ] milk\n- [x] eggs\n\nTo do\n\n- [ ] call mom', ctx))
    const lists = d.getXmlFragment('content').toArray().filter((n) => (n as Y.XmlElement).nodeName === 'taskList') as Y.XmlElement[]
    expect(lists.map((l) => l.getAttribute('kind') ?? null)).toEqual(['list', null])
  })
})

describe('making the whole note a list, when the AI won’t', async () => {
  const { wholeNoteAsList } = await import('../src/noteEdit')
  const md = '3 lbs ground beef\n\n2 large yellow onions\n\n# Toppings\n\nSour cream\n\n⟦IMAGE:abc12345⟧'
  it('turns each line into an item, keeping headings and pictures', () => {
    expect(wholeNoteAsList(md, 'Convert this into a checklist')?.markdown).toBe(
      '<!-- list -->\n- [ ] 3 lbs ground beef\n\n- [ ] 2 large yellow onions\n\n# Toppings\n\n<!-- list -->\n- [ ] Sour cream\n\n⟦IMAGE:abc12345⟧',
    )
    expect(wholeNoteAsList(md, 'make it a numbered list')?.markdown).toContain('1. 3 lbs ground beef\n\n2. 2 large yellow onions')
    expect(wholeNoteAsList(md, 'make this a to-do list')?.markdown).not.toContain('<!-- list -->')
  })
  it('leaves a request about a part of the note to the AI', () => {
    expect(wholeNoteAsList(md, 'make the lines under Toppings a checklist')).toBeNull()
    expect(wholeNoteAsList(md, 'fix the spelling')).toBeNull()
  })
})

describe('editing the selected part of a note', () => {
  const d = doc([para('Intro'), para('Milk'), para('Eggs   and bread'), para('Outro'), para('Milk')])
  const frag = d.getXmlFragment('content')
  it('finds it where the editor said', () => {
    expect(findPart(frag, { from: 1, to: 3, text: 'Milk\nEggs and bread' })).toEqual({ from: 1, to: 3 })
  })
  it('finds it where it has moved to, nearest to where it was', () => {
    expect(findPart(frag, { from: 0, to: 2, text: 'Milk\nEggs and bread' })).toEqual({ from: 1, to: 3 })
    expect(findPart(frag, { from: 5, to: 6, text: 'Milk' })).toEqual({ from: 4, to: 5 })
    // part of a block's words: that block
    expect(findPart(frag, { from: 9, to: 10, text: 'and bre' })).toEqual({ from: 2, to: 3 })
  })
  it('is null once its words are gone', () => {
    expect(findPart(frag, { from: 1, to: 2, text: 'Cheese' })).toBeNull()
  })
})
