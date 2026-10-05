import * as Y from 'yjs'
import { getContent, getTranscripts } from './schema'

/**
 * Block-level node names; a newline is emitted after each so extracted text
 * keeps its paragraph structure.
 */
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'image',
  'audio',
  'drawing',
  'horizontalRule',
])

export interface ExtractedNote {
  /** first non-empty line */
  title: string
  /** short preview after the title */
  snippet: string
  /** everything searchable: typed text, transcripts, image/audio text */
  text: string
  /** attachment ids referenced by the note */
  attachments: string[]
  /** drawing ids embedded in the note */
  drawings: string[]
  /** #tags in the note's text (including recognised handwriting), lower case, without # */
  tags: string[]
}

/**
 * #tags: a # followed by letters/digits/-/_ (at least one letter), at the
 * start or after a space or bracket – so "C#", "#1" and URLs with #anchors
 * don't count.
 */
const TAG = /(^|[\s(\[{,;:])#([\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*)/gu

export function extractTags(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(TAG)) {
    const tag = m[2].replace(/[-_]+$/, '').toLocaleLowerCase()
    if (tag && tag.length <= 40) out.add(tag)
  }
  return [...out].sort()
}

/**
 * Pull plain text out of a note document. Works on the server (no DOM) and in
 * the browser. Handwriting transcripts and image OCR text are included so a
 * single search covers everything in the note.
 */
export function extractNote(doc: Y.Doc, extraText: Record<string, string> = {}): ExtractedNote {
  const lines: string[] = []
  const attachments: string[] = []
  const drawings: string[] = []
  const transcripts = getTranscripts(doc)
  let cur = ''

  const flush = () => {
    lines.push(cur)
    cur = ''
  }

  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment) => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as { insert: unknown }[]) {
        if (typeof op.insert === 'string') cur += op.insert
      }
      return
    }
    if (node instanceof Y.XmlElement) {
      const name = node.nodeName
      if (name === 'taskItem') cur += node.getAttribute('checked') === true || node.getAttribute('checked') === 'true' ? '[x] ' : '[ ] '
      if (name === 'hardBreak') {
        flush()
        return
      }
      if (name === 'image' || name === 'audio' || name === 'file') {
        const id = node.getAttribute('attachmentId') as string | undefined
        if (id) {
          attachments.push(id)
          const t = extraText[id] ?? transcripts.get(`att:${id}`)
          if (t) cur += t
        }
        const alt = (node.getAttribute('alt') as string | undefined) ?? (node.getAttribute('name') as string | undefined)
        if (alt) cur += (cur ? ' ' : '') + alt
      }
      if (name === 'drawing') {
        const id = node.getAttribute('drawingId') as string | undefined
        if (id) {
          drawings.push(id)
          const t = transcripts.get(id)
          if (t) cur += t
        }
      }
    }
    node.toArray().forEach((child) => walk(child as Y.XmlElement | Y.XmlText))
    if (node instanceof Y.XmlElement && BLOCKS.has(node.nodeName)) flush()
  }

  walk(getContent(doc))
  if (cur) flush()

  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean)
  const title = (nonEmpty[0] ?? '').replace(/^\[[ x]\] /, '').slice(0, 200)
  const snippet = nonEmpty
    .slice(1)
    .map((l) => l.replace(/^\[[ x]\] /, ''))
    .join(' ')
    .slice(0, 200)
  const text = nonEmpty.join('\n')
  return { title, snippet, text, attachments, drawings, tags: extractTags(text) }
}
