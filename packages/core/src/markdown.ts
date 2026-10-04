import * as Y from 'yjs'
import { getContent, getTranscripts } from './schema'

/**
 * Convert a note's rich text to Markdown. Used for human-readable backups,
 * exports and as input for the AI "compile" feature.
 */
export function noteToMarkdown(
  doc: Y.Doc,
  opts: { attachmentUrl?: (id: string) => string; drawingPlaceholder?: (id: string) => string } = {},
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
        else s += inline(child)
      }
    }
    return s
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
      case 'image': {
        const id = el.getAttribute('attachmentId') as string
        const alt = (el.getAttribute('alt') as string) ?? ''
        out.push(`![${alt}](${opts.attachmentUrl ? opts.attachmentUrl(id) : `attachment:${id}`})`)
        break
      }
      case 'audio':
      case 'file': {
        const id = el.getAttribute('attachmentId') as string
        const label = (el.getAttribute('name') as string) ?? name
        out.push(`[${label}](${opts.attachmentUrl ? opts.attachmentUrl(id) : `attachment:${id}`})`)
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
