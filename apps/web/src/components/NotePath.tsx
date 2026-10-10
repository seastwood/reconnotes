import { ChevronDown, ChevronRight, ChevronUp, FileText, Folder, FolderMinus, Inbox } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { useWorkspace } from '../lib/workspace'
import type { View } from './Sidebar'

const OPEN = 'reconnotes.notePathOpen'

/**
 * Where a note is, as breadcrumbs – All Notes › Work › Meetings › this note – in a bar under the
 * note's buttons: a note opened from search, Ask or a link otherwise doesn't say. Tapping a crumb
 * shows that folder (or all notes), with this note in its list. The bar folds away to a small tab
 * (remembered for every note); open, it slides away while you scroll down the note and comes
 * back when you scroll up, or reach the top.
 */
export function NotePath({ noteId, folderId, onShow }: { noteId: string; folderId: string | null; onShow: (view: View) => void }) {
  const ws = useWorkspace()
  const path = useMemo(() => {
    const byId = new Map(ws.folders.filter((f) => !f.trashedAt).map((f) => [f.id, f]))
    const out: { id: string; name: string }[] = []
    const seen = new Set<string>()
    for (let f = folderId ? byId.get(folderId) : undefined; f && !seen.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
      seen.add(f.id)
      out.unshift({ id: f.id, name: f.name || 'Untitled folder' })
    }
    return out
  }, [ws.folders, folderId])
  const title = ws.allNotes.find((n) => n.id === noteId)?.title.trim() || 'Untitled'
  const [open, setOpenState] = useState(() => safeLocalGet<boolean>(OPEN, true))
  const setOpen = (v: boolean) => {
    setOpenState(v)
    safeLocalSet(OPEN, v)
  }
  // scrolled down the note: out of the way
  const [away, setAway] = useState(false)
  const bar = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const scroller = bar.current?.closest('.editor')?.querySelector<HTMLElement>(':scope > .editor-scroll')
    if (!scroller) return
    let last = scroller.scrollTop
    // how far it has gone the same way: a small jiggle doesn't flip it
    let run = 0
    const onScroll = () => {
      const now = scroller.scrollTop
      const d = now - last
      last = now
      if (now < 24) return setAway(false)
      run = Math.sign(d) === Math.sign(run) ? run + d : d
      if (run > 40) setAway(true)
      else if (run < -40) setAway(false)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [open, noteId])
  // the crumbs scroll sideways when they don't fit: scrolled to the end – this note – to start
  const crumbs = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = crumbs.current
    if (!el) return
    const toEnd = () => (el.scrollLeft = el.scrollWidth)
    toEnd()
    // (and again once laid out, or the screen turns)
    const watch = new ResizeObserver(toEnd)
    watch.observe(el)
    return () => watch.disconnect()
  }, [open, noteId, folderId, title, path])
  const sep = <ChevronRight size={12} className="note-path-sep" aria-hidden />
  if (!open)
    return (
      <div className="note-path-hang">
        <button
          className="note-path-tab"
          title="Show where this note is"
          aria-label="Show where this note is"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <Folder size={15} aria-hidden />
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
    )
  return (
    // over the top of the note (which leaves room for it), so sliding away moves nothing under your finger
    <div className="note-path-hang">
      <nav ref={bar} className={`note-path${away ? ' away' : ''}`} aria-label="Where this note is" aria-hidden={away || undefined} inert={away || undefined}>
        <div className="note-path-crumbs" ref={crumbs}>
          <button title="Show all notes" onClick={() => onShow({ kind: 'all' })}>
            <Inbox size={13} aria-hidden /> All Notes
          </button>
          {sep}
          {path.length ? (
            path.map((f) => (
              <span key={f.id} className="note-path-part">
                <button title={`Show the folder “${f.name}”`} onClick={() => onShow({ kind: 'folder', folderId: f.id })}>
                  <Folder size={13} aria-hidden />{' '}
                  <span className="note-path-name" title={f.name}>
                    {f.name}
                  </span>
                </button>
                {sep}
              </span>
            ))
          ) : (
            <span className="note-path-part">
              <button title="Show the notes in no folder" onClick={() => onShow({ kind: 'unfiled' })}>
                <FolderMinus size={13} aria-hidden /> Not in a folder
              </button>
              {sep}
            </span>
          )}
          <span className="note-path-here" aria-current="page">
            <FileText size={13} aria-hidden /> <span className="note-path-name">{title}</span>
          </span>
        </div>
        <button className="note-path-fold" title="Hide the path" aria-label="Hide the path" aria-expanded onClick={() => setOpen(false)}>
          <ChevronUp size={14} aria-hidden />
        </button>
      </nav>
    </div>
  )
}
