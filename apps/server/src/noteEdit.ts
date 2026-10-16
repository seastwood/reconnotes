import * as Y from 'yjs'
import { getContent, noteToMarkdown } from '@reconnotes/core'

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
    parts.push(`<${n.nodeName}${n.nodeName === 'taskItem' ? (n.getAttribute('checked') ? '+' : '-') : ''}${n.nodeName === 'heading' ? n.getAttribute('level') : ''}${n.nodeName === 'taskList' && n.getAttribute('kind') === 'list' ? 'o' : ''}>`)
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
/** Blocks as Markdown, to show what a change took out and put in. */
function asMarkdown(nodes: (Y.XmlElement | Y.XmlText)[]): string {
  if (!nodes.length) return ''
  const d = new Y.Doc()
  getContent(d).insert(0, nodes.map((n) => n.clone()))
  const md = noteToMarkdown(d).trim()
  return md.length > 3000 ? md.slice(0, 3000) + '\n…' : md
}

/** What one change did: the note's lines before and after (Markdown). */
export interface Change {
  before: string
  after: string
}

export function applyEdit(frag: Y.XmlFragment, next: Y.XmlFragment): { record: EditRecord; changed: number; changes: Change[] } {
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
  // what each change takes out and puts in (read before the old blocks go)
  const changes = gaps.slice(0, 20).map((g) => ({ before: asMarkdown(before.slice(g.i0, g.i1)), after: asMarkdown(after.slice(g.j0, g.j1)) }))
  // from the end, so the places before stay where they are
  for (const g of [...gaps].reverse()) {
    if (g.i1 > g.i0) frag.delete(g.i0, g.i1 - g.i0)
    const put = after.slice(g.j0, g.j1).map((n) => n.clone())
    if (put.length) frag.insert(g.i0, put)
  }
  record.old = Buffer.from(Y.encodeStateAsUpdate(oldDoc)).toString('base64')
  return { record, changed: gaps.reduce((s, g) => s + Math.max(g.i1 - g.i0, g.j1 - g.j0), 0), changes }
}

/**
 * Take an edit back: each change's blocks swapped for the ones it took out. They're found by their
 * words (nearest to where they were, if the note has changed around them); if any were changed since,
 * nothing is done and null comes back. Else what takes this back in turn (to put the edit back again).
 */
export function revertEdit(frag: Y.XmlFragment, record: EditRecord): EditRecord | null {
  const oldDoc = new Y.Doc()
  Y.applyUpdate(oldDoc, Buffer.from(record.old, 'base64'))
  const old = children(oldDoc.getXmlFragment('old'))
  const now = children(frag)
  const keys = now.map(blockKey)
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
    if (best < 0) return null
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
  // what takes this back: the blocks about to be taken out, and where the old ones will be
  const ascending = record.gaps.map((_, k) => k).sort((x, y) => places[x] - places[y])
  const backDoc = new Y.Doc()
  const backFrag = backDoc.getXmlFragment('old')
  const back: EditRecord = { gaps: [], old: '' }
  let offset = 0
  for (const k of ascending) {
    const g = record.gaps[k]
    const taken = now.slice(places[k], places[k] + g.keys.length).map((n) => n.clone())
    if (taken.length) backFrag.insert(backFrag.length, taken)
    back.gaps.push({ at: places[k] + offset, keys: olds[k].map(blockKey), removed: g.keys.length })
    offset += olds[k].length - g.keys.length
  }
  back.old = Buffer.from(Y.encodeStateAsUpdate(backDoc)).toString('base64')
  for (const k of [...ascending].reverse()) {
    const g = record.gaps[k]
    if (g.keys.length) frag.delete(places[k], g.keys.length)
    if (olds[k].length) frag.insert(places[k], olds[k].map((n) => n.clone()))
  }
  return back
}

/**
 * "Make this a checklist / bulleted / numbered list", of the whole note, done without the AI (when it
 * gave the note back unchanged): each line of text becomes an item – headings, pictures, quotes,
 * tables and lists already there stay as they are. Null: not that kind of request.
 */
