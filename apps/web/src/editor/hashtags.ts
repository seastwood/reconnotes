import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * #tags in the text are shown as tag chips. Tapping one reports it (with
 * where it is on screen) so the editor can offer "show notes tagged #…".
 * Matches the rule in @reconnotes/core's extractTags.
 */
const TAG = /(^|[\s(\[{,;:])#([\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*)/gu

export interface HashtagOptions {
  onTagClick: (tag: string, rect: DOMRect) => void
}

function decorate(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    if (node.marks.some((m) => m.type.name === 'code')) return
    for (const m of node.text.matchAll(TAG)) {
      const start = pos + (m.index ?? 0) + m[1].length
      const tag = m[2].replace(/[-_]+$/, '')
      decos.push(Decoration.inline(start, start + 1 + tag.length, { class: 'hashtag', 'data-tag': tag.toLocaleLowerCase() }))
    }
  })
  return DecorationSet.create(doc, decos)
}

export const Hashtags = Extension.create<HashtagOptions>({
  name: 'hashtags',
  addOptions() {
    return { onTagClick: () => undefined }
  },
  addProseMirrorPlugins() {
    const opts = this.options
    const key = new PluginKey<DecorationSet>('hashtags')
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (view, _pos, event) => {
            const el = (event.target as HTMLElement).closest?.('.hashtag') as HTMLElement | null
            if (el?.dataset.tag) opts.onTagClick(el.dataset.tag, el.getBoundingClientRect())
            return false // the cursor still goes there, so tags stay easy to edit
          },
        },
      }),
    ]
  },
})
