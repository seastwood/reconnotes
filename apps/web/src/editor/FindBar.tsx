import { useEffect, useRef, useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { ChevronDown, ChevronUp, Replace, Search, X } from 'lucide-react'
import { findKey, revealCurrentMatch } from './find'
import { useUndoManager } from './undo'

/**
 * The find bar under the note's toolbar: type to highlight every match,
 * Enter / ↓ for the next, Shift+Enter / ↑ for the previous, Esc to close.
 */
export function FindBar({ editor, initial, focus = true, onClose }: { editor: Editor; initial: string; focus?: boolean; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [replaced, setReplaced] = useState<number | null>(null)
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = e ? findKey.getState(e.state) : undefined
      return {
        query: s?.query ?? '',
        count: s?.matches.length ?? 0,
        current: s?.current ?? -1,
        blocks: s?.matches.filter((m) => m.block).length ?? 0,
        currentIsBlock: Boolean(s && s.matches[s.current]?.block),
      }
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

  // (with one match the current one doesn't change: still scroll to it – it may be out of view)
  const next = () => (editor.commands.findNext(), requestAnimationFrame(() => revealCurrentMatch(editor.view)))
  const prev = () => (editor.commands.findPrevious(), requestAnimationFrame(() => revealCurrentMatch(editor.view)))

  // each replacement is its own undo step, separate from typing before it
  const um = useUndoManager()
  const replaceOne = () => {
    um?.stopCapturing()
    if (!editor.commands.replaceMatch(replacement)) editor.commands.findNext() // a drawing/picture match: skip it
    um?.stopCapturing()
    setReplaced(null)
  }
  const replaceAll = () => {
    const n = state.count - state.blocks
    um?.stopCapturing()
    if (editor.commands.replaceAllMatches(replacement)) setReplaced(n)
    um?.stopCapturing()
  }

  return (
    <div className="find-wrap">
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
      <button
        className={`icon${replacing ? ' on' : ''}`}
        onClick={() => setReplacing(!replacing)}
        aria-label="Replace"
        title="Find and replace"
        aria-pressed={replacing}
      >
        <Replace size={17} />
      </button>
      <button className="icon" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        <X size={18} />
      </button>
    </div>
    {replacing && (
      <div className="find-bar replace-bar">
        <Replace size={16} className="find-icon" aria-hidden="true" />
        <input
          value={replacement}
          placeholder="Replace with"
          aria-label="Replace with"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.metaKey || e.ctrlKey) replaceAll()
              else replaceOne()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        {replaced !== null && <span className="find-count">Replaced {replaced}</span>}
        <button className="text" onClick={replaceOne} disabled={!state.count || state.currentIsBlock} title="Replace this match (↩)">
          Replace
        </button>
        <button className="text" onClick={replaceAll} disabled={state.count === state.blocks} title="Replace every match (⌘↩)">
          All
        </button>
      </div>
    )}
    </div>
  )
}