export function wholeNoteAsList(md: string, request: string): { markdown: string; said: string } | null {
  const r = request.toLowerCase()
  // about the whole note ("this", "it", "the note"), not a part of it
  if (!/\b(this|it|the note|this note|everything|all of (?:it|this)|the whole (?:note|thing)|the list|these)\b/.test(r)) return null
  if (/\b(under|section|part|paragraph|heading|first|last|only|except|line \d|lines \d)\b/.test(r)) return null
  const kind = /\bnumber(?:ed)?\b/.test(r)
    ? 'numbered'
    : /\bbullet/.test(r)
      ? 'bullets'
      : /\bto-?dos?\b|\btasks?\b/.test(r)
        ? 'todo'
        : /\bcheck ?list|\btick|\bshopping|\bgrocer|\bpacking/.test(r)
          ? 'checklist'
          : null
  if (!kind) return null
  const out: string[] = []
  let inList = false
  let n = 1
  let made = 0
  for (const line of md.split('\n')) {
    const t = line.trim()
    const keep = !t || /^(#|⟦|>|\||```|<!--|[-*+] |\d+[.)] )/.test(t)
    if (keep) {
      if (t) inList = false
      out.push(line)
      continue
    }
    if (!inList) {
      // one list for a run of lines (blank lines between them don't split it)
      while (out.length && !out[out.length - 1].trim()) out.pop()
      if (out.length) out.push('')
      if (kind === 'checklist') out.push('<!-- list -->')
      inList = true
      n = 1
    }
    out.push(kind === 'numbered' ? `${n++}. ${t}` : kind === 'bullets' ? `- ${t}` : `- [ ] ${t}`)
    made++
  }
  if (!made) return null
  const what = kind === 'numbered' ? 'a numbered list' : kind === 'bullets' ? 'a bulleted list' : kind === 'todo' ? 'a to-do list' : 'a checklist'
  return { markdown: out.join('\n'), said: `Made the note ${what}.` }
}

/** A block's words alone (no spaces – compared with what the editor said was selected). */
function bare(node: Y.XmlElement | Y.XmlText): string {
  let out = ''
  const walk = (n: Y.XmlElement | Y.XmlText) => {
    if (n instanceof Y.XmlText) {
      for (const op of n.toDelta() as { insert: unknown }[]) if (typeof op.insert === 'string') out += op.insert
      return
    }
    for (const c of n.toArray()) if (c instanceof Y.XmlElement || c instanceof Y.XmlText) walk(c)
  }
  walk(node)
  return out.replace(/\s+/g, '')
}

/**
 * Where the part selected in the editor is now: its blocks [from, to). Its words say which: where
 * the editor said, if they're still there; else wherever they've moved to. Null: not in the note.
 */
export function findPart(frag: Y.XmlFragment, part: { from: number; to: number; text: string }): { from: number; to: number } | null {
  const texts = children(frag).map(bare)
  const want = part.text.replace(/\s+/g, '')
  if (!want) return null
  const head = want.slice(0, 40)
  const tail = want.slice(-40)
  // all the words in a row, and where each block starts in them
  const starts: number[] = []
  let all = ''
  for (const t of texts) {
    starts.push(all.length)
    all += t
  }
  const blockAt = (c: number) => {
    let b = 0
    while (b + 1 < starts.length && starts[b + 1] <= c) b++
    return b
  }
  const range = (at: number) => {
    const end = all.indexOf(tail, Math.max(at, at + want.length - tail.length - 200))
    if (end < 0) return null
    return { from: blockAt(at), to: blockAt(Math.max(at, end + tail.length - 1)) + 1 }
  }
  // where the editor said, if it's still there
  if (part.from >= 0 && part.to > part.from && part.to <= texts.length) {
    const t = texts.slice(part.from, part.to).join('')
    if (t.includes(head) && t.includes(tail)) return { from: part.from, to: part.to }
  }
  // else the place its words are, nearest to where it was
  let best: { from: number; to: number } | null = null
  for (let at = all.indexOf(head); at >= 0; at = all.indexOf(head, at + 1)) {
    const r = range(at)
    if (r && (!best || Math.abs(r.from - part.from) < Math.abs(best.from - part.from))) best = r
  }
  return best
}
