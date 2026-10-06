import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpDown, Folder, ListFilter, Sparkles, X } from 'lucide-react'
import { buildTree, effectiveFolderId, type TreeNode } from '@reconnotes/core'
import { searchNotes, type SearchResult } from '../lib/search'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { useWorkspace } from '../lib/workspace'
import { AskPanel } from './AskPanel'
import { Popover } from './Popover'

/**
 * Results are kept for each search text, so opening a result and coming back
 * shows them at once instead of searching again. They're refreshed quietly
 * (still showing the old ones) once they're a few minutes old.
 */
const cache = new Map<string, { results: SearchResult[]; at: number }>()
const FRESH_MS = 3 * 60_000
/** which searches had "Ask your notes" open (its answer is kept by AskPanel) */
const askedFor = new Set<string>()

type SortBy = 'best' | 'edited' | 'oldest' | 'created' | 'title'
const SORTS: Record<SortBy, string> = {
  best: 'Best match',
  edited: 'Last edited',
  oldest: 'Least recently edited',
  created: 'Newest first',
  title: 'Title (A–Z)',
}
type Edited = 'any' | 'day' | 'week' | 'month' | 'year'
const EDITED: Record<Edited, string> = { any: 'Any time', day: 'Today', week: 'Past week', month: 'Past month', year: 'Past year' }
const EDITED_MS: Record<Edited, number> = { any: 0, day: 0, week: 7 * 864e5, month: 31 * 864e5, year: 366 * 864e5 }

interface Options {
  sort: SortBy
  /** a folder and its subfolders; '' = everywhere, 'none' = notes in no folder */
  folder: string
  edited: Edited
  tag: string
  /** also show notes found by meaning (related) */
  related: boolean
}
const DEFAULTS: Options = { sort: 'best', folder: '', edited: 'any', tag: '', related: true }
const KEY = 'reconnotes.searchOptions'

