import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useRef, useState } from 'react'
import { CalendarDays, Repeat as RepeatIcon, X } from 'lucide-react'
import { Plugin } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { REPEAT_LABELS, daysUntil, formatDue, formatTime, isoDate, newId, nextDue, parseDue, parseRepeat, parseTime, type Repeat } from '@reconnotes/core'
import { showToast } from '../lib/toast'
import { Popover } from '../components/Popover'

/**
 * Due-date chips: type "!friday", "!tomorrow", "!oct 12" or "!2026-10-12"
 * and a space. The date is fixed when typed, so "friday" doesn't move on.
 * "!every monday", "!daily", "!weekly", "!monthly"… repeat: ticking such an
 * item moves it to its next date instead. A time after it ("!fri 3pm",
 * "!tomorrow 9:30am") is when the reminder comes. Tap a chip to change it.
 */

function DueView({ node, updateAttributes, deleteNode, editor }: ReactNodeViewProps) {
  const date = node.attrs.date as string
  const repeat = (node.attrs.repeat as Repeat | null) ?? null
  const time = (node.attrs.time as string | null) ?? null
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const days = daysUntil(date)
  const state = days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 1 ? 'soon' : ''
  return (
    <NodeViewWrapper as="span" className={`due-chip ${state}`} contentEditable={false}>
      <button ref={btn} type="button" onClick={() => editor.isEditable && setOpen(!open)} title={`Due ${date}${time ? ` at ${time}` : ''}${repeat ? ` · ${REPEAT_LABELS[repeat].toLowerCase()}` : ''}`}>
        <CalendarDays size={13} />
        {formatDue(date)}
        {time && <span className="due-time">{formatTime(time)}</span>}
        {repeat && <RepeatIcon size={12} aria-label={REPEAT_LABELS[repeat]} />}
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
          <div className="menu-label">Remind me at</div>
          <div className="due-time-row">
            <input type="time" className="due-input" value={time ?? ''} onChange={(e) => updateAttributes({ time: e.target.value || null })} aria-label="Time" />
            {time && (
              <button className="icon" onClick={() => updateAttributes({ time: null })} aria-label="No time" title="No time (reminded in the morning)">
                <X size={15} />
              </button>
            )}
          </div>
          <div className="menu-label">Repeat</div>
          <select className="due-input" value={repeat ?? ''} onChange={(e) => updateAttributes({ repeat: e.target.value || null })}>
            <option value="">Never</option>
            {(Object.keys(REPEAT_LABELS) as Repeat[]).map((r) => (
              <option key={r} value={r}>
                {REPEAT_LABELS[r]}
              </option>
            ))}
          </select>
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
    return { date: { default: null }, id: { default: null }, repeat: { default: null }, time: { default: null } }
  },

  parseHTML() {
    return [{ tag: 'span[data-due]', getAttrs: (el) => ({ date: (el as HTMLElement).dataset.due, repeat: (el as HTMLElement).dataset.repeat ?? null, time: (el as HTMLElement).dataset.time ?? null, id: newId() }) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-due': node.attrs.date, ...(node.attrs.repeat ? { 'data-repeat': node.attrs.repeat } : {}), ...(node.attrs.time ? { 'data-time': node.attrs.time } : {}) }), `!${node.attrs.date}${node.attrs.time ? `@${node.attrs.time}` : ''}`]
  },

  renderText({ node }) {
    return `!${node.attrs.date}${node.attrs.time ? `@${node.attrs.time}` : ''}`
  },

  addNodeView() {
    return ReactNodeViewRenderer(DueView, { as: 'span', stopEvent: () => true })
  },

  /**
   * Ticking a checklist item with a repeating date moves the date to the
   * next time and leaves the item open (like Reminders). Only for ticks made
   * here – a tick synced from another device was already moved on there.
   */
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null
          const tr = state.tr
          const today = isoDate(new Date())
          let moved: string | null = null
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'taskItem' || !node.attrs.checked) return true
            let changed = false
            node.descendants((child, offset) => {
              if (child.type !== type || !child.attrs.repeat) return true
              const next = nextDue(child.attrs.date, child.attrs.repeat, today)
              tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, date: next })
              moved = next
              changed = true
              return false
            })
            if (changed) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
            return false
          })
          if (!moved) return null
          const next = moved
          setTimeout(() => showToast(`Done – next due: ${formatDue(next)}`), 0)
          return tr
        },
      }),
    ]
  },

  addInputRules() {
    return [
      new InputRule({
        // "!friday ", "!tomorrow ", "!oct 12 ", "!12 oct ", "!2026-10-12 ",
        // "!every monday ", "!every 2 weeks ", "!daily ", "!monthly "
        find: /(?:^|\s)(!(every (?:other )?[a-z0-9]+(?: [a-z]+)?|[a-z]+(?: \d{1,2})?|\d{1,2} [a-z]+|\d{4}-\d{1,2}-\d{1,2}))\s$/i,
        handler: ({ state, range, match }) => {
          const repeating = parseRepeat(match[2])
          const date = repeating?.date ?? parseDue(match[2])
          if (!date) return null
          const start = range.from + match[0].indexOf(match[1])
          state.tr.replaceWith(start, range.to, [this.type.create({ date, id: newId(), repeat: repeating?.repeat ?? null }), state.schema.text(' ')])
        },
      }),
      new InputRule({
        // a time typed just after a date chip ("!fri" then "3pm ", "at 9:30am ", "15:00 "): the chip's time
        find: /(?:at\s*)?(\d{1,2}(?:[:.]\d{2})?\s?(?:am|pm|a|p)?)\s$/i,
        handler: ({ state, range, match }) => {
          const time = parseTime(match[1])
          if (!time) return null
          // the chip right before (with the space after it)
          const $at = state.doc.resolve(range.from)
          let chipPos = -1
          let spaced = true
          const before = $at.nodeBefore
          if (before?.type === this.type) {
            chipPos = range.from - before.nodeSize
            spaced = false
          } else if (before?.isText && before.text === ' ' && range.from - 1 > $at.start()) {
            const prev = state.doc.resolve(range.from - 1).nodeBefore
            if (prev?.type === this.type) chipPos = range.from - 1 - prev.nodeSize
          }
          if (chipPos < 0) return null
          const chip = state.doc.nodeAt(chipPos)!
          state.tr.setNodeMarkup(chipPos, undefined, { ...chip.attrs, time }).delete(range.from, range.to)
          if (!spaced) state.tr.insertText(' ', range.from)
        },
      }),
    ]
  },
})
