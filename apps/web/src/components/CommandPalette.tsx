import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder, Hash, Search, Zap } from 'lucide-react'
import { matchScore, useCommands } from '../lib/commands'
import { useWorkspace } from '../lib/workspace'
import { useRecentNotes } from '../lib/recentNotes'

interface Item {
  key: string
  label: string
  detail?: string
  shortcut?: string
  kind: 'command' | 'note' | 'folder' | 'tag'
  score: number
  run: () => void
}

interface Props {
  onClose: () => void
  onOpenNote: (id: string) => void
  onOpenFolder: (id: string) => void
  onOpenTag: (tag: string) => void
  /** search note contents for the typed text */
  onSearch: (query: string) => void
}

const ICON = { command: Zap, note: FileText, folder: Folder, tag: Hash, search: Search }

/** ⌘K: type a few letters to run any command or jump to any note, folder or tag. */
export function CommandPalette({ onClose, onOpenNote, onOpenFolder, onOpenTag, onSearch }: Props) {
  const commands = useCommands()
  const ws = useWorkspace()
  const recentIds = useRecentNotes()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const items = useMemo(() => {
    const out: Item[] = []
    for (const c of commands) {
      const score = Math.max(matchScore(c.label, q), c.keywords ? matchScore(c.keywords, q) * 0.8 : 0)
      if (score) out.push({ key: `c:${c.id}`, label: c.label, detail: c.section, shortcut: c.shortcut, kind: 'command', score: score + 5, run: c.run })
    }
    if (q.trim()) {
      for (const n of ws.notes) {
        if (n.trashedAt) continue
        const score = matchScore(n.title || 'Untitled', q)
        if (score) out.push({ key: `n:${n.id}`, label: n.title || 'Untitled', detail: n.template ? 'Template' : 'Note', kind: 'note', score, run: () => onOpenNote(n.id) })
      }
      for (const f of ws.folders) {
        if (f.trashedAt) continue
        const score = matchScore(f.name, q)
        if (score) out.push({ key: `f:${f.id}`, label: f.name, detail: 'Folder', kind: 'folder', score, run: () => onOpenFolder(f.id) })
      }
      const tags = new Set(ws.notes.filter((n) => !n.trashedAt).flatMap((n) => n.tags))
      for (const t of tags) {
        const score = matchScore(`#${t}`, q.startsWith('#') ? q : `#${q}`)
        if (score) out.push({ key: `t:${t}`, label: `#${t}`, detail: 'Tag', kind: 'tag', score, run: () => onOpenTag(t) })
      }
    } else {
      // nothing typed: the notes opened last (then the ones edited last), then the commands
      const live = new Map(ws.notes.filter((n) => !n.trashedAt && !n.template).map((n) => [n.id, n]))
      const ids = [...recentIds.filter((id) => live.has(id)), ...[...live.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((n) => n.id)]
      const recent: Item[] = []
      for (const id of [...new Set(ids)].slice(0, 6)) {
        const n = live.get(id)!
        recent.push({ key: `n:${n.id}`, label: n.title || 'Untitled', detail: recentIds.includes(id) ? 'Opened recently' : 'Edited recently', kind: 'note', score: 1000, run: () => onOpenNote(n.id) })
      }
      // (first: going back to a note is what ⌘K is used for most)
      out.unshift(...recent)
    }
    const sorted = out.sort((a, b) => b.score - a.score).slice(0, 60)
    // always offer to search inside notes, too
    if (q.trim()) sorted.push({ key: 'search', label: `Search everything for “${q.trim()}”`, detail: 'Search', kind: 'command', score: 0, run: () => onSearch(q.trim()) })
    return sorted
  }, [commands, ws, q, onOpenNote, onOpenFolder, onOpenTag, onSearch, recentIds])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (item: Item | undefined) => {
    if (!item) return
    onClose()
    // after the window closes, so focus can go where the command wants it
    setTimeout(item.run, 0)
  }

  return (
    <div className="dialog-backdrop palette-backdrop-k" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Commands">
        <div className="cp-input">
          <Search size={18} />
          <input
            autoFocus
            value={q}
            placeholder="Type a command, note, folder or #tag…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(items.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(items[sel])
              } else if (e.key === 'Escape') onClose()
            }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        <ul ref={list} className="cp-list">
          {items.map((it, i) => {
            const Icon = ICON[it.kind]
            return (
              <li key={it.key}>
                <button className={i === sel ? 'on' : ''} onPointerEnter={() => setSel(i)} onClick={() => run(it)}>
                  <Icon size={16} className="cp-icon" />
                  <span className="cp-label">{it.label}</span>
                  {it.detail && <span className="cp-detail">{it.detail}</span>}
                  {it.shortcut && <kbd>{it.shortcut}</kbd>}
                </button>
              </li>
            )
          })}
          {!items.length && <li className="cp-empty">Nothing matches “{q}”.</li>}
        </ul>
      </div>
    </div>
  )
}
