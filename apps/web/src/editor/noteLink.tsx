import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Plus } from 'lucide-react'
import * as Y from 'yjs'
import { createNote, getContent, noteDocName, type NoteData } from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { sync } from '../lib/sync'

/**
 * Links between notes
 * ===================
 *
 * A link is an inline chip holding the target note's id; it always shows the
 * note's current title. Typing "[[" opens a picker to choose (or create) the
 * note. The note list remembers who links to whom, for "Linked from".
 */

export interface NoteLinkOptions {
  onOpen: (noteId: string) => void
  /** "[[" was typed: the range covers both brackets */
  onTrigger: (range: { from: number; to: number }) => void
}

function NoteLinkView({ node, extension }: ReactNodeViewProps) {
  const ws = useWorkspace()
  const id = node.attrs.noteId as string
  const note = ws.notes.find((n) => n.id === id)
  const gone = !note || note.trashedAt
  const title = note?.title || (node.attrs.title as string) || 'Untitled'
  return (
    <NodeViewWrapper as="span" className={`note-link${gone ? ' gone' : ''}`} contentEditable={false}>
      <button
        type="button"
        onClick={() => !gone && (extension.options as NoteLinkOptions).onOpen(id)}
        title={gone ? 'This note was deleted' : `Open “${title}”`}
      >
        <FileText size={13} />
        {title}
      </button>
    </NodeViewWrapper>
  )
}

export const NoteLink = Node.create<NoteLinkOptions>({
  name: 'noteLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onOpen: () => undefined, onTrigger: () => undefined }
  },

  addAttributes() {
    return { noteId: { default: null }, title: { default: '' } }
  },

  parseHTML() {
    return [{ tag: 'span[data-note-link]', getAttrs: (el) => ({ noteId: (el as HTMLElement).dataset.noteLink, title: (el as HTMLElement).textContent }) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-note-link': node.attrs.noteId }), node.attrs.title || 'note']
  },

  renderText({ node }) {
    return `[[${node.attrs.title || 'note'}]]`
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteLinkView, { as: 'span', stopEvent: () => true })
  },

  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin({
        props: {
          handleTextInput: (view, from, _to, text) => {
            if (text !== '[') return false
            const before = view.state.doc.textBetween(Math.max(0, from - 1), from, '', '')
            if (before === '[') setTimeout(() => opts.onTrigger({ from: from - 1, to: from + 1 }))
            return false
          },
        },
      }),
    ]
  },
})

/** Make a new note whose first line is `title` (for links to notes that don't exist yet). */
async function createTitledNote(title: string): Promise<string> {
  const id = createNote(workspaceDoc, { title })
  const { handle, close } = sync.open(noteDocName(id))
  try {
    await handle.loaded
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(title)])
    getContent(handle.doc).insert(0, [p])
  } finally {
    close()
  }
  return id
}

/** The note picker shown for "[[" (or ⋯ › Link to note…). */
export function LinkPicker({
  currentNoteId,
  at,
  onPick,
  onClose,
}: {
  currentNoteId: string
  /** the cursor: left edge, bottom and top (viewport coordinates) */
  at: { x: number; y: number; top: number }
  onPick: (note: { id: string; title: string }) => void
  onClose: () => void
}) {
  const ws = useWorkspace()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const matches: NoteData[] = useMemo(() => {
    const query = q.trim().toLocaleLowerCase()
    return ws.notes
      .filter((n) => !n.trashedAt && !n.template && n.id !== currentNoteId && (!query || (n.title || 'untitled').toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
  }, [ws.notes, q, currentNoteId])
  const canCreate = q.trim() && !matches.some((n) => n.title.toLocaleLowerCase() === q.trim().toLocaleLowerCase())
  const total = matches.length + (canCreate ? 1 : 0)
  const choose = async (i: number) => {
    if (i < matches.length) onPick({ id: matches[i].id, title: matches[i].title })
    else if (canCreate) onPick({ id: await createTitledNote(q.trim()), title: q.trim() })
  }
  // Below the cursor if it fits in what's visible above the on-screen
  // keyboard, otherwise above the cursor.
  const [viewport, setViewport] = useState(() => visibleArea())
  useEffect(() => {
    const vv = window.visualViewport
    const update = () => setViewport(visibleArea())
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
    }
  }, [])
  const height = Math.min(330, viewport.bottom - viewport.top - 16)
  const below = at.y + 8 + height <= viewport.bottom - 8
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 320))
  // above: pin its bottom edge just over the cursor line, whatever its height
  const style = below
    ? { left, top: at.y + 8, maxHeight: height }
    : { left, bottom: window.innerHeight - (at.top - 8), maxHeight: Math.min(height, at.top - 8 - (viewport.top + 8)) }
  return (
    <>
      <div className="picker-backdrop" onPointerDown={onClose} />
      <div className="link-picker" style={style} role="dialog" aria-label="Link to a note">
        <input
          ref={input}
          value={q}
          placeholder="Link to note…"
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(total - 1, s + 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)))
            else if (e.key === 'Enter') (e.preventDefault(), void choose(sel))
            else if (e.key === 'Escape') (e.preventDefault(), onClose())
          }}
        />
        <ul>
          {matches.map((n, i) => (
            <li key={n.id}>
              <button className={i === sel ? 'on' : ''} onPointerEnter={() => setSel(i)} onClick={() => void choose(i)}>
                <FileText size={15} /> {n.title || 'Untitled'}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button className={sel === matches.length ? 'on' : ''} onPointerEnter={() => setSel(matches.length)} onClick={() => void choose(matches.length)}>
                <Plus size={15} /> Create note “{q.trim()}”
              </button>
            </li>
          )}
          {!total && <li className="hint">No other notes yet – type a name to create one.</li>}
        </ul>
      </div>
    </>
  )
}

/** The part of the window not covered by the on-screen keyboard. */
function visibleArea() {
  const vv = window.visualViewport
  return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: window.innerHeight }
}

/** "Linked from": notes that link to this one. */
export function LinkedFrom({ noteId, onOpen }: { noteId: string; onOpen: (id: string) => void }) {
  const ws = useWorkspace()
  const from = ws.notes.filter((n) => !n.trashedAt && n.id !== noteId && n.links.includes(noteId))
  if (!from.length) return null
  return (
    <aside className="linked-from">
      <h4>Linked from</h4>
      {from.map((n) => (
        <button key={n.id} onClick={() => onOpen(n.id)}>
          <FileText size={14} /> <span>{(n.title || 'Untitled').replace(/\s+/g, ' ')}</span>
        </button>
      ))}
    </aside>
  )
}

