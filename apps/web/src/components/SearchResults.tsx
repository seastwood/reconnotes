import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpDown, Folder, ListFilter, Lock, Sparkles, X } from 'lucide-react'
import { buildTree, effectiveFolderId, type TreeNode } from '@reconnotes/core'
import { searchNotes, type SearchResult } from '../lib/search'
import { setSearchFolders, toggleSearchFolder, useSearchScope } from '../lib/searchScope'
import { useFolderAccess } from '../lib/folderLock'
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
  edited: Edited
  tag: string
  /** also show notes found by meaning (related) */
  related: boolean
}
const DEFAULTS: Options = { sort: 'best', edited: 'any', tag: '', related: true }
const KEY = 'reconnotes.searchOptions'

/** Notes matching the search text (and "Ask your notes" for it), updated as you type. */
export function SearchResults({ query, activeNoteId, onOpen }: { query: string; activeNoteId: string | null; onOpen: (noteId: string) => void }) {
  const ws = useWorkspace()
  const q = query.trim()
  const scope = useSearchScope()
  const access = useFolderAccess()
  // results depend on where you search, and which locked folders are open here
  const key = `${q}|${scope.join(',')}|${access.unlockedIds.join(',')}`
  const [found, setFound] = useState<SearchResult[] | null>(() => cache.get(key)?.results ?? null)
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
    const hit = cache.get(key)
    setFound(hit?.results ?? null)
    if (hit && Date.now() - hit.at < FRESH_MS) return
    let alive = true
    const t = setTimeout(
      () =>
        void searchNotes(q, { folders: scope, unlocked: access.unlockedIds }).then((r) => {
          cache.delete(key) // most recent last, for trimming
          cache.set(key, { results: r, at: Date.now() })
          while (cache.size > 30) cache.delete(cache.keys().next().value!)
          if (alive) setFound(r)
        }),
      hit ? 0 : 150,
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const liveFolders = useMemo(() => new Set(ws.folders.filter((f) => !f.trashedAt).map((f) => f.id)), [ws.folders])
  const tree = useMemo(() => buildTree(ws.folders, ws.rootSort), [ws.folders, ws.rootSort])
  /** the chosen folders and everything inside them ('none': notes in no folder) */
  const inFolder = useMemo(() => {
    if (!scope.length) return null
    const ids = new Set<string>(scope)
    const walk = (nodes: TreeNode[], inside: boolean) => {
      for (const n of nodes) {
        const here = inside || scope.includes(n.folder.id)
        if (here) ids.add(n.folder.id)
        walk(n.children, here)
      }
    }
    walk(tree, false)
    return ids
  }, [scope, tree])
  const tags = useMemo(() => [...new Set(ws.notes.filter((n) => !n.trashedAt).flatMap((n) => n.tags))].sort(), [ws.notes])
  const folderName = (id: string) => (id === 'none' ? 'Not in a folder' : (ws.folders.find((f) => f.id === id)?.name ?? 'Folder'))

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
      // searching chosen folders: only those; otherwise not the folders left out of search
      if (inFolder) return inFolder.has(f ?? 'none')
      return !(f && access.rules.get(f)?.noSearch)
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
  }, [found, ws.notes, opts, liveFolders, inFolder, access])

  const filtered = Boolean(scope.length || opts.edited !== 'any' || opts.tag || !opts.related)
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
          <div className="menu-label">Search in (pick one or more)</div>
          <button className={!scope.length ? 'checked' : ''} onClick={() => (setSearchFolders([]), setMenu(null))}>
            Everywhere
          </button>
          <FolderChoices nodes={tree} depth={0} chosen={scope} locked={access.lockedFolder} onPick={toggleSearchFolder} />
          <button className={scope.includes('none') ? 'checked' : ''} onClick={() => toggleSearchFolder('none')}>
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
          {scope.map((id) => (
            <Chip
              key={id}
              label={
                <>
                  <Folder size={12} /> {folderName(id)}
                </>
              }
              onClear={() => toggleSearchFolder(id)}
            />
          ))}
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
        {asked && <AskPanel question={q} where={{ folders: scope, unlocked: access.unlockedIds }} onOpen={onOpen} />}
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
                <button className="text" onClick={() => (setSearchFolders([]), setOpts({ edited: 'any', tag: '', related: true }))}>
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

function FolderChoices({ nodes, depth, chosen, locked, onPick }: { nodes: TreeNode[]; depth: number; chosen: string[]; locked: (id: string) => boolean; onPick: (id: string) => void }) {
  return (
    <>
      {nodes.map((n) => (
        <Fragment key={n.folder.id}>
          <button
            className={chosen.includes(n.folder.id) ? 'checked' : ''}
            style={{ paddingLeft: 10 + depth * 14 }}
            disabled={locked(n.folder.id)}
            title={locked(n.folder.id) ? 'Locked – unlock it to search it' : undefined}
            onClick={() => onPick(n.folder.id)}
          >
            {locked(n.folder.id) ? <Lock size={14} /> : <Folder size={14} />} {n.folder.name}
          </button>
          {n.children.length > 0 && <FolderChoices nodes={n.children} depth={depth + 1} chosen={chosen} locked={locked} onPick={onPick} />}
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
