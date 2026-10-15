import { TaskList } from '@tiptap/extension-task-list'
import type { Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Two kinds of checklist
 * ======================
 *
 * A to-do list (square boxes, the default) holds tasks: they show in Tasks, and
 * their dates in Due and reminders. A plain checklist (round checks) is a list
 * you tick through – shopping, packing – and is never taken for tasks; "Uncheck
 * all" makes it ready to use again. Kept on the list as `kind: 'list'`.
 */
export type ListKind = 'todo' | 'list'

export const KindedTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-kind') === 'list' ? 'list' : null),
        renderHTML: (attrs: { kind?: string | null }) => (attrs.kind === 'list' ? { 'data-kind': 'list' } : {}),
      },
    }
  },
})

/** The checklist the cursor is in (the outermost one), with where it is. */
function checklistAt(editor: Editor): { node: PMNode; pos: number } | null {
  const { $from } = editor.state.selection
  for (let d = 1; d <= $from.depth; d++) {
    const node = $from.node(d)
    if (node.type.name === 'taskList') return { node, pos: $from.before(d) }
  }
  return null
}

/** What kind of checklist the cursor is in (null: not in one), and how many of its items are ticked. */
export function checklistInfo(editor: Editor): { kind: ListKind; ticked: number } | null {
  const at = checklistAt(editor)
  if (!at) return null
  let ticked = 0
  at.node.descendants((n) => void (n.type.name === 'taskItem' && n.attrs.checked && ticked++))
  return { kind: at.node.attrs.kind === 'list' ? 'list' : 'todo', ticked }
}

/** Make the checklist the cursor is in this kind (nested checklists too). */
export function setChecklistKind(editor: Editor, kind: ListKind): boolean {
  const at = checklistAt(editor)
  if (!at) return false
  const tr = editor.state.tr
  const set = (n: PMNode, pos: number) => {
    if (n.type.name === 'taskList') tr.setNodeMarkup(pos, undefined, { ...n.attrs, kind: kind === 'list' ? 'list' : null })
  }
  set(at.node, at.pos)
  at.node.descendants((n, p) => set(n, at.pos + 1 + p))
  editor.view.dispatch(tr)
  editor.commands.focus()
  return true
}

/** Untick every item of the checklist the cursor is in – a shopping or packing list, ready again. */
export function uncheckAll(editor: Editor): boolean {
  const at = checklistAt(editor)
  if (!at) return false
  const tr = editor.state.tr
  at.node.descendants((n, p) => {
    if (n.type.name === 'taskItem' && n.attrs.checked) tr.setNodeMarkup(at.pos + 1 + p, undefined, { ...n.attrs, checked: false })
  })
  if (!tr.docChanged) return false
  editor.view.dispatch(tr)
  return true
}
