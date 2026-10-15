import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import Highlight from '@tiptap/extension-highlight'
import { safeLocalGet, safeLocalSet } from '../lib/store'

/**
 * Text colours and highlighter colours. They're kept in the note as the theme's colours
 * (var(--hl-yellow) …), so each looks right in light and dark mode.
 */
export const TEXT_COLORS = [
  { key: 'red', label: 'Red' },
  { key: 'orange', label: 'Orange' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'purple', label: 'Purple' },
  { key: 'gray', label: 'Gray' },
] as const
export const HIGHLIGHTS = [
  { key: 'yellow', label: 'Yellow' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'pink', label: 'Pink' },
  { key: 'orange', label: 'Orange' },
  { key: 'purple', label: 'Purple' },
] as const

export const textColor = (key: string) => `var(--tc-${key})`
export const highlightColor = (key: string) => `var(--hl-${key})`

const LAST = 'reconnotes.highlighter'
/** the highlighter's colour: the one used last */
export const lastHighlight = () => safeLocalGet<string>(LAST, 'yellow')

/** Highlight the selection with the highlighter (or take it off, if it's already highlighted). */
export function highlight(editor: Editor, key = lastHighlight()) {
  if (key !== lastHighlight()) safeLocalSet(LAST, key)
  const color = highlightColor(key)
  if (editor.isActive('highlight', { color })) return editor.chain().focus().unsetHighlight().run()
  return editor.chain().focus().setHighlight({ color }).run()
}

export function setTextColor(editor: Editor, key: string | null) {
  if (!key) return editor.chain().focus().unsetColor().removeEmptyTextStyle().run()
  return editor.chain().focus().setColor(textColor(key)).run()
}

/** The colour marks for the editor. */
export const ColorMarks = Extension.create({
  name: 'colorMarks',
  addExtensions: () => [TextStyle, Color, Highlight.configure({ multicolor: true })],
})
