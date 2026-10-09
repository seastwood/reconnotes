import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Fragment, Slice as PMSlice, type Node as PMNode, type Slice } from '@tiptap/pm/model'
import type * as Y from 'yjs'
import { copyRich } from './blockClipboard'
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
 * - Press and hold a checkbox, then let go, to copy that item (and its
 *   sub-items) – with its pictures, for other apps as well as ReconNotes.
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
    // a meeting note's ▶ link into its recording means nothing outside the note
    if (c.isText && c.marks.some((m) => m.type.name === 'link' && String(m.attrs.href ?? '').startsWith('listen:'))) return
    if (c.isText) s += c.text
    else if (c.type.name === 'hardBreak') s += '\n'
    else if (c.type.name === 'dueDate') s += `!${c.attrs.date}`
    else if (c.type.name === 'noteLink') s += `[[${c.attrs.title || 'note'}]]`
    else s += c.textContent
  })
  return s.replace(/ {2,}/g, ' ').replace(/ +$/, '')
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

/** A position inside a checklist item's text (its row starts with the checkbox, which isn't part of the text). */
function textPosIn(view: EditorView, li: HTMLElement): number {
  const pos = view.posAtDOM((li.querySelector(':scope > div') as HTMLElement | null) ?? li, 0)
  if (pos < 0) throw new RangeError('not in the note')
  return pos
}

/**
 * Move a just-ticked item to just below the last unticked one in its list
 * (and a just-unticked one up, to just after the other unticked items).
 */
export function sortItem(view: EditorView, li: HTMLElement) {
  if (!li.isConnected) return
  let inside: number
  try {
    inside = textPosIn(view, li)
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

/** Copy the checklist item at `pos` (and its sub-items, with their pictures). */
export function copyChecklistItem(view: EditorView, pos: number, doc: Y.Doc | null) {
  if (pos > view.state.doc.content.size) return
  const $pos = view.state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name !== 'taskItem') continue
    const children: PMNode[] = []
    node.forEach((c) => children.push(c))
    const [first, ...rest] = children
    const text = [first?.isTextblock ? inlineText(first) : '', ...blocksToText(rest, '  ')].join('\n').trim()
    const label = text ? `“${text.length > 40 ? text.slice(0, 40) + '…' : text}”` : 'the item'
    let pictures = 0
    node.descendants((n) => void (n.type.name === 'image' && pictures++))
    const done = (ok: boolean) =>
      showToast(ok ? `Copied ${label}${pictures ? ` with ${pictures} picture${pictures === 1 ? '' : 's'}` : ''}` : 'Couldn’t copy – select the text and use Copy instead')
    if (doc) {
      // the item in its checklist, so it pastes back as a checklist item
      const slice = new PMSlice(Fragment.from(view.state.schema.nodes.taskList.create($pos.node(d - 1).attrs, node)), 0, 0)
      void copyRich(view, slice, doc).then(done)
    } else if (text) void copyText(text).then(() => done(true))
    return
  }
}

export const ChecklistClipboard = Extension.create<{ doc: Y.Doc | null }>({
  name: 'checklistClipboard',
  addOptions() {
    return { doc: null }
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    const doc = this.options.doc
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointer: number } | null = null
    /**
     * Held long enough: the item (its place in the note) is copied when the
     * finger lifts – browsers only allow the clipboard then. The highlight is
     * drawn over the note, not in it (the editor would redraw the item).
     */
    let armed: { pos: number; mark: HTMLElement } | null = null
    const cancel = () => {
      if (hold) clearTimeout(hold.timer)
      hold = null
    }
    const disarm = () => {
      armed?.mark.remove()
      armed = null
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
              disarm()
              let pos: number
              try {
                pos = textPosIn(view, li)
              } catch {
                return false
              }
              hold = {
                x: e.clientX,
                y: e.clientY,
                pointer: e.pointerId,
                timer: setTimeout(() => {
                  cancel()
                  // held: show it, and copy on release
                  const r = box.getBoundingClientRect()
                  const mark = document.createElement('div')
                  mark.className = 'copy-armed'
                  mark.style.cssText = `left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px`
                  document.body.appendChild(mark)
                  armed = { pos, mark }
                  navigator.vibrate?.(10)
                }, HOLD_MS),
              }
              return false
            },
            pointermove: (_view, e) => {
              if (hold && e.pointerId === hold.pointer && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) cancel()
              return false
            },
            pointerup: (view) => {
              cancel()
              const was = armed
              disarm()
              if (!was) return false
              copyChecklistItem(view, was.pos, doc)
              // the click that ends the hold mustn't tick the box
              const swallow = (ev: Event) => {
                ev.preventDefault()
                ev.stopPropagation()
              }
              window.addEventListener('click', swallow, { capture: true, once: true })
              setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 800)
              return true
            },
            // ticking a box: after a moment, move the item below the unticked ones
            change: (view, e) => {
              const input = e.target as HTMLInputElement
              const li = input.closest?.('ul[data-type="taskList"] > li') as HTMLElement | null
              if (!li || input.type !== 'checkbox' || settings.get().sortChecked === false) return false
              setTimeout(() => sortItem(view, li), 350)
              return false
            },
            pointercancel: () => (cancel(), disarm(), false),
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
