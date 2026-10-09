import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { playListenLink } from '../lib/replay'
import { showToast } from '../lib/toast'

/**
 * A meeting note's ▶ links (listen:<recording>@<seconds>) shown as real
 * buttons. A link inside the editable note is text to iOS Safari: a tap puts
 * the cursor there (and brings up the keyboard) rather than following it. So
 * the link's text is hidden and a button stands in its place – not part of
 * the text, it plays the recording from that moment and leaves the cursor
 * and keyboard alone. The note itself still holds the link (exports, print).
 */

function button(href: string, label: string): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'listen-button'
  b.contentEditable = 'false'
  b.textContent = label
  b.title = 'Play the recording from here'
  // not a tap into the text: no cursor, no keyboard
  b.addEventListener('pointerdown', (e) => (e.preventDefault(), e.stopPropagation()))
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true })
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    playListenLink(href, showToast)
  })
  return b
}

function decorations(doc: PMNode): DecorationSet {
  const out: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const link = node.marks.find((m) => m.type.name === 'link' && String(m.attrs.href ?? '').startsWith('listen:'))
    if (!link) return false
    const href = String(link.attrs.href)
    const label = node.text?.trim() || '▶'
    out.push(Decoration.widget(pos, () => button(href, label), { side: -1, ignoreSelection: true, key: `listen:${href}:${label}`, stopEvent: () => true }))
    out.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'listen-text' }))
    return false
  })
  return DecorationSet.create(doc, out)
}

export const ListenButtons = Extension.create({
  name: 'listenButtons',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('listenButtons'),
        state: {
          init: (_, state) => decorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})
