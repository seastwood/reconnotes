import * as Y from 'yjs'
import { getContent, getTranscripts } from './schema'

/**
 * Convert a note's rich text to Markdown. Used for human-readable backups,
 * exports and as input for the AI "compile" feature.
 */
export function noteToMarkdown(
  doc: Y.Doc,
  opts: {
    attachmentUrl?: (id: string) => string
    drawingPlaceholder?: (id: string) => string
    /** replaces the whole image line (used to splice real images into AI input) */
    imagePlaceholder?: (id: string) => string
    /** replaces the whole recording / file line (keeps them through AI compile) */
    attachmentPlaceholder?: (kind: 'audio' | 'file', id: string, name: string) => string
    /** add the text recognised in pictures and recordings (for AI input) */
    attachmentText?: boolean
  } = {},
): string {
  const transcripts = getTranscripts(doc)
  const out: string[] = []

  const inline = (el: Y.XmlElement | Y.XmlFragment): string => {
    let s = ''
    for (const child of el.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
          if (typeof op.insert !== 'string') continue
          let t = op.insert
          const a = op.attributes ?? {}
          if (a.code) t = '`' + t + '`'
          if (a.bold) t = `**${t}**`
          if (a.italic) t = `*${t}*`
          if (a.strike) t = `~~${t}~~`
          if (a.link && typeof a.link === 'object' && 'href' in (a.link as object)) t = `[${t}](${(a.link as { href: string }).href})`
          s += t
        }
      } else if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'hardBreak') s += '  \n'
        else if (child.nodeName === 'dueDate') s += `!${child.getAttribute('date') as string}`
        else if (child.nodeName === 'noteLink') s += `[[${(child.getAttribute('title') as string) || 'note'}]]`
        else s += inline(child)
      }
    }
    return s
  }

  const attText = (id: string, label: string) => {
    const t = opts.attachmentText ? transcripts.get(`att:${id}`) : undefined
    if (t?.trim()) out.push(`> ${label} ${t.trim().slice(0, 20000).replace(/\n/g, '\n> ')}`)
  }

  const block = (el: Y.XmlElement, indent: string, listMarker?: string) => {
    const name = el.nodeName
    switch (name) {
      case 'paragraph':
        out.push(indent + (listMarker ?? '') + inline(el))
        break
      case 'heading': {
        const level = Number(el.getAttribute('level') ?? 1)
        out.push('#'.repeat(Math.min(6, Math.max(1, level))) + ' ' + inline(el))
        break
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        let n = Number(el.getAttribute('start') ?? 1)
        for (const item of el.toArray()) {
          if (!(item instanceof Y.XmlElement)) continue
          let marker = '- '
          if (name === 'orderedList') marker = `${n++}. `
          if (name === 'taskList') {
            const c = item.getAttribute('checked') as unknown
            marker = c === true || c === 'true' ? '- [x] ' : '- [ ] '
          }
          item.toArray().forEach((child, i) => {
            if (child instanceof Y.XmlElement) block(child, i === 0 ? indent : indent + '  ', i === 0 ? marker : undefined)
          })
        }
        break
      }
      case 'blockquote':
        for (const c of el.toArray()) if (c instanceof Y.XmlElement) block(c, indent + '> ')
        break
      case 'codeBlock':
        out.push(indent + '```' + ((el.getAttribute('language') as string) ?? ''))
        out.push(...inline(el).split('\n').map((l) => indent + l))
        out.push(indent + '```')
        break
      case 'horizontalRule':
        out.push('---')
        break
      case 'table': {
        // GitHub-style table; the first row is the header
        const rows = el.toArray().filter((r): r is Y.XmlElement => r instanceof Y.XmlElement)
        const cells = rows.map((r) =>
          r
            .toArray()
            .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
            .map((c) =>
              c
                .toArray()
                .map((p) => (p instanceof Y.XmlElement ? inline(p) : ''))
                .join(' ')
                .replace(/\|/g, '\\|')
                .replace(/\n/g, ' ')
                .trim(),
            ),
        )
        const width = Math.max(1, ...cells.map((r) => r.length))
        const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
        if (cells.length) {
          out.push(line(cells[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line))
        }
        break
      }
      case 'image': {
        const id = el.getAttribute('attachmentId') as string
        const alt = (el.getAttribute('alt') as string) ?? ''
        if (opts.imagePlaceholder) {
          out.push(opts.imagePlaceholder(id))
          break
        }
        out.push(`![${alt}](${opts.attachmentUrl ? opts.attachmentUrl(id) : `attachment:${id}`})`)
        attText(id, '📷 Text in this picture:')
        break
      }
      case 'audio':
      case 'file': {
        const id = el.getAttribute('attachmentId') as string
        const label = (el.getAttribute('name') as string) ?? name
        if (opts.attachmentPlaceholder) {
          out.push(opts.attachmentPlaceholder(name, id, label))
          break
        }
        out.push(`[${label}](${opts.attachmentUrl ? opts.attachmentUrl(id) : `attachment:${id}`})`)
        attText(id, name === 'audio' ? '🎙️ Transcript of this recording:' : '📄 Text of this file:')
        break
      }
      case 'video': {
        // a link to it: plays in other apps and on GitHub, Obsidian…
        const src = (el.getAttribute('src') as string) ?? ''
        const title = (el.getAttribute('title') as string) || 'Video'
        if (src) out.push(`${indent}▶ [${title.replace(/[[\]]/g, '')}](${src})`)
        break
      }
      case 'drawing': {
        const id = el.getAttribute('drawingId') as string
        if (opts.drawingPlaceholder) out.push(opts.drawingPlaceholder(id))
        const t = transcripts.get(id)
        out.push(t ? `> ✍️ ${t.replace(/\n/g, '\n> ')}` : '> ✍️ (drawing)')
        break
      }
      default:
        out.push(indent + inline(el))
    }
  }

  for (const child of getContent(doc).toArray()) {
    if (child instanceof Y.XmlElement) {
      block(child, '')
      out.push('')
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
