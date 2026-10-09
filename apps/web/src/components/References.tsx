import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Check, ChevronDown, ChevronRight, CornerLeftUp, Download, Eye, EyeOff, FileText, Folder, Loader2, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import { getNotes, listFolders, readNote } from '@reconnotes/core'
import { api } from '../lib/api'
import { useWorkspace, workspaceDoc } from '../lib/workspace'
import { isFinished, submitJob, useJobs } from '../lib/jobs'
import { useStore } from '../lib/store'
import { closeRefs, loadRefs, refsStore, saveRefs, useRefs } from '../lib/refs'

/**
 * A note's references
 * ===================
 *
 * The notes Ask reads with a note – the manual it refers to, say. They're
 * shown folded up in the chat ("References · 2"), in a window from the note's
 * ••• menu or the list, and each one opens the note. What the note refers to
 * is looked for too: notes to add, linked documents to import (the import
 * becomes a reference when it's done) and rules none of your notes has.
 */

export interface References {
  suggestions: { noteId: string; title: string; reasons: string[]; find?: string }[]
  missing: { name: string; url?: string }[]
  missingRules: string[]
  /** what you said the note doesn't need – kept here to bring back */
  ignored: { key: string; kind: 'note' | 'document' | 'rule'; name: string; detail?: string; find?: string }[]
  /** for each note it refers to: where this note points to it (text to find) */
  mentions: Record<string, string>
}

/** Set aside something found (or bring it back); answers with what's found now. */
const ignore = (noteId: string, key: string, on: boolean) => api<References>('PUT', '/api/ask/references/ignore', { noteId, key, ignore: on })
/** A document's key, as the server makes it: its address without "www.", query or trailing slash. */
const docKey = (d: { name: string; url?: string }) => {
  if (!d.url) return `doc:${d.name.toLowerCase()}`
  try {
    const u = new URL(d.url)
    return `doc:${(u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).toLowerCase()}`
  } catch {
    return `doc:${d.url.toLowerCase()}`
  }
}

const titleOf = (id: string) => {
  const m = getNotes(workspaceDoc).get(id)
  if (!m) return null
  const n = readNote(m)
  return n.trashedAt ? null : n.title || 'Untitled'
}

