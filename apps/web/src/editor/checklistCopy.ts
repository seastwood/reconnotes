import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { Node as PMNode, Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { markdownToHtml } from '../lib/ai'
import { showToast } from '../lib/toast'
import { settings } from '../lib/settings'

/**
 * Checklists and the clipboard
 * ============================
 *
 * - Copying lists gives Markdown-style plain text ("- [ ] milk", "- [x] eggs",
 *   "- bread", "1. step"), which reads well anywhere and pastes back into
 *   ReconNotes, Obsidian, GitHub… as a real checklist. (Copying inside one
 *   line still gives just the text.)
 * - Pasting such plain text turns it back into a checklist / list.
 * - Press and hold a checkbox to copy that item's text (and its sub-items).
 */

/** Blocks as Markdown-ish lines: lists keep their markers, the rest plain text. */
export function blocksToText(nodes: PMNode[], indent = ''): string[] {
  const lines: string[] = []
  for (const node of nodes) {
    const name = node.type.name
    if (name === 'taskList' || name === 'bulletList' || name === 'orderedList') {
      let n = (node.attrs.start as number) ?? 1
      node.forEach((item) => {
        const marker = name === 'taskList' ? (item.attrs.checked ? '- [x] ' : '- [ ] ') : name === 'orderedList' ? `${n++}. ` : '- '
        const children: PMNode[] = []
        item.forEach((c) => children.push(c))
        const [first, ...rest] = children
        lines.push(indent + marker + (first?.isTextblock ? inlineText(first) : ''))
        lines.push(...blocksToText(first && !first.isTextblock ? children : rest, indent + '  '))
      })
    } else if (node.isTextblock) {
      lines.push(indent + inlineText(node))
    } else if (node.childCount) {
      const children: PMNode[] = []
      node.forEach((c) => children.push(c))
      lines.push(...blocksToText(children, indent))
    }
  }
  return lines
}

/** A text block's text, with due dates and note links as they read. */
function inlineText(node: PMNode): string {
  let s = ''
  node.forEach((c) => {
    if (c.isText) s += c.text
    else if (c.type.name === 'hardBreak') s += '\n'
    else if (c.type.name === 'dueDate') s += `!${c.attrs.date}`
    else if (c.type.name === 'noteLink') s += `[[${c.attrs.title || 'note'}]]`
    else s += c.textContent
  })
  return s
}

function sliceToText(slice: Slice): string {
  // inside a single line (part of one item or paragraph): just the text
  let frag = slice.content
  while (frag.childCount === 1 && !frag.firstChild!.isTextblock && !frag.firstChild!.isLeaf) {
    const only = frag.firstChild!
    // a whole list item or more is selected once we reach the list with several items
    if ((only.type.name === 'taskList' || only.type.name === 'bulletList' || only.type.name === 'orderedList') && only.childCount > 1) break
    if (only.type.name === 'taskItem' || only.type.name === 'listItem') {
      if (only.childCount > 1) break
    }
    frag = only.content
  }
  if (frag.childCount === 1 && frag.firstChild!.isTextblock && slice.openStart > 0) return inlineText(frag.firstChild!)
  const nodes: PMNode[] = []
  slice.content.forEach((n) => nodes.push(n))
  return blocksToText(nodes).join('\n').replace(/\s+$/, '')
}

/** Plain text that's a Markdown checklist or list (every line a list item). */
const LIST_LINE = /^\s*(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )\S/
function looksLikeList(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return lines.length > 0 && lines.every((l) => LIST_LINE.test(l)) && lines.some((l) => /\[[ xX]\]/.test(l) || lines.length > 1)
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

const HOLD_MS = 500

/**
 * Move a just-ticked item to just below the last unticked one in its list
 * (and a just-unticked one up, to just after the other unticked items).
 */
export function sortItem(view: EditorView, li: HTMLElement) {
  if (!li.isConnected) return
  let inside: number
  try {
    inside = view.posAtDOM(li, 0)
  } catch {
    return
  }
  const { state } = view
  const $pos = state.doc.resolve(inside)
  let depth = -1
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'taskItem') {
      depth = d
      break
    }
  }
  if (depth < 1) return
  const list = $pos.node(depth - 1)
  const index = $pos.index(depth - 1)
  const item = list.child(index)
  const others: PMNode[] = []
  list.forEach((c, _o, i) => i !== index && others.push(c))
  // ticked: right after the last unticked item; unticked: right before the first ticked one
  let slot: number
  if (item.attrs.checked) {
    slot = 0
    others.forEach((c, i) => {
      if (!c.attrs.checked) slot = i + 1
    })
  } else {
    slot = others.findIndex((c) => c.attrs.checked)
    if (slot < 0) slot = others.length
  }
  if (slot === index) return // already there
  const itemPos = $pos.before(depth)
  const tr = state.tr.delete(itemPos, itemPos + item.nodeSize)
  let at = $pos.before(depth - 1) + 1
  for (let i = 0; i < slot; i++) at += others[i].nodeSize
  tr.insert(at, item)
  view.dispatch(tr.setMeta('addToHistory', true))
}

