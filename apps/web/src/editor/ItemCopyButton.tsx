import { useEffect, useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { Copy } from 'lucide-react'
import type * as Y from 'yjs'
import { copyChecklistItem } from './checklistCopy'

/**
 * A small Copy button next to the checklist item the cursor is in – a plain
 * tap, which iOS always lets copy (pressing and holding the checkbox does too,
 * where it can). It sits after the item's text, or at the right edge just
 * under it when the line is full, so it's never over what you're reading.
 */
export function ItemCopyButton({ editor, doc }: { editor: Editor; doc: Y.Doc | null }) {
  const at = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { selection } = e.state
      if (!selection.empty || !e.isFocused || !e.isEditable) return null
      const $pos = selection.$from
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.name !== 'taskItem') continue
        const item = $pos.start(d)
        const first = $pos.node(d).firstChild
        if (!first?.isTextblock || !first.content.size) return null
        return { item, end: item + first.nodeSize - 1 }
      }
      return null
    },
    equalityFn: (a, b) => a?.item === b?.item && a?.end === b?.end,
  })
  // follow the text as the note scrolls or the keyboard moves things
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!at) return
    const r = () => redraw((n) => n + 1)
    window.addEventListener('scroll', r, { capture: true, passive: true })
    window.addEventListener('resize', r)
    window.visualViewport?.addEventListener('resize', r)
    return () => {
      window.removeEventListener('scroll', r, { capture: true })
      window.removeEventListener('resize', r)
      window.visualViewport?.removeEventListener('resize', r)
    }
  }, [at])
  if (!at) return null
  let pos: { left: number; top: number }
  try {
    const view = editor.view
    const end = view.coordsAtPos(at.end)
    const box = view.dom.getBoundingClientRect()
    const pad = parseFloat(getComputedStyle(view.dom).paddingRight) || 0
    const right = box.right - Math.max(0, pad - 30)
    const size = 28
    pos = end.right + 6 + size <= right ? { left: end.right + 6, top: (end.top + end.bottom) / 2 - size / 2 } : { left: right - size, top: end.bottom + 2 }
  } catch {
    return null
  }
  return (
    <button
      className="item-copy"
      style={{ left: pos.left, top: pos.top }}
      // keep the cursor (and the keyboard) where they are
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => copyChecklistItem(editor.view, at.item, doc)}
      aria-label="Copy this item"
      title="Copy this item"
    >
      <Copy size={14} />
    </button>
  )
}