/** What the note refers to – looked again when its references change or an import for it finishes. */
function useFound(noteId: string, refs: string[]) {
  const [found, setFound] = useState<References | null>(null)
  const doneImports = useJobs((s) => s.jobs.filter((j) => j.kind === 'web-import' && j.input.askRefFor === noteId && isFinished(j)).length)
  const key = refs.join(',')
  useEffect(() => {
    let alive = true
    api<References>('GET', `/api/ask/references?noteId=${noteId}`)
      .then((r) => alive && setFound(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [noteId, key])
  // an import added a reference (on the server): fetch them again
  useEffect(() => {
    if (doneImports) void loadRefs(true)
  }, [doneImports])
  return [found, setFound] as const
}

/** the notes whose References are open in the chat (this visit) */
const barsOpen = new Set<string>()

/** In the chat: "References · 2", opened to show them. */
export function ReferencesBar({ noteId, onOpen }: { noteId: string; onOpen: (id: string, find?: string) => void }) {
  useWorkspace()
  const refs = useRefs(noteId).filter((id) => titleOf(id) !== null)
  const [found, setFound] = useFound(noteId, refs)
  // stays open when you come back from viewing something
  const [open, setOpenState] = useState(() => barsOpen.has(noteId))
  const setOpen = (on: boolean) => {
    if (on) barsOpen.add(noteId)
    else barsOpen.delete(noteId)
    setOpenState(on)
  }
  const todo = (found?.suggestions.length ?? 0) + (found?.missing.length ?? 0)
  return (
    <div className="ask-refs">
      <button className="ask-refs-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <BookOpen size={14} /> References
        <span className="ask-refs-count">{refs.length || 'none'}</span>
        {todo > 0 && !open && (
          <span className="ask-refs-todo">
            <Sparkles size={12} /> {todo} found
          </span>
        )}
      </button>
      {open && <ReferencesPanel noteId={noteId} found={found} setFound={setFound} onOpen={onOpen} />}
    </div>
  )
}

/** The References window (from the ••• menu or the list). */
export function ReferencesHost({ onOpen }: { onOpen: (id: string, find?: string) => void }) {
  const noteId = useStore(refsStore, (s) => s.open)
  if (!noteId) return null
  return <ReferencesDialog noteId={noteId} onOpen={onOpen} />
}

function ReferencesDialog({ noteId, onOpen }: { noteId: string; onOpen: (id: string, find?: string) => void }) {
  useWorkspace()
  const refs = useRefs(noteId)
  const [found, setFound] = useFound(noteId, refs)
  return createPortal(
    <div className="dialog-backdrop" onClick={closeRefs}>
      <div className="dialog refs-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <BookOpen size={18} /> References
            <span className="refs-dialog-note">{titleOf(noteId) ?? ''}</span>
          </h2>
          <button className="icon" onClick={closeRefs} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <p className="refs-dialog-hint">Ask about this note also reads these – the documents it refers to. Tap one to open it.</p>
        <ReferencesPanel
          noteId={noteId}
          found={found}
          setFound={setFound}
          onOpen={(id, find) => {
            closeRefs()
            onOpen(id, find)
          }}
        />
      </div>
    </div>,
    document.body,
  )
}

export function ReferencesPanel({
  noteId,
  found,
  setFound,
  onOpen,
}: {
  noteId: string
  found: References | null
  setFound: (r: References) => void
  onOpen: (id: string, find?: string) => void
}) {
  useWorkspace()
  const refs = useRefs(noteId)
  const [picking, setPicking] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const setIgnored = (key: string, on: boolean) =>
    void ignore(noteId, key, on)
      .then(setFound)
      .catch(() => {})
  // this note, at the spot that points to it
  const viewBtn = (find: string | undefined, what: string) =>
    find ? (
      <button className="text ask-refs-view" title={`Where this note mentions ${what}`} onClick={() => onOpen(noteId, find)}>
        <Eye size={13} /> View
      </button>
    ) : null
  const ignoreBtn = (key: string, what: string) => (
    <button className="icon ask-refs-ignore" aria-label={`Ignore ${what}`} title="Ignore – not needed (kept under Ignored)" onClick={() => setIgnored(key, true)}>
      <EyeOff size={15} />
    </button>
  )
  const [importing, setImporting] = useState<string[]>([])
  const shown = refs.filter((id) => titleOf(id) !== null)
  const save = (next: string[]) => void saveRefs(noteId, next)
  const importDoc = async (url: string) => {
    setImporting((x) => [...x, url])
    const own = getNotes(workspaceDoc).get(noteId)
    try {
      await submitJob({ kind: 'web-import', title: url.replace(/^https?:\/\//, '').slice(0, 120), input: { url, follow: false, maxPages: 1, folderId: own ? readNote(own).folderId : null, askRefFor: noteId } })
    } catch {
      setImporting((x) => x.filter((u) => u !== url))
    }
  }
  return (
    <div className="ask-refs-panel">
      <div className="ask-refs-list chosen-list">
        {shown.map((id) => (
          <div key={id} className="ask-refs-ref">
            <button className="ask-refs-ref-open" onClick={() => onOpen(id)} title={`Open ${titleOf(id)}`}>
              <FileText size={15} />
              <span className="ask-refs-option-text">{titleOf(id)}</span>
            </button>
            {viewBtn(found?.mentions?.[id], titleOf(id)!)}
            <button className="icon" aria-label={`Remove ${titleOf(id)}`} title="Remove this reference" onClick={() => save(refs.filter((x) => x !== id))}>
              <X size={15} />
            </button>
          </div>
        ))}
        {!shown.length && <div className="ask-refs-none">No references – Ask reads only this note.</div>}
      </div>
      <button className="text ask-refs-add" onClick={() => setPicking(!picking)}>
        {picking ? <Check size={13} /> : <Plus size={13} />} {picking ? 'Done' : 'Add a note'}
      </button>
      {picking && <RefPicker noteId={noteId} chosen={refs} onToggle={(id) => save(refs.includes(id) ? refs.filter((x) => x !== id) : [...refs, id])} />}
      {found && (found.suggestions.length > 0 || found.missing.length > 0 || found.missingRules.length > 0) && (
        <div className="ask-refs-found">
          {found.suggestions.length > 0 && (
            <div className="ask-refs-group">
              <span className="ask-refs-label">
                <Sparkles size={13} /> It refers to:
              </span>
              {found.suggestions.map((sg) => (
                <div key={sg.noteId} className="ask-refs-suggest">
                  <span className="ask-refs-option-text">
                    {sg.title}
                    <span className="ask-refs-where">{sg.reasons.join(' · ')}</span>
                  </span>
                  {viewBtn(sg.find, sg.title)}
                  <button className="text" onClick={() => save([...refs, sg.noteId])}>
                    <Plus size={13} /> Add
                  </button>
                  {ignoreBtn(`note:${sg.noteId}`, sg.title)}
                </div>
              ))}
              {found.suggestions.length > 1 && (
                <button className="text ask-refs-all" onClick={() => save([...refs, ...found.suggestions.map((x) => x.noteId)])}>
                  Add all
                </button>
              )}
            </div>
          )}
          {found.missing.map((d) => (
            <div key={d.url} className="ask-refs-suggest missing">
              <span className="ask-refs-option-text">
                {d.name}
                <span className="ask-refs-where">Linked, but not in your notes · {d.url!.replace(/^https?:\/\//, '')}</span>
              </span>
              {viewBtn(d.name, d.name)}
              {importing.includes(d.url!) ? (
                <span className="ask-refs-where">
                  <Loader2 size={13} className="spin" /> Importing…
                </span>
              ) : (
                <button className="text" onClick={() => void importDoc(d.url!)}>
                  <Download size={13} /> Import
                </button>
              )}
              {ignoreBtn(docKey(d), d.name)}
            </div>
          ))}
          {found.missingRules.length > 0 && (
            <div className="ask-refs-where ask-refs-rules">
              Rules it uses that none of your notes has:
              {found.missingRules.slice(0, 12).map((id) => (
                <span key={id} className="ask-refs-rule">
                  <button title={`Where this note uses ${id}`} onClick={() => onOpen(noteId, id)}>
                    {id}
                  </button>
                  <button aria-label={`Ignore ${id}`} title={`Ignore ${id} – not needed`} onClick={() => setIgnored(`rule:${id}`, true)}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              {found.missingRules.length > 12 ? ` and ${found.missingRules.length - 12} more` : ''}
            </div>
          )}
        </div>
      )}
      {found && found.ignored.length > 0 && (
        <div className="ask-refs-ignored">
          <button className="text ask-refs-ignored-toggle" aria-expanded={showIgnored} onClick={() => setShowIgnored(!showIgnored)}>
            {showIgnored ? <ChevronDown size={13} /> : <ChevronRight size={13} />} <EyeOff size={13} /> Ignored · {found.ignored.length}
          </button>
          {showIgnored &&
            found.ignored.map((i) => (
              <div key={i.key} className="ask-refs-suggest ignored">
                <span className="ask-refs-option-text">
                  {i.name}
                  <span className="ask-refs-where">
                    {i.kind === 'note' ? 'A note' : i.kind === 'document' ? 'A linked document' : 'A rule'}
                    {i.detail ? ` · ${i.detail.replace(/^https?:\/\//, '')}` : ''}
                  </span>
                </span>
                {viewBtn(i.find, i.name)}
                <button className="text" onClick={() => setIgnored(i.key, false)}>
                  <RotateCcw size={13} /> Restore
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

/**
 * Picking the notes Ask also reads: the folders, starting in the one the note
 * is in (a manual is usually next to it) – into a folder, up, or anywhere by
 * the path – and a search of every note.
 */
function RefPicker({ noteId, chosen, onToggle }: { noteId: string; chosen: string[]; onToggle: (id: string) => void }) {
  useWorkspace()
  const notes = [...getNotes(workspaceDoc).entries()].map(([id, m]) => ({ id, n: readNote(m) })).filter(({ id, n }) => id !== noteId && !n.trashedAt && !n.template)
  const folders = listFolders(workspaceDoc).filter((f) => !f.trashedAt)
  const live = new Map(folders.map((f) => [f.id, f]))
  const folderOf = (folderId: string | null) => (folderId && live.has(folderId) ? folderId : null)
  const own = getNotes(workspaceDoc).get(noteId)
  const [at, setAt] = useState<string | null>(() => folderOf(own ? readNote(own).folderId : null))
  const [q, setQ] = useState('')
  const path = (id: string | null) => {
    const out: { id: string; name: string }[] = []
    for (let f = id ? live.get(id) : undefined; f; f = f.parentId ? live.get(f.parentId) : undefined) out.unshift({ id: f.id, name: f.name })
    return out
  }
  const byTitle = (a: { n: { title: string } }, b: { n: { title: string } }) => (a.n.title || 'Untitled').localeCompare(b.n.title || 'Untitled', undefined, { numeric: true })
  const row = ({ id, n }: { id: string; n: { title: string; folderId: string | null } }, where?: string) => (
    <button key={id} className={`ask-refs-option${chosen.includes(id) ? ' chosen' : ''}`} onClick={() => onToggle(id)}>
      <FileText size={15} />
      <span className="ask-refs-option-text">
        {n.title || 'Untitled'}
        {where !== undefined && <span className="ask-refs-where">{where || 'Not in a folder'}</span>}
      </span>
      {chosen.includes(id) && <Check size={16} className="ask-refs-check" />}
    </button>
  )
  const search = q.trim().toLowerCase()
  const crumbs = path(at)
  return (
    <div className="ask-refs-pick">
      <input value={q} placeholder="Search every note…" onChange={(e) => setQ(e.target.value)} />
      {search ? (
        <div className="ask-refs-list">
          {notes
            .filter(({ n }) => (n.title || 'Untitled').toLowerCase().includes(search))
            .sort(byTitle)
            .slice(0, 30)
            .map((x) => row(x, path(folderOf(x.n.folderId)).map((f) => f.name).join(' › ')))}
        </div>
      ) : (
        <>
          <div className="ask-refs-crumbs">
            {at !== null && (
              <button className="icon" aria-label="Up a folder" onClick={() => setAt(crumbs.length > 1 ? crumbs[crumbs.length - 2].id : null)}>
                <CornerLeftUp size={15} />
              </button>
            )}
            <button className="text" onClick={() => setAt(null)}>
              All folders
            </button>
            {crumbs.map((c) => (
              <span key={c.id} className="ask-refs-crumb">
                <ChevronRight size={12} />
                <button className="text" onClick={() => setAt(c.id)}>
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          <div className="ask-refs-list">
            {folders
              .filter((f) => (f.parentId && live.has(f.parentId) ? f.parentId : null) === at)
              .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.name.localeCompare(b.name)))
              .map((f) => (
                <button key={f.id} className="ask-refs-option folder" onClick={() => setAt(f.id)}>
                  <Folder size={15} />
                  <span className="ask-refs-option-text">{f.name}</span>
                  <ChevronRight size={15} className="ask-refs-check" />
                </button>
              ))}
            {notes
              .filter(({ n }) => folderOf(n.folderId) === at)
              .sort(byTitle)
              .map((x) => row(x))}
          </div>
        </>
      )}
    </div>
  )
}