/** Notes matching the search text (and "Ask your notes" for it), updated as you type. */
export function SearchResults({ query, activeNoteId, onOpen }: { query: string; activeNoteId: string | null; onOpen: (noteId: string) => void }) {
  const ws = useWorkspace()
  const q = query.trim()
  const [found, setFound] = useState<SearchResult[] | null>(() => cache.get(q)?.results ?? null)
  const [asked, setAsked] = useState(() => askedFor.has(q))
  const [opts, setOptsState] = useState<Options>(() => ({ ...DEFAULTS, ...safeLocalGet<Partial<Options>>(KEY, {}) }))
  const setOpts = (patch: Partial<Options>) => {
    const next = { ...opts, ...patch }
    setOptsState(next)
    safeLocalSet(KEY, next)
  }
  const [menu, setMenu] = useState<'sort' | 'filter' | null>(null)
  const sortBtn = useRef<HTMLButtonElement>(null)
  const filterBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setAsked(askedFor.has(q))
    if (!q) return setFound(null)
    const hit = cache.get(q)
    setFound(hit?.results ?? null)
    if (hit && Date.now() - hit.at < FRESH_MS) return
    let alive = true
    const t = setTimeout(
      () =>
        void searchNotes(q).then((r) => {
          cache.delete(q) // most recent last, for trimming
          cache.set(q, { results: r, at: Date.now() })
          while (cache.size > 30) cache.delete(cache.keys().next().value!)
          if (alive) setFound(r)
        }),
      hit ? 0 : 150,
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])

  const liveFolders = useMemo(() => new Set(ws.folders.filter((f) => !f.trashedAt).map((f) => f.id)), [ws.folders])
  const tree = useMemo(() => buildTree(ws.folders, ws.rootSort), [ws.folders, ws.rootSort])
  /** the chosen folder and everything inside it */
  const inFolder = useMemo(() => {
    if (!opts.folder || opts.folder === 'none') return null
    const ids = new Set<string>([opts.folder])
    const walk = (nodes: TreeNode[], inside: boolean) => {
      for (const n of nodes) {
        const here = inside || n.folder.id === opts.folder
        if (here) ids.add(n.folder.id)
        walk(n.children, here)
      }
    }
    walk(tree, false)
    return ids
  }, [opts.folder, tree])
  const tags = useMemo(() => [...new Set(ws.notes.filter((n) => !n.trashedAt).flatMap((n) => n.tags))].sort(), [ws.notes])
  const folderName = opts.folder === 'none' ? 'No folder' : ws.folders.find((f) => f.id === opts.folder)?.name

  const results = useMemo(() => {
    if (!found) return null
    const notes = new Map(ws.notes.map((n) => [n.id, n]))
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    const since = opts.edited === 'any' ? 0 : opts.edited === 'day' ? startOfDay : Date.now() - EDITED_MS[opts.edited]
    const list = found.filter((r) => {
      const n = notes.get(r.noteId)
      if (!n || n.template || n.trashedAt) return false
      if (!opts.related && r.meaning) return false
      if (since && n.updatedAt < since) return false
      if (opts.tag && !n.tags.includes(opts.tag)) return false
      const f = effectiveFolderId(n, liveFolders)
      if (opts.folder === 'none' ? f !== null : inFolder && !(f && inFolder.has(f))) return false
      return true
    })
    const by = (f: (n: NonNullable<ReturnType<typeof notes.get>>) => number | string, desc: boolean) =>
      list.sort((a, b) => {
        const x = f(notes.get(a.noteId)!)
        const y = f(notes.get(b.noteId)!)
        const c = typeof x === 'string' ? x.localeCompare(y as string, undefined, { sensitivity: 'base', numeric: true }) : x - (y as number)
        return desc ? -c : c
      })
    if (opts.sort === 'edited') by((n) => n.updatedAt, true)
    else if (opts.sort === 'oldest') by((n) => n.updatedAt, false)
    else if (opts.sort === 'created') by((n) => n.createdAt, true)
    else if (opts.sort === 'title') by((n) => n.title || 'Untitled', false)
    return list
  }, [found, ws.notes, opts, liveFolders, inFolder])

  const filtered = Boolean(opts.folder || opts.edited !== 'any' || opts.tag || !opts.related)
  const pick = (patch: Partial<Options>) => {
    setOpts(patch)
    setMenu(null)
  }

  return (
    <>
      {q && (
        <div className="search-tools">
          <span className="search-count">{results ? `${results.length} ${results.length === 1 ? 'note' : 'notes'}` : 'Searching…'}</span>
          <button ref={sortBtn} className={`text${opts.sort !== 'best' ? ' on' : ''}`} onClick={() => setMenu(menu === 'sort' ? null : 'sort')}>
            <ArrowUpDown size={14} /> {SORTS[opts.sort]}
          </button>
          <button ref={filterBtn} className={`text${filtered ? ' on' : ''}`} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}>
            <ListFilter size={14} /> Filter
          </button>
        </div>
      )}
      {menu === 'sort' && (
        <Popover anchorRef={sortBtn} onClose={() => setMenu(null)}>
          <div className="menu-label">Sort results by</div>
          {(Object.keys(SORTS) as SortBy[]).map((s) => (
            <button key={s} className={opts.sort === s ? 'checked' : ''} onClick={() => pick({ sort: s })}>
              {SORTS[s]}
            </button>
          ))}
        </Popover>
      )}
      {menu === 'filter' && (
        <Popover anchorRef={filterBtn} align="right" onClose={() => setMenu(null)}>
          <div className="menu-label">Edited</div>
          {(Object.keys(EDITED) as Edited[]).map((e) => (
            <button key={e} className={opts.edited === e ? 'checked' : ''} onClick={() => pick({ edited: e })}>
              {EDITED[e]}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="menu-label">In folder</div>
          <button className={!opts.folder ? 'checked' : ''} onClick={() => pick({ folder: '' })}>
            Everywhere
          </button>
          <FolderChoices nodes={tree} depth={0} chosen={opts.folder} onPick={(id) => pick({ folder: id })} />
          <button className={opts.folder === 'none' ? 'checked' : ''} onClick={() => pick({ folder: 'none' })}>
            Not in a folder
          </button>
          {tags.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Tag</div>
              <button className={!opts.tag ? 'checked' : ''} onClick={() => pick({ tag: '' })}>
                Any tag
              </button>
              {tags.map((t) => (
                <button key={t} className={opts.tag === t ? 'checked' : ''} onClick={() => pick({ tag: t })}>
                  #{t}
                </button>
              ))}
            </>
          )}
          <div className="menu-sep" />
          <button className={opts.related ? 'checked' : ''} onClick={() => pick({ related: !opts.related })}>
            Include related notes (found by meaning)
          </button>
        </Popover>
      )}
      {filtered && q && (
        <div className="search-chips">
          {opts.edited !== 'any' && <Chip label={`Edited: ${EDITED[opts.edited].toLowerCase()}`} onClear={() => setOpts({ edited: 'any' })} />}
          {opts.folder && (
            <Chip
              label={
                <>
                  <Folder size={12} /> {folderName ?? 'Folder'}
                </>
              }
              onClear={() => setOpts({ folder: '' })}
            />
          )}
          {opts.tag && <Chip label={`#${opts.tag}`} onClear={() => setOpts({ tag: '' })} />}
          {!opts.related && <Chip label="Exact matches only" onClear={() => setOpts({ related: true })} />}
        </div>
      )}
      <ul className="notes search-results">
        {q.length > 2 && !asked && (
          <li
            className="note-row ask-row"
            onClick={() => {
              askedFor.add(q)
              setAsked(true)
            }}
          >
            <div className="note-title">
              <Sparkles size={15} /> Ask your notes
            </div>
            <div className="note-snippet">“{q}” – an answer from your notes, with sources</div>
          </li>
        )}
        {asked && <AskPanel question={q} onOpen={onOpen} />}
        {results?.map((r) => (
          <li key={r.noteId} className={`note-row${r.noteId === activeNoteId ? ' active' : ''}`} onClick={() => onOpen(r.noteId)}>
            <div className="note-title">
              {r.title || 'Untitled'}
              {r.meaning && (
                <span className="related-badge" title="Found by meaning – no exact word match">
                  related
                </span>
              )}
            </div>
            <div className="note-snippet">{r.snippet}</div>
          </li>
        ))}
        {results && !results.length && (
          <li className="empty-hint">
            {found?.length ? (
              <>
                No matches with these filters.{' '}
                <button className="text" onClick={() => setOpts({ folder: '', edited: 'any', tag: '', related: true })}>
                  Clear filters
                </button>
              </>
            ) : (
              'No matches'
            )}
          </li>
        )}
      </ul>
    </>
  )
}

function FolderChoices({ nodes, depth, chosen, onPick }: { nodes: TreeNode[]; depth: number; chosen: string; onPick: (id: string) => void }) {
  return (
    <>
      {nodes.map((n) => (
        <Fragment key={n.folder.id}>
          <button className={chosen === n.folder.id ? 'checked' : ''} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onPick(n.folder.id)}>
            <Folder size={14} /> {n.folder.name}
          </button>
          {n.children.length > 0 && <FolderChoices nodes={n.children} depth={depth + 1} chosen={chosen} onPick={onPick} />}
        </Fragment>
      ))}
    </>
  )
}

function Chip({ label, onClear }: { label: ReactNode; onClear: () => void }) {
  return (
    <span className="search-chip">
      {label}
      <button aria-label="Remove this filter" onClick={onClear}>
        <X size={12} />
      </button>
    </span>
  )
}
