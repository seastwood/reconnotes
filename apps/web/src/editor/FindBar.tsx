import { useEffect, useRef } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { findKey, revealCurrentMatch } from './find'

/**
 * The find bar under the note's toolbar: type to highlight every match,
 * Enter / ↓ for the next, Shift+Enter / ↑ for the previous, Esc to close.
 */
export function FindBar({ editor, initial, focus = true, onClose }: { editor: Editor; initial: string; focus?: boolean; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = e ? findKey.getState(e.state) : undefined
      return { query: s?.query ?? '', count: s?.matches.length ?? 0, current: s?.current ?? -1, blocks: s?.matches.filter((m) => m.block).length ?? 0 }
    },
  })

  // open with the given text (e.g. from the main search) and select it for typing over
  useEffect(() => {
    editor.commands.setFindQuery(initial)
    if (focus) {
      input.current?.focus()
      input.current?.select()
    }
    return () => {
      editor.commands.clearFind()
    }
  }, [editor, initial, focus])

  // jump to the current match whenever it changes
  useEffect(() => {
    if (state.current >= 0) revealCurrentMatch(editor.view)
  }, [editor, state.current, state.count, state.query])

  const next = () => editor.commands.findNext()
  const prev = () => editor.commands.findPrevious()

  return (
    <div className="find-bar" role="search">
      <Search size={16} className="find-icon" aria-hidden="true" />
      <input
        ref={input}
        defaultValue={initial}
        placeholder="Find in note"
        aria-label="Find in note"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => editor.commands.setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g')) {
            e.preventDefault()
            if (e.shiftKey) prev()
            else next()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            next()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            prev()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {state.query.trim() ? (state.count ? `${state.current + 1} of ${state.count}` : 'No matches') : ''}
      </span>
      <button className="icon" onClick={prev} disabled={!state.count} aria-label="Previous match" title="Previous (⇧↩)">
        <ChevronUp size={18} />
      </button>
      <button className="icon" onClick={next} disabled={!state.count} aria-label="Next match" title="Next (↩)">
        <ChevronDown size={18} />
      </button>
      <button className="icon" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        <X size={18} />
      </button>
    </div>
  )
}
