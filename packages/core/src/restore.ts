import * as Y from 'yjs'
import { CONTENT_FIELD, DRAWINGS_FIELD, TRANSCRIPTS_FIELD } from './schema'

const INK_PREFIX = 'ink:'

/**
 * Make `target` (the live note) look like `source` (an older version):
 * text, drawings' ink, drawing sizes and recognised text. Done as ordinary
 * edits, so it syncs to every device and merges like any other change.
 */
export function restoreNoteContent(target: Y.Doc, source: Y.Doc) {
  target.transact(() => {
    const to = target.getXmlFragment(CONTENT_FIELD)
    const from = source.getXmlFragment(CONTENT_FIELD)
    if (to.length) to.delete(0, to.length)
    const nodes = from.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone())
    if (nodes.length) to.insert(0, nodes)

    for (const key of source.share.keys()) {
      if (!key.startsWith(INK_PREFIX)) continue
      const src = source.getArray(key)
      const dst = target.getArray(key)
      if (dst.length) dst.delete(0, dst.length)
      if (src.length) dst.insert(0, src.toArray())
    }

    for (const field of [DRAWINGS_FIELD, TRANSCRIPTS_FIELD]) {
      const src = source.getMap(field)
      const dst = target.getMap(field)
      for (const k of [...dst.keys()]) if (!src.has(k)) dst.delete(k)
      src.forEach((v, k) => dst.set(k, v))
    }
  })
}
