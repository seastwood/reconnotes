import * as Y from 'yjs'
import { getContent, getTranscripts } from '@reconnotes/core'
import type { Store } from './store'

/**
 * A note in its parts: typed text, handwriting (its recognised text), pictures,
 * recordings and files (their text) – so search can say where something
 * matched, and find notes that have handwriting, a checklist…
 */

export type PieceKind = 'text' | 'handwriting' | 'picture' | 'recording' | 'file'
export interface Piece {
  kind: PieceKind
  text: string
}
export interface NotePieces {
  pieces: Piece[]
  /** what's in the note, for has: searches */
  has: Set<PieceKind | 'checklist' | 'link' | 'table'>
}

export function notePieces(doc: Y.Doc, store: Store): NotePieces {
  const transcripts = getTranscripts(doc)
  const pieces: Piece[] = []
  const has = new Set<NotePieces['has'] extends Set<infer T> ? T : never>()
  let typed: string[] = []
  let line = ''
  const flush = () => {
    if (line.trim()) typed.push(line.trim())
    line = ''
  }
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment) => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof op.insert === 'string') line += op.insert
        if (op.attributes?.link || op.attributes?.noteLink) has.add('link')
      }
      return
    }
    if (node instanceof Y.XmlElement) {
      const name = node.nodeName
      if (name === 'taskItem' || name === 'taskList') has.add('checklist')
      if (name === 'table') has.add('table')
      if (name === 'noteLink') has.add('link')
      if (name === 'drawing') {
        flush()
        has.add('handwriting')
        const t = transcripts.get(String(node.getAttribute('drawingId') ?? ''))
        if (t) pieces.push({ kind: 'handwriting', text: t })
        return
      }
      if (name === 'image' || name === 'audio' || name === 'file') {
        flush()
        const kind: PieceKind = name === 'image' ? 'picture' : name === 'audio' ? 'recording' : 'file'
        has.add(kind)
        const id = String(node.getAttribute('attachmentId') ?? '')
        const t = (id && (store.getAttachment(id)?.text ?? transcripts.get(`att:${id}`))) || ''
        const label = String(node.getAttribute('name') ?? node.getAttribute('alt') ?? '')
        if (t || label) pieces.push({ kind, text: [label, t].filter(Boolean).join(' – ') })
        // a picture marked up with the pen: its writing counts as handwriting
        const ink = node.getAttribute('drawingId') as string | undefined
        const inkText = ink ? transcripts.get(ink) : undefined
        if (inkText) pieces.push({ kind: 'handwriting', text: inkText })
        return
      }
    }
    for (const c of node.toArray()) walk(c as Y.XmlElement | Y.XmlText)
    if (node instanceof Y.XmlElement && /^(paragraph|heading|listItem|taskItem|codeBlock|blockquote|tableCell|tableHeader)$/.test(node.nodeName)) flush()
  }
  walk(getContent(doc))
  flush()
  if (typed.length) {
    has.add('text')
    pieces.unshift({ kind: 'text', text: typed.join('\n') })
  }
  typed = []
  return { pieces, has }
}

const norm = (s: string) => s.toLowerCase()

/**
 * Where a search matched: the part with the most of its words (typed text
 * first when tied), and the line around the first of them.
 */
export function whereMatched(pieces: Piece[], terms: string[]): { kind: PieceKind; line: string } | null {
  const ts = terms.map(norm).filter((t) => t.length >= 2)
  if (!ts.length) return null
  let best: { kind: PieceKind; line: string; score: number } | null = null
  for (const p of pieces) {
    const low = norm(p.text)
    // a word counts when it starts a word in the text (so "wir" matches "wiring")
    const found = ts.filter((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(low))
    if (!found.length || (best && found.length <= best.score)) continue
    const lines = p.text.split(/\n+/)
    const hit = lines.find((l) => found.some((t) => norm(l).includes(t))) ?? lines[0]
    const at = Math.max(0, norm(hit).indexOf(found[0]) - 50)
    const line = (at > 0 ? '…' : '') + hit.slice(at, at + 160).trim() + (hit.length > at + 160 ? '…' : '')
    best = { kind: p.kind, line, score: found.length }
  }
  return best && { kind: best.kind, line: best.line }
}
