import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * Indenting text
 * ==============
 *
 * A list item nests under the one before it (as Tab does); any other line of
 * text – a paragraph, a heading – moves in a step (up to 8), kept with the
 * note. With a finger: swipe right over a line to indent it, left to outdent.
 */

const MAX = 8
const TEXT = ['paragraph', 'heading']

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockIndent: {
      /** move the text blocks in the selection in (1) or out (-1) a step – not ones in a list */
      blockIndent: (dir: 1 | -1) => ReturnType
    }
  }
}

/** the list item kind at the cursor, if it's in a list */
const listItemAt = (editor: Editor) => (editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null)

/** Indent (1) or outdent (-1) what's at the cursor: a list item nests, any other text moves a step. */
export function indentAt(editor: Editor, dir: 1 | -1, focus = true): boolean {
  const item = listItemAt(editor)
  const chain = focus ? editor.chain().focus() : editor.chain()
  if (item) return dir > 0 ? chain.sinkListItem(item).run() : chain.liftListItem(item).run()
  return chain.blockIndent(dir).run()
}

/** Whether indenting (1) or outdenting (-1) would do anything at the cursor. */
export function canIndentAt(editor: Editor, dir: 1 | -1): boolean {
  const item = listItemAt(editor)
  if (item) return dir > 0 ? editor.can().sinkListItem(item) : editor.can().liftListItem(item)
  return editor.can().blockIndent(dir)
}

/** where a swipe can't indent: things that scroll sideways themselves, or aren't text */
const NOT_TEXT = 'table, pre, .tableWrapper, [data-drawing], .drawing-block, .image-block, .audio-block, .file-block, .video-block, button, input, textarea'

export const BlockIndent = Extension.create({
  name: 'blockIndent',

  addGlobalAttributes() {
    return [
      {
        types: TEXT,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => Math.max(0, Math.min(MAX, Number(el.getAttribute('data-indent')) || 0)),
            renderHTML: (attrs) => (attrs.indent ? { 'data-indent': attrs.indent, style: `margin-inline-start: ${attrs.indent * 1.5}em` } : {}),
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      blockIndent:
        (dir) =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection
          let changed = false
          state.doc.nodesBetween(from, to, (node, pos, parent) => {
            if (!TEXT.includes(node.type.name)) return true
            // a list item's text: the list item nests instead
            if (parent && /^(listItem|taskItem)$/.test(parent.type.name)) return false
            const now = Number(node.attrs.indent) || 0
            const next = Math.max(0, Math.min(MAX, now + dir))
            if (next !== now) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
              changed = true
            }
            return false
          })
          if (changed && dispatch) dispatch(tr)
          return changed
        },
    }
  },

  // Tab / ⇧Tab: plain text too (a table's Tab still moves between cells, code keeps its tabs)
  addKeyboardShortcuts() {
    const step = (dir: 1 | -1) => () => {
      const e = this.editor
      if (e.isActive('table') || e.isActive('codeBlock')) return false
      return indentAt(e, dir, false)
    }
    return { Tab: step(1), 'Shift-Tab': step(-1) }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    // a finger swiping sideways over a line of text (not the Pencil, not from a screen edge –
    // those step back and forward through links – and not over a table or a drawing)
    let start: { x: number; y: number; t: number } | null = null
    const EDGE = 28
    const touchType = (t: Touch) => (t as Touch & { touchType?: string }).touchType
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            touchstart: (_view: EditorView, e: TouchEvent) => {
              const t = e.touches[0]
              const target = e.target as Element
              start =
                e.touches.length === 1 &&
                touchType(t) !== 'stylus' &&
                t.clientX > EDGE &&
                t.clientX < window.innerWidth - EDGE &&
                !target.closest?.(NOT_TEXT)
                  ? { x: t.clientX, y: t.clientY, t: Date.now() }
                  : null
              return false
            },
            touchmove: (_view, e: TouchEvent) => {
              if (e.touches.length !== 1) start = null
              return false
            },
            touchend: (view: EditorView, e: TouchEvent) => {
              const s = start
              start = null
              if (!s || !editor.isEditable) return false
              const t = e.changedTouches[0]
              const dx = t.clientX - s.x
              const dy = t.clientY - s.y
              if (Date.now() - s.t > 700 || Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.5) return false
              const at = view.posAtCoords({ left: s.x, top: s.y })
              if (!at) return false
              // the line swiped over (the cursor goes there, without bringing up the keyboard)
              const $pos = view.state.doc.resolve(at.pos)
              if (!$pos.parent.isTextblock) return false
              editor.commands.setTextSelection(at.pos)
              indentAt(editor, dx > 0 ? 1 : -1, false)
              return false
            },
          },
        },
      }),
    ]
  },
})
