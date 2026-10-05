import { useEffect, useMemo, useState } from 'react'
import { Copy, History, Loader2, RotateCcw, X } from 'lucide-react'
import { marked } from 'marked'
import { apiUrl, authHeaders, isSyncConfigured, settings } from '../lib/settings'

interface Version {
  id: number
  createdAt: number
  title: string
  chars: number
  label: string
}

async function call<T>(method: string, path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { method, headers: authHeaders() })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Server error ${res.status}`)
  return json as T
}

const dayLabel = (ts: number) => {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/**
 * Earlier versions of a note, kept by the server: pick one to preview it,
 * copy text out of it, or restore it (the current state is kept as a
 * version first, so a restore can itself be undone).
 */
export function VersionHistory({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isSyncConfigured()) return setError('Version history is kept on your ReconNotes server – connect one in Settings.')
    call<{ versions: Version[] }>('GET', `/api/notes/${noteId}/versions`)
      .then((r) => {
        setVersions(r.versions)
        if (r.versions.length) setSelected(r.versions[0].id)
      })
      .catch((e) => setError((e as Error).message))
  }, [noteId])

  useEffect(() => {
    if (selected === null) return
    setPreview(null)
    call<{ markdown: string }>('GET', `/api/notes/${noteId}/versions/${selected}`)
      .then((r) => setPreview(r.markdown))
      .catch((e) => setError((e as Error).message))
  }, [noteId, selected])

  const html = useMemo(() => {
    if (preview === null) return ''
    const token = encodeURIComponent(settings.get().token)
    // our own notes, but never let stored text act as HTML
    const md = preview.replace(/</g, '&lt;').replace(/\(\/api\/attachments\/([a-z0-9]+)\)/g, (_m, id) => `(${apiUrl(`/api/attachments/${id}`)}?token=${token})`)
    return marked.parse(md, { async: false }) as string
  }, [preview])

  const groups = useMemo(() => {
    const out: { day: string; items: Version[] }[] = []
    for (const v of versions ?? []) {
      const day = dayLabel(v.createdAt)
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] })
      out[out.length - 1].items.push(v)
    }
    return out
  }, [versions])

  const restore = async () => {
    if (selected === null) return
    setBusy(true)
    try {
      await call('POST', `/api/notes/${noteId}/versions/${selected}/restore`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog versions-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Version history">
        <header>
          <h2>
            <History size={18} /> Version history
          </h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        {error && <p className="status error-text">{error}</p>}
        {versions && !versions.length && <p className="hint">No earlier versions yet. The server keeps one about every 10 minutes while you edit.</p>}
        {!versions && !error && <Loader2 className="spin" size={20} />}
        {versions && versions.length > 0 && (
          <div className="versions-body">
            <ol className="versions-list">
              {groups.map((g) => (
                <li key={g.day}>
                  <div className="menu-label">{g.day}</div>
                  {g.items.map((v) => (
                    <button key={v.id} className={v.id === selected ? 'on' : ''} onClick={() => setSelected(v.id)}>
                      <span>{new Date(v.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                      <span className="hint">{v.label || `${v.chars.toLocaleString()} characters`}</span>
                    </button>
                  ))}
                </li>
              ))}
            </ol>
            <div className="versions-preview">
              {preview === null ? <Loader2 className="spin" size={20} /> : <div className="note-content" dangerouslySetInnerHTML={{ __html: html }} />}
              <div className="row">
                <button className="primary" onClick={() => void restore()} disabled={busy || preview === null}>
                  {busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} Restore this version
                </button>
                <button onClick={() => preview && void navigator.clipboard?.writeText(preview)} disabled={preview === null}>
                  <Copy size={14} /> Copy text
                </button>
              </div>
              <p className="hint">Restoring keeps the note as it is now as a version too, so you can switch back.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
