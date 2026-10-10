import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  buildTree,
  createFolder,
  createNote,
  eraseFromStroke,
  scaleStroke,
  extractNote,
  getContent,
  getStrokes,
  getTranscripts,
  listFolders,
  listNotes,
  moveFolder,
  moveNote,
  orderAtIndex,
  restoreFolder,
  sortNotes,
  strokeInLasso,
  trashFolder,
  updateFolder,
  folderRules,
  getNotes,
  noteReadOnly,
  readNote,
  updateNote,
  type Stroke,
} from '../src'

/** Exchange all updates between two docs, as the server does on reconnect. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

function paragraph(text: string) {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  return p
}

describe('offline edits merge without losing information', () => {
  it('keeps both devices\' typing in the same note', () => {
    const iphone = new Y.Doc()
    const ipad = new Y.Doc()
    getContent(iphone).insert(0, [paragraph('Shopping list')])
    sync(iphone, ipad)

    // both go offline and edit the same paragraph
    ;((getContent(iphone).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(13, ': milk')
    ;((getContent(ipad).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'Saturday ')
    getContent(ipad).insert(1, [paragraph('eggs')])

    sync(iphone, ipad)
    const a = extractNote(iphone).text
    const b = extractNote(ipad).text
    expect(a).toBe(b)
    expect(a).toContain('Saturday Shopping list: milk')
    expect(a).toContain('eggs')
  })

  it('keeps ink drawn on two devices in the same drawing', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const s = (id: string): Stroke => ({ id, tool: 'pen', color: '#000', size: 3, pts: [0, 0, 0.5, 10, 10, 0.5] })
    getStrokes(a, 'd1').push([s('one')])
    getStrokes(b, 'd1').push([s('two')])
    sync(a, b)
    expect(getStrokes(a, 'd1').toArray().map((x) => x.id).sort()).toEqual(['one', 'two'])
    expect(getStrokes(b, 'd1').length).toBe(2)
  })

  it('merges a rename on one device with a move on another', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const work = createFolder(a, { name: 'Work' })
    const proj = createFolder(a, { name: 'Projects' })
    sync(a, b)
    updateFolder(a, proj, { name: 'Projects 2026' })
    moveFolder(b, proj, work)
    sync(a, b)
    const p = listFolders(a).find((f) => f.id === proj)!
    expect(p.name).toBe('Projects 2026')
    expect(p.parentId).toBe(work)
  })

  it('never hides folders when concurrent moves create a cycle', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const x = createFolder(a, { name: 'X' })
    const y = createFolder(a, { name: 'Y' })
    sync(a, b)
    expect(moveFolder(a, x, y)).toBe(true)
    expect(moveFolder(b, y, x)).toBe(true)
    sync(a, b)
    const tree = buildTree(listFolders(a))
    const flat: string[] = []
    const walk = (nodes: ReturnType<typeof buildTree>) =>
      nodes.forEach((n) => {
        flat.push(n.folder.id)
        walk(n.children)
      })
    walk(tree)
    expect(flat.sort()).toEqual([x, y].sort())
  })
})

describe('folders', () => {
  it('nests folders and refuses moving a folder into itself', () => {
    const d = new Y.Doc()
    const a = createFolder(d, { name: 'A' })
    const b = createFolder(d, { name: 'B', parentId: a })
    const c = createFolder(d, { name: 'C', parentId: b })
    expect(moveFolder(d, a, c)).toBe(false)
    const tree = buildTree(listFolders(d))
    expect(tree[0].folder.name).toBe('A')
    expect(tree[0].children[0].children[0].folder.name).toBe('C')
  })

  it('supports manual ordering and alphabetical sort', () => {
    const d = new Y.Doc()
    const z = createFolder(d, { name: 'Zeta' })
    createFolder(d, { name: 'alpha' })
    createFolder(d, { name: 'Beta' })
    expect(buildTree(listFolders(d), 'manual').map((n) => n.folder.name)).toEqual(['Zeta', 'alpha', 'Beta'])
    expect(buildTree(listFolders(d), 'title').map((n) => n.folder.name)).toEqual(['alpha', 'Beta', 'Zeta'])
    moveFolder(d, z, null, 3 - 1) // to the end (index among the other 2 siblings)
    expect(buildTree(listFolders(d), 'manual').map((n) => n.folder.name)).toEqual(['alpha', 'Beta', 'Zeta'])
  })

  it('trashes and restores a folder with its notes', () => {
    const d = new Y.Doc()
    const a = createFolder(d, { name: 'A' })
    const b = createFolder(d, { name: 'B', parentId: a })
    const n = createNote(d, { folderId: b })
    trashFolder(d, a)
    expect(buildTree(listFolders(d))).toHaveLength(0)
    expect(listNotes(d).find((x) => x.id === n)!.trashedAt).not.toBeNull()
    restoreFolder(d, a)
    expect(buildTree(listFolders(d))[0].children).toHaveLength(1)
    expect(listNotes(d).find((x) => x.id === n)!.trashedAt).toBeNull()
  })

  it('orders notes manually and keeps pinned notes first', () => {
    const d = new Y.Doc()
    const n1 = createNote(d)
    const n2 = createNote(d)
    const n3 = createNote(d)
    // newest is first by default (created at start)
    expect(sortNotes(listNotes(d), 'manual').map((n) => n.id)).toEqual([n3, n2, n1])
    moveNote(d, n3, null, 2)
    expect(sortNotes(listNotes(d), 'manual').map((n) => n.id)).toEqual([n2, n1, n3])
  })

  it('generates keys between equal keys', () => {
    const k = orderAtIndex(
      [
        { id: 'a', order: 'a0' },
        { id: 'b', order: 'a0' },
        { id: 'c', order: 'a1' },
      ],
      1,
    )
    expect(k > 'a0' && k < 'a1').toBe(true)
  })
})

describe('text extraction', () => {
  it('extracts title, checklists and handwriting transcripts', () => {
    const d = new Y.Doc()
    const h = new Y.XmlElement('heading')
    h.insert(0, [new Y.XmlText('Trip plan')])
    const list = new Y.XmlElement('taskList')
    const item = new Y.XmlElement('taskItem')
    item.setAttribute('checked', true as unknown as string)
    item.insert(0, [paragraph('Book hotel')])
    list.insert(0, [item])
    const drawing = new Y.XmlElement('drawing')
    drawing.setAttribute('drawingId', 'd1')
    getContent(d).insert(0, [h, list, drawing])
    getTranscripts(d).set('d1', 'remember passport')
    const out = extractNote(d)
    expect(out.title).toBe('Trip plan')
    expect(out.text).toContain('[x] Book hotel')
    expect(out.text).toContain('remember passport')
    expect(out.drawings).toEqual(['d1'])
  })
})

describe('ink geometry', () => {
  const stroke: Stroke = { id: 's', tool: 'pen', color: '#000', size: 2, pts: [0, 0, 1, 10, 0, 1, 20, 0, 1, 30, 0, 1, 40, 0, 1] }

  it('splits a stroke with the pixel eraser', () => {
    const runs = eraseFromStroke(stroke, 20, 0, 1)!
    expect(runs).toHaveLength(2)
    expect(eraseFromStroke(stroke, 20, 50, 1)).toBeNull()
  })

  it('selects strokes inside a lasso', () => {
    expect(strokeInLasso(stroke, [-5, -5, 50, -5, 50, 5, -5, 5])).toBe(true)
    expect(strokeInLasso(stroke, [100, 100, 200, 100, 200, 200])).toBe(false)
  })
})

describe('#tags', () => {
  it('leaves out a web page’s own tags (written as links to its tag pages)', async () => {
    const Y = await import('yjs')
    const { extractNote, getContent } = await import('../src')
    const doc = new Y.Doc()
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    p.insert(0, [t])
    getContent(doc).insert(0, [p])
    t.insert(0, 'Notes on #mine and ')
    t.insert(t.length, '#docker', { link: { href: 'https://blog.example/tags/docker' } })
    t.insert(t.length, ' and ')
    t.insert(t.length, '#mine', { link: { href: 'https://blog.example/tags/mine' } })
    expect(extractNote(doc).tags).toEqual(['mine'])
  })

  it('finds tags but not C#, #1 or URL anchors', async () => {
    const { extractTags } = await import('../src')
    expect(extractTags('Plan #Robotics and #build-log, see https://x.com/a#top. C# rocks. Issue #1 (#FRC_2026)')).toEqual(['build-log', 'frc_2026', 'robotics'])
    expect(extractTags('#start of line\n#Second line #second')).toEqual(['second', 'start'])
  })
})

describe('restoreNoteContent', () => {
  it('brings back old text and ink as normal edits', async () => {
    const Y = await import('yjs')
    const { restoreNoteContent, getContent, getStrokes, extractNote } = await import('../src')
    const live = new Y.Doc()
    const para = (t: string) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(t)])
      return p
    }
    getContent(live).insert(0, [para('Version one'), para('keep me')])
    getStrokes(live, 'd1').push([{ id: 's1', tool: 'pen', color: '#000', size: 3, pts: [0, 0, 0.5] }])
    const old = new Y.Doc()
    Y.applyUpdate(old, Y.encodeStateAsUpdate(live))
    // later edits
    getContent(live).delete(0, 2)
    getContent(live).insert(0, [para('Version two')])
    getStrokes(live, 'd1').delete(0, 1)
    // a second device that has the later state
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(live))
    restoreNoteContent(live, old)
    expect(extractNote(live).text).toBe('Version one\nkeep me')
    expect(getStrokes(live, 'd1').length).toBe(1)
    // the restore syncs like any change
    Y.applyUpdate(other, Y.encodeStateAsUpdate(live, Y.encodeStateVector(other)))
    expect(extractNote(other).text).toBe('Version one\nkeep me')
  })
})

describe('due dates', () => {
  it('parses words into fixed dates', async () => {
    const { parseDue } = await import('../src')
    const wed = new Date(2026, 9, 7) // Wednesday 7 Oct 2026
    expect(parseDue('today', wed)).toBe('2026-10-07')
    expect(parseDue('tomorrow', wed)).toBe('2026-10-08')
    expect(parseDue('friday', wed)).toBe('2026-10-09')
    expect(parseDue('wed', wed)).toBe('2026-10-07')
    expect(parseDue('mon', wed)).toBe('2026-10-12')
    expect(parseDue('oct 12', wed)).toBe('2026-10-12')
    expect(parseDue('12 Oct', wed)).toBe('2026-10-12')
    expect(parseDue('jan 3', wed)).toBe('2027-01-03')
    expect(parseDue('2026-02-30', wed)).toBe(null)
    expect(parseDue('important', wed)).toBe(null)
  })

  it('collects due items with their checklist text, and ticks them', async () => {
    const Y = await import('yjs')
    const { extractDue, setDueDone, getContent } = await import('../src')
    const doc = new Y.Doc()
    const list = new Y.XmlElement('taskList')
    const item = new Y.XmlElement('taskItem')
    item.setAttribute('checked', false as unknown as string)
    const p = new Y.XmlElement('paragraph')
    const due = new Y.XmlElement('dueDate')
    due.setAttribute('date', '2026-10-09')
    due.setAttribute('id', 'd1')
    p.insert(0, [new Y.XmlText('Order bumpers '), due])
    item.insert(0, [p])
    list.insert(0, [item])
    getContent(doc).insert(0, [list])
    expect(extractDue(doc)).toEqual([{ id: 'd1', date: '2026-10-09', text: 'Order bumpers', done: false }])
    expect(setDueDone(doc, 'd1', true)).toBe(true)
    expect(extractDue(doc)[0].done).toBe(true)
  })
})

describe('shape snapping', () => {
  const wobble = (pts: [number, number][], j = 3) => {
    const out: [number, number][] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]]
      for (let k = 0; k < 20; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 20 + Math.sin(k * 1.7 + i) * j, a[1] + ((b[1] - a[1]) * k) / 20 + Math.cos(k * 1.3 + i) * j])
    }
    out.push(pts[pts.length - 1])
    return out
  }
  it('recognises lines, boxes, triangles, circles and arrows', async () => {
    const { recognizeShape } = await import('../src')
    expect(recognizeShape(wobble([[10, 100], [300, 104]], 1))?.kind).toBe('line')
    const line = recognizeShape(wobble([[10, 100], [300, 106]], 1))!
    expect(Math.abs(line.points[line.points.length - 1][1] - line.points[0][1])).toBeLessThan(0.5) // snapped level
    expect(recognizeShape(wobble([[0, 0], [200, 4], [204, 120], [2, 118], [3, 2]]))?.kind).toBe('rectangle')
    expect(recognizeShape(wobble([[100, 0], [200, 170], [0, 170], [98, 2]]))?.kind).toBe('triangle')
    const circle: [number, number][] = []
    for (let i = 0; i <= 60; i++) circle.push([150 + Math.cos(i / 9.4) * (80 + Math.sin(i) * 3), 150 + Math.sin(i / 9.4) * (80 + Math.cos(i) * 3)])
    expect(recognizeShape(circle)?.kind).toBe('ellipse')
    expect(recognizeShape(wobble([[0, 100], [300, 100], [270, 80], [300, 100], [270, 120]], 1))?.kind).toBe('arrow')
    // handwriting is left alone
    expect(recognizeShape(wobble([[0, 0], [20, 40], [40, 0], [60, 40], [80, 0], [100, 40], [120, 0], [140, 40], [160, 0]], 1))).toBe(null)
  })
})

describe('scaleStroke', () => {
  it('scales points around the anchor, and the line with them', () => {
    const s = { id: 'a', tool: 'pen' as const, color: '#000', size: 3, pts: [10, 10, 0.5, 30, 20, 0.5] }
    const big = scaleStroke(s, 10, 10, 2, 'b')
    expect(big.pts).toEqual([10, 10, 0.5, 50, 30, 0.5])
    expect(big.size).toBe(6)
    expect(big.id).toBe('b')
    expect(s.pts[3]).toBe(30)
  })
})

describe('read-only notes and folders', () => {
  it('a note, or everything in a folder (and its subfolders) – unless a note is set editable anyway', () => {
    const doc = new Y.Doc()
    const top = createFolder(doc, { name: 'Recipes' })
    const sub = createFolder(doc, { name: 'Soups', parentId: top })
    const other = createFolder(doc, { name: 'Work' })
    updateFolder(doc, top, { readOnly: true })
    const rules = folderRules(listFolders(doc))
    expect(rules.get(sub)?.readOnlyBy).toBe(top)
    expect(rules.get(other)?.readOnlyBy).toBeNull()
    expect(noteReadOnly({ readOnly: null, folderId: sub }, rules)).toEqual({ readOnly: true, by: 'folder', folderId: top })
    expect(noteReadOnly({ readOnly: false, folderId: sub }, rules)).toEqual({ readOnly: false, by: 'note', folderId: top })
    expect(noteReadOnly({ readOnly: true, folderId: other }, rules)).toEqual({ readOnly: true, by: 'note', folderId: null })
    expect(noteReadOnly({ readOnly: null, folderId: null }, rules).readOnly).toBe(false)
    const id = createNote(doc, { folderId: other })
    expect(readNote(getNotes(doc).get(id)!).readOnly).toBeNull()
    updateNote(doc, id, { readOnly: true })
    expect(readNote(getNotes(doc).get(id)!).readOnly).toBe(true)
  })
})
