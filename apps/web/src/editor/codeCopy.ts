import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * A small Copy button in the top-right corner of every code block – setup
 * guides are full of commands to paste into a terminal. It copies the
 * block's text exactly, without touching the note or the cursor.
 */

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const DONE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

function button(text: string): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'code-copy'
  b.contentEditable = 'false'
  b.setAttribute('aria-label', 'Copy')
  b.title = 'Copy'
  b.innerHTML = COPY_ICON
  // a tap mustn't move the cursor or bring up the keyboard
  b.addEventListener('pointerdown', (e) => (e.preventDefault(), e.stopPropagation()))
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void copyText(text).then(() => {
      b.innerHTML = DONE_ICON
      b.classList.add('done')
      setTimeout(() => {
        b.innerHTML = COPY_ICON
        b.classList.remove('done')
      }, 1500)
    })
  })
  return b
}

function decorations(doc: PMNode): DecorationSet {
  const out: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true
    const text = node.textContent
    if (text.trim()) out.push(Decoration.widget(pos + 1, () => button(text), { side: -1, ignoreSelection: true, key: `copy:${text}`, stopEvent: () => true }))
    return false
  })
  return DecorationSet.create(doc, out)
}

export const CodeCopy = Extension.create({
  name: 'codeCopy',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('codeCopy'),
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
