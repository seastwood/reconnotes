import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useRef, useState } from 'react'
import { CalendarDays, X } from 'lucide-react'
import { daysUntil, formatDue, newId, parseDue } from '@reconnotes/core'
import { Popover } from '../components/Popover'

/**
 * Due-date chips: type "!friday", "!tomorrow", "!oct 12" or "!2026-10-12"
 * and a space. The date is fixed when typed, so "friday" doesn't move on.
 * Tap a chip to change or remove the date.
 */

function DueView({ node, updateAttributes, deleteNode, editor }: ReactNodeViewProps) {
  const date = node.attrs.date as string
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const days = daysUntil(date)
  const state = days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 1 ? 'soon' : ''
  return (
    <NodeViewWrapper as="span" className={`due-chip ${state}`} contentEditable={false}>
      <button ref={btn} type="button" onClick={() => editor.isEditable && setOpen(!open)} title={`Due ${date}`}>
        <CalendarDays size={13} />
        {formatDue(date)}
      </button>
      {open && (
        <Popover anchorRef={btn} align="left" onClose={() => setOpen(false)}>
          <div className="menu-label">Due date</div>
          <input
            type="date"
            className="due-input"
            value={date}
            onChange={(e) => e.target.value && updateAttributes({ date: e.target.value })}
          />
          <button onClick={() => deleteNode()}>
            <X size={16} /> Remove due date
          </button>
        </Popover>
      )}
    </NodeViewWrapper>
  )
}

export const DueDate = Node.create({
  name: 'dueDate',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { date: { default: null }, id: { default: null } }
  },

  parseHTML() {
    return [{ tag: 'span[data-due]', getAttrs: (el) => ({ date: (el as HTMLElement).dataset.due, id: newId() }) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-due': node.attrs.date }), `!${node.attrs.date}`]
  },

  renderText({ node }) {
    return `!${node.attrs.date}`
  },

  addNodeView() {
    return ReactNodeViewRenderer(DueView, { as: 'span', stopEvent: () => true })
  },

  addInputRules() {
    return [
      new InputRule({
        // "!friday ", "!tomorrow ", "!oct 12 ", "!12 oct ", "!2026-10-12 "
        find: /(?:^|\s)(!([a-z]+(?: \d{1,2})?|\d{1,2} [a-z]+|\d{4}-\d{1,2}-\d{1,2}))\s$/i,
        handler: ({ state, range, match }) => {
          const date = parseDue(match[2])
          if (!date) return null
          const start = range.from + match[0].indexOf(match[1])
          state.tr.replaceWith(start, range.to, [this.type.create({ date, id: newId() }), state.schema.text(' ')])
        },
      }),
    ]
  },
})
