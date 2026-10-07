import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpDown, History, Star, AudioLines, File as FileIcon, Folder, Image as ImageIcon, ListFilter, Lock, PenLine, Sparkles, X } from 'lucide-react'
import { buildTree, effectiveFolderId, folderPaths, foldersNamedIn, type FolderData, type NoteData, type TreeNode } from '@reconnotes/core'
import { localText, searchNotes, type SearchResult } from '../lib/search'
import { parseQuery, textPasses, type ParsedQuery } from '../lib/searchQuery'
import { addRecentSearch, clearRecentSearches, findSaved, removeSavedSearch, saveSearch, useRecentSearches, useSavedSearches } from '../lib/searchHistory'
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
export function SearchResults({ query, activeNoteId, onOpen }: { query: string; activeNoteId: string | null; onOpen: (noteId: string, findText?: string) => void }) {
  const ws = useWorkspace()
  const q = query.trim()
  const scope = useSearchScope()
  const access = useFolderAccess()
  // results depend on where you search, and which locked folders are open here
  const key = `${q}|${scope.join(',')}|${access.unlockedIds.join(',')}`
  // "quoted phrases", -words, #tags, folder:, before:/after:, has:
  const parsed = useMemo(() => parseQuery(q), [q])
  useSavedSearches() // re-render when saved searches change
  const saved = q ? findSaved(q, scope) : undefined
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

  const wsRef = useRef(ws)
  wsRef.current = ws
  useEffect(() => {
    setAsked(askedFor.has(q))
    if (!q) return setFound(null)
    const hit = cache.get(key)
    setFound(hit?.results ?? null)
    if (hit && Date.now() - hit.at < FRESH_MS) return
    let alive = true
    const t = setTimeout(
      () =>
        void (
          parsed.text || parsed.has.length
            ? folderAwareSearch(parsed.text, { folders: scope, unlocked: access.unlockedIds, has: parsed.has }, wsRef.current.folders, wsRef.current.notes)
            : // only filters (#tag, folder:, after:…): every note, the filters pick
              Promise.resolve(
                wsRef.current.notes
                  .filter((n) => !n.trashedAt && !n.template)
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((n): SearchResult => ({ noteId: n.id, title: n.title, snippet: n.snippet })),
              )
        ).then((r) => {
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
  const paths = useMemo(() => folderPaths(ws.folders), [ws.folders])
  const marks = useMemo(() => highlightWords(parsed.text), [parsed.text])
  /** folder: / in: in the search – the folders it names, with their subfolders */
  const syntaxFolders = useMemo(() => {
    if (!parsed.folders.length) return null
    const ids = new Set<string>()
    for (const name of parsed.folders) for (const id of foldersNamedIn(name, ws.folders).ids) ids.add(id)
    return ids
  }, [parsed.folders, ws.folders])
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
      // the search's own filters
      if (parsed.tags.length && !parsed.tags.every((t) => n.tags.includes(t))) return false
      if (parsed.after !== null && n.updatedAt < parsed.after) return false
      if (parsed.before !== null && n.updatedAt >= parsed.before) return false
      if ((parsed.phrases.length || parsed.exclude.length) && !textPasses(localText(n.id) ?? `${n.title}\n${r.snippet}\n${r.where?.line ?? ''}`, parsed)) return false
      const f = effectiveFolderId(n, liveFolders)
      if (syntaxFolders) return Boolean(f && syntaxFolders.has(f) && (!inFolder || inFolder.has(f)))
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
  }, [found, ws.notes, opts, liveFolders, inFolder, access, parsed, syntaxFolders])

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
          <button
            className={`text${saved ? ' on' : ''}`}
            onClick={() => (saved ? removeSavedSearch(saved.id) : saveSearch(q, scope))}
            title={saved ? 'Saved – tap to remove' : 'Save this search (shows under the search box on all your devices)'}
            aria-label={saved ? 'Remove saved search' : 'Save search'}
          >
            <Star size={14} fill={saved ? 'currentColor' : 'none'} />
          </button>
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
        {parsed.text.length > 2 && !asked && (
          <li
            className="note-row ask-row"
            onClick={() => {
              askedFor.add(q)
              addRecentSearch(q)
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
          <li key={r.noteId} className={`note-row${r.noteId === activeNoteId ? ' active' : ''}`} onClick={() => (addRecentSearch(q), onOpen(r.noteId, findTermFor(r, parsed)))}>
            <div className="note-title">
              {r.title || 'Untitled'}
              {r.meaning && (
                <span className="related-badge" title="Found by meaning – no exact word match">
                  related
                </span>
              )}
            </div>
            {(() => {
              const n = ws.notes.find((x) => x.id === r.noteId)
              const path = n && paths.get(effectiveFolderId(n, liveFolders) ?? '')
              return path ? (
                <div className={`note-path${r.inFolder ? ' named' : ''}`}>
                  <Folder size={11} /> {path.join(' › ')}
                </div>
              ) : null
            })()}
            {r.where && r.where.kind !== 'text' ? (
              <div className="note-snippet note-where">
                <WhereIcon kind={r.where.kind} /> <Highlighted text={r.where.line} words={marks} />
              </div>
            ) : (
              <div className="note-snippet">
                <Highlighted text={r.where?.line ?? r.snippet} words={marks} />
              </div>
            )}
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

/** The words of a search worth marking in the results. */
function highlightWords(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !/^(the|and|for|was|what|are|with|from|that|this|have|you|my|your)$/.test(w)).sort((a, b) => b.length - a.length)
}

/** Text with the search's words marked (start of word, any case: "pow" marks "Power"). */
function Highlighted({ text, words }: { text: string; words: string[] }) {
  if (!words.length || !text) return <>{text}</>
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  )
}

/**
 * Search that knows folder names: "FRC wiring" finds notes about wiring in the
 * FRC folder (and its subfolders) first; "FRC" alone, the notes in it.
 */
async function folderAwareSearch(q: string, where: Parameters<typeof searchNotes>[1], folders: FolderData[], notes: NoteData[]): Promise<SearchResult[]> {
  const named = foldersNamedIn(q, folders)
  const [main, rest] = await Promise.all([searchNotes(q, where), named.ids.size && named.rest ? searchNotes(named.rest, where) : Promise.resolve([])])
  if (!named.ids.size) return main
  const live = new Set(folders.filter((f) => !f.trashedAt).map((f) => f.id))
  const byId = new Map(notes.map((n) => [n.id, n]))
  const inNamed = (id: string) => {
    const n = byId.get(id)
    const f = n ? effectiveFolderId(n, live) : null
    return Boolean(f && named.ids.has(f))
  }
  const out: SearchResult[] = []
  const seen = new Set<string>()
  const add = (r: SearchResult) => {
    if (seen.has(r.noteId)) return
    seen.add(r.noteId)
    out.push(r)
  }
  if (named.rest) {
    // in the folder and about the rest of the search
    for (const r of rest) if (inNamed(r.noteId) && !r.meaning) add({ ...r, inFolder: true })
  } else {
    // just the folder's name: what's in it, newest first
    for (const n of notes.filter((n) => !n.trashedAt && !n.template && inNamed(n.id)).sort((a, b) => b.updatedAt - a.updatedAt))
      add({ noteId: n.id, title: n.title, snippet: n.snippet, inFolder: true })
  }
  for (const r of main) if (!r.meaning) add(r)
  for (const r of rest) if (inNamed(r.noteId)) add({ ...r, inFolder: true })
  for (const r of main) add(r)
  return out
}

const WHERE_LABEL = { handwriting: 'In handwriting', picture: 'In a picture', recording: 'In a recording', file: 'In a file', text: 'In the text' }
function WhereIcon({ kind }: { kind: NonNullable<SearchResult['where']>['kind'] }) {
  const Icon = kind === 'handwriting' ? PenLine : kind === 'picture' ? ImageIcon : kind === 'recording' ? AudioLines : FileIcon
  return (
    <span className="where-icon" title={WHERE_LABEL[kind]} aria-label={WHERE_LABEL[kind]}>
      <Icon size={12} />
    </span>
  )
}

/**
 * What the note's find bar should look for when a result is opened: a phrase
 * from the search, else the whole search if the note has it, else its
 * longest word the note has – so it lands on the match.
 */
function findTermFor(r: SearchResult, p: ParsedQuery): string | undefined {
  if (p.phrases.length) return p.phrases[0]
  const text = (localText(r.noteId) ?? `${r.title}\n${r.snippet}\n${r.where?.line ?? ''}`).toLowerCase()
  const free = p.text.trim()
  if (!free) return undefined
  if (text.includes(free.toLowerCase())) return free
  const words = (free.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)
  // whole words first, then the start of a word ("wiring" for "wir")
  return words.find((w) => text.includes(w.toLowerCase())) ?? words[0]
}

/** Under the empty search box: saved and recent searches, and what you can type. */
export function SearchSuggestions({ onPick }: { onPick: (query: string, folders?: string[]) => void }) {
  const recent = useRecentSearches()
  const savedList = useSavedSearches()
  const ws = useWorkspace()
  const name = (id: string) => (id === 'none' ? 'Not in a folder' : (ws.folders.find((f) => f.id === id)?.name ?? 'Folder'))
  // tapping shouldn't blur the search box first
  const keep = (e: React.PointerEvent) => e.preventDefault()
  return (
    <div className="search-suggestions" onPointerDown={keep}>
      {savedList.length > 0 && (
        <>
          <div className="section-label">Saved searches</div>
          {savedList.map((s) => (
            <div key={s.id} className="suggestion" onClick={() => onPick(s.query, s.folders)}>
              <Star size={14} fill="currentColor" className="suggestion-icon" />
              <span className="suggestion-text">
                {s.query}
                {s.folders.length > 0 && <span className="muted"> · in {s.folders.map(name).join(', ')}</span>}
              </span>
              <button
                className="icon"
                aria-label={`Remove saved search ${s.query}`}
                onClick={(e) => {
                  e.stopPropagation()
                  removeSavedSearch(s.id)
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </>
      )}
      {recent.length > 0 && (
        <>
          <div className="section-label">
            Recent
            <button className="text" onClick={clearRecentSearches}>
              Clear
            </button>
          </div>
          {recent.map((q) => (
            <div key={q} className="suggestion" onClick={() => onPick(q)}>
              <History size={14} className="suggestion-icon" />
              <span className="suggestion-text">{q}</span>
            </div>
          ))}
        </>
      )}
      <p className="search-tips">
        Try <code>"exact words"</code> <code>-leave out</code> <code>#tag</code> <code>folder:FRC</code> <code>after:10/1</code> <code>before:today</code>{' '}
        <code>has:handwriting</code> <code>has:picture</code> <code>has:recording</code> <code>has:checklist</code>
      </p>
    </div>
  )
}