export const ChecklistClipboard = Extension.create({
  name: 'checklistClipboard',
  addProseMirrorPlugins() {
    const editor = this.editor
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointer: number } | null = null
    const cancel = () => {
      if (hold) clearTimeout(hold.timer)
      hold = null
    }

    /** Press and hold a checkbox: copy that item. */
    const copyItem = (view: EditorView, li: HTMLElement) => {
      let pos: number
      try {
        pos = view.posAtDOM(li, 0)
      } catch {
        return
      }
      const $pos = view.state.doc.resolve(pos)
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d)
        if (node.type.name !== 'taskItem') continue
        const children: PMNode[] = []
        node.forEach((c) => children.push(c))
        const [first, ...rest] = children
        const text = [first?.isTextblock ? inlineText(first) : '', ...blocksToText(rest, '  ')].join('\n').trim()
        if (!text) return
        void copyText(text).then(() => showToast(`Copied “${text.length > 40 ? text.slice(0, 40) + '…' : text}”`))
        navigator.vibrate?.(10)
        // the click that ends the hold mustn't tick the box
        const swallow = (e: Event) => {
          e.preventDefault()
          e.stopPropagation()
        }
        li.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => li.removeEventListener('click', swallow, { capture: true }), 800)
        return
      }
    }

    return [
      new Plugin({
        props: {
          clipboardTextSerializer: (slice) => sliceToText(slice),
          handlePaste: (_view, event) => {
            const data = event.clipboardData
            if (!data || data.types.includes('text/html')) return false
            const text = data.getData('text/plain')
            if (!looksLikeList(text)) return false
            editor.chain().focus().insertContent(markdownToHtml(text)).run()
            return true
          },
          handleDOMEvents: {
            pointerdown: (view, e) => {
              const box = (e.target as HTMLElement).closest?.('ul[data-type="taskList"] > li > label')
              if (!box) return false
              const li = box.parentElement as HTMLElement
              cancel()
              hold = { x: e.clientX, y: e.clientY, pointer: e.pointerId, timer: setTimeout(() => (cancel(), copyItem(view, li)), HOLD_MS) }
              return false
            },
            pointermove: (_view, e) => {
              if (hold && e.pointerId === hold.pointer && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) cancel()
              return false
            },
            pointerup: () => (cancel(), false),
            // ticking a box: after a moment, move the item below the unticked ones
            change: (view, e) => {
              const input = e.target as HTMLInputElement
              const li = input.closest?.('ul[data-type="taskList"] > li') as HTMLElement | null
              if (!li || input.type !== 'checkbox' || settings.get().sortChecked === false) return false
              setTimeout(() => sortItem(view, li), 350)
              return false
            },
            pointercancel: () => (cancel(), false),
            // no iOS callout / menu on a held checkbox
            contextmenu: (_view, e) => {
              if ((e.target as HTMLElement).closest?.('ul[data-type="taskList"] > li > label')) {
                e.preventDefault()
                return true
              }
              return false
            },
          },
        },
      }),
    ]
  },
})
