import type { Stroke } from './schema'
import type { Rect } from './ink'
import { segmentLines } from './layout'

/**
 * Where is a word in the handwriting / picture?
 * =============================================
 *
 * Find in note highlights the matching words inside drawings and pictures,
 * not just the whole block. Recognisers that read handwriting (an AI model,
 * Apple Vision on whole lines) give text but no positions per word, so for
 * ink the words are located from the strokes themselves: strokes are grouped
 * into lines and then into words at the widest gaps, and the recognised
 * words are laid onto those groups in reading order. Pictures use the word
 * boxes Apple Vision reports (kept with the note, see `wordsKey`).
 */

export interface WordBox {
  text: string
  box: Rect
}

/** Transcripts-map key holding a picture's word boxes (JSON, see `PictureWords`). */
export const wordsKey = (attachmentId: string) => `words:att:${attachmentId}`

/** Word boxes read from a picture: normalised 0–1, origin top-left, one array per text line. */
export interface PictureWords {
  v: 1
  lines: { t: string; x: number; y: number; w: number; h: number }[][]
}

export function parsePictureWords(json: string | undefined | null): WordBox[][] | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as PictureWords
    if (p?.v !== 1 || !Array.isArray(p.lines)) return null
    return p.lines.map((l) => l.map((w) => ({ text: w.t, box: { x: w.x, y: w.y, w: w.w, h: w.h } })))
  } catch {
    return null
  }
}

/** The text lines of a transcript, without Markdown list/heading/checkbox marks. */
export function transcriptLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:#{1,6}\s+)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s+)?/, '')
        .replace(/\*\*|__|`|~~/g, '')
        .trim(),
    )
    .filter(Boolean)
}

const words = (line: string) => line.split(/\s+/).filter(Boolean)

function strokeBox(s: Stroke): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < s.pts.length; i += 3) {
    minX = Math.min(minX, s.pts[i])
    maxX = Math.max(maxX, s.pts[i])
    minY = Math.min(minY, s.pts[i + 1])
    maxY = Math.max(maxY, s.pts[i + 1])
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function unite(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/**
 * Split one line of ink into `n` word groups at its widest gaps (or, with no
 * `n`, wherever the gap is wide for this writing).
 */
function splitWords(boxes: Rect[], n?: number): Rect[] {
  const sorted = [...boxes].sort((a, b) => a.x - b.x)
  if (!sorted.length) return []
  // gap before each piece, measured from everything to its left
  const gaps: { i: number; gap: number }[] = []
  let right = sorted[0].x + sorted[0].w
  for (let i = 1; i < sorted.length; i++) {
    gaps.push({ i, gap: sorted[i].x - right })
    right = Math.max(right, sorted[i].x + sorted[i].w)
  }
  let cuts: Set<number>
  if (n !== undefined) {
    cuts = new Set([...gaps].sort((a, b) => b.gap - a.gap).slice(0, Math.max(0, n - 1)).map((g) => g.i))
  } else {
    const hs = sorted.map((b) => b.h)
    const m = median(hs)
    const letter = median(hs.filter((h) => h >= m * 0.5)) || m || 30
    cuts = new Set(gaps.filter((g) => g.gap > letter * 0.35).map((g) => g.i))
  }
  const out: Rect[] = []
  sorted.forEach((b, i) => {
    if (i === 0 || cuts.has(i)) out.push({ ...b })
    else out[out.length - 1] = unite(out[out.length - 1], b)
  })
  return out
}

/** Slice a box horizontally, for text that is laid out evenly across it. */
const slice = (b: Rect, from: number, to: number): Rect => ({ x: b.x + b.w * from, y: b.y, w: b.w * (to - from), h: b.h })

/** Spread a line's words across a box by their share of the characters. */
function spread(texts: string[], box: Rect): WordBox[] {
  const total = texts.reduce((n, t) => n + t.length, 0) + Math.max(0, texts.length - 1)
  let at = 0
  return texts.map((text) => {
    const b = slice(box, at / total, (at + text.length) / total)
    at += text.length + 1
    return { text, box: b }
  })
}

/**
 * Lay a drawing's transcript onto its strokes: one array of words (with the
 * box of the ink each was read from) per transcript line.
 */
export function wordsInInk(strokes: Stroke[], transcript: string): WordBox[][] {
  const lines = segmentLines(strokes)
  const texts = transcriptLines(transcript)
  if (!lines.length || !texts.length) return []
  if (lines.length === texts.length) {
    // the usual case: line i of the ink was read as line i of the text
    return texts.map((text, i) => {
      const ws = words(text)
      const boxes = lines[i].strokes.map(strokeBox)
      if (boxes.length < ws.length) return spread(ws, lines[i].bounds)
      const groups = splitWords(boxes, ws.length)
      return ws.map((w, k) => ({ text: w, box: groups[k] }))
    })
  }
  // The lines don't pair up (the recogniser joined or split some): lay all
  // the words in order onto all the word-sized pieces of ink.
  const groups = lines.flatMap((l) => splitWords(l.strokes.map(strokeBox)))
  const all = texts.map(words)
  const count = all.reduce((n, ws) => n + ws.length, 0)
  let k = 0
  return all.map((ws) =>
    ws.map((text) => {
      const a = Math.floor((k * groups.length) / count)
      const b = Math.max(a, Math.ceil(((k + 1) * groups.length) / count) - 1)
      k++
      let box = groups[a]
      // stay on one line of ink: don't stretch a box over two lines
      for (let g = a + 1; g <= b; g++) if (Math.abs(groups[g].y - box.y) < box.h) box = unite(box, groups[g])
      return { text, box }
    }),
  )
}

const norm = (s: string) => s.toLocaleLowerCase()

/**
 * Boxes to highlight for every match of `query` in these lines of words.
 * A match inside a word highlights that part of it; one spanning several
 * words gets one box per line.
 */
export function findWordBoxes(lines: WordBox[][], query: string): Rect[] {
  const q = norm(query.trim().replace(/\s+/g, ' '))
  if (!q) return []
  const out: Rect[] = []
  for (const line of lines) {
    if (!line.length) continue
    const starts: number[] = []
    let text = ''
    for (const w of line) {
      if (text) text += ' '
      starts.push(text.length)
      text += w.text
    }
    const hay = norm(text)
    for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) {
      const end = at + q.length
      let box: Rect | null = null
      for (let i = 0; i < line.length; i++) {
        const w = line[i]
        const ws = starts[i]
        const we = ws + w.text.length
        if (we <= at || ws >= end) continue
        const len = Math.max(1, w.text.length)
        const piece = slice(w.box, (Math.max(at, ws) - ws) / len, (Math.min(end, we) - ws) / len)
        box = box ? unite(box, piece) : piece
      }
      if (box) out.push(box)
    }
  }
  return out
}
