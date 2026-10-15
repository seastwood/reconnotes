import * as Y from 'yjs'

/**
 * Editing a note with AI ("Edit" in the chat)
 * ============================================
 *
 * The AI writes the whole note back with the change made. Only the blocks that
 * really changed are swapped in: the rest stay the very same blocks (their
 * colours, ticks, drawings and anything typed meanwhile untouched). What was
 * taken out is kept, so Revert puts exactly that back.
 */

/** A block's words and shape, to tell the same block in the old note and the AI's version. */
export function blockKey(node: Y.XmlElement | Y.XmlText): string {
  const parts: string[] = []
  const walk = (n: Y.XmlElement | Y.XmlText) => {
    if (n instanceof Y.XmlText) {
      for (const op of n.toDelta() as { insert: unknown }[]) if (typeof op.insert === 'string') parts.push(op.insert)
      return
    }
    parts.push(`<${n.nodeName}${n.nodeName === 'taskItem' ? (n.getAttribute('checked') ? '+' : '-') : ''}${n.nodeName === 'heading' ? n.getAttribute('level') : ''}>`)
    // links to notes, due dates, pictures and recordings: what they point at
    for (const a of ['noteId', 'date', 'attachmentId', 'drawingId']) {
      const v = n.getAttribute(a)
      if (v) parts.push(`${a}=${v}`)
    }
    for (const c of n.toArray()) if (c instanceof Y.XmlElement || c instanceof Y.XmlText) walk(c)
  }
  walk(node)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

export interface Gap {
  /** old blocks [i0, i1) become new blocks [j0, j1) */
  i0: number
  i1: number
  j0: number
  j1: number
}

/** Where two lists of blocks differ: the stretches between the blocks they share (longest common run). */
export function diffBlocks(a: string[], b: string[]): Gap[] {
  const n = a.length
  const m = b.length
  // longest common subsequence, from the end
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const gaps: Gap[] = []
  let i = 0
  let j = 0
  let open: Gap | null = null
  const close = () => {
    if (open && (open.i1 > open.i0 || open.j1 > open.j0)) gaps.push(open)
    open = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close()
      i++
      j++
      continue
    }
    open ??= { i0: i, i1: i, j0: j, j1: j }
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) open.j1 = ++j
    else open.i1 = ++i
  }
  close()
  return gaps
}

/** What an edit changed, to take it back. */
export interface EditRecord {
  /** each change: where it is now, the blocks it put there (by their keys), and how many old blocks it took out */
  gaps: { at: number; keys: string[]; removed: number }[]
  /** the blocks taken out, in order (a Yjs update of a fragment named "old") */
  old: string
}

const children = (f: Y.XmlFragment) => f.toArray().filter((c): c is Y.XmlElement | Y.XmlText => c instanceof Y.XmlElement || c instanceof Y.XmlText)

/**
 * Put the AI's version into the note: only the blocks that differ change. `next`: its blocks, in a
 * fragment of their own (already in a document, so they can be compared and copied).
 */
export function applyEdit(frag: Y.XmlFragment, next: Y.XmlFragment): { record: EditRecord; changed: number } {
  const before = children(frag)
  const after = children(next)
  const gaps = diffBlocks(before.map(blockKey), after.map(blockKey))
  const oldDoc = new Y.Doc()
  const oldFrag = oldDoc.getXmlFragment('old')
  const record: EditRecord = { gaps: [], old: '' }
  for (const g of gaps) {
    const taken = before.slice(g.i0, g.i1).map((n) => n.clone())
    if (taken.length) oldFrag.insert(oldFrag.length, taken)
    record.gaps.push({ at: g.j0, keys: after.slice(g.j0, g.j1).map(blockKey), removed: g.i1 - g.i0 })
  }
  // from the end, so the places before stay where they are
  for (const g of [...gaps].reverse()) {
    if (g.i1 > g.i0) frag.delete(g.i0, g.i1 - g.i0)
    const put = after.slice(g.j0, g.j1).map((n) => n.clone())
    if (put.length) frag.insert(g.i0, put)
  }
  record.old = Buffer.from(Y.encodeStateAsUpdate(oldDoc)).toString('base64')
  return { record, changed: gaps.reduce((s, g) => s + Math.max(g.i1 - g.i0, g.j1 - g.j0), 0) }
}

/**
 * Take an edit back: each change's blocks swapped for the ones it took out. They're found by their
 * words (nearest to where they were, if the note has changed around them); if any were changed since,
 * nothing is done and false comes back.
 */
export function revertEdit(frag: Y.XmlFragment, record: EditRecord): boolean {
  const oldDoc = new Y.Doc()
  Y.applyUpdate(oldDoc, Buffer.from(record.old, 'base64'))
  const old = children(oldDoc.getXmlFragment('old'))
  const keys = children(frag).map(blockKey)
  // where each change's blocks are now
  const places: number[] = []
  let shift = 0
  for (const g of record.gaps) {
    const want = g.at + shift
    let best = -1
    if (!g.keys.length) best = Math.min(Math.max(0, want), keys.length)
    else
      for (let p = 0; p + g.keys.length <= keys.length; p++) {
        if (g.keys.every((k, x) => keys[p + x] === k) && !places.includes(p) && (best < 0 || Math.abs(p - want) < Math.abs(best - want))) best = p
      }
    if (best < 0) return false
    places.push(best)
    shift = best - g.at
  }
  // the old blocks of each change, in order
  let from = 0
  const olds = record.gaps.map((g) => {
    const part = old.slice(from, from + g.removed)
    from += g.removed
    return part
  })
  const order = record.gaps.map((_, k) => k).sort((x, y) => places[y] - places[x])
  for (const k of order) {
    const g = record.gaps[k]
    if (g.keys.length) frag.delete(places[k], g.keys.length)
    if (olds[k].length) frag.insert(places[k], olds[k].map((n) => n.clone()))
  }
  return true
}
