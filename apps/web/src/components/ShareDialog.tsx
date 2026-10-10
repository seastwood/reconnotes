import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Globe, Loader2, Share, X } from 'lucide-react'
import { api } from '../lib/api'
import { settings } from '../lib/settings'
import { refreshShares } from '../lib/shares'

interface ShareState {
  shared: boolean
  path: string | null
  /** the link, at the share address (the share port, or the address set for sharing) */
  url?: string | null
}

/** Share a read-only link to this note (no account needed to view it). */
export function ShareDialog({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const [state, setState] = useState<ShareState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api<ShareState>('GET', `/api/notes/${noteId}/share`)
      .then(setState)
      .catch((e) => setError((e as Error).message))
  }, [noteId])

  const act = async (method: 'POST' | 'DELETE') => {
    setBusy(true)
    setError(null)
    try {
      setState(await api<ShareState>(method, `/api/notes/${noteId}/share`))
      void refreshShares()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const url = state?.url ?? (state?.path ? settings.get().serverUrl.replace(/\/$/, '') + state.path : '')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      prompt('Copy the link:', url)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog share-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share link">
        <header>
          <h2>Share a link</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <section>
          {!state && !error && <Loader2 size={18} className="spin" />}
          {state && !state.shared && (
            <>
              <p className="hint">
                Anyone with the link can read this note – no account needed. They see it as it is now, including later changes, but can’t
                edit it. Only this note is shared, with its pictures, drawings and files.
              </p>
              <button className="primary" onClick={() => void act('POST')} disabled={busy}>
                <Globe size={16} /> {busy ? 'Making a link…' : 'Make a read-only link'}
              </button>
            </>
          )}
          {state?.shared && (
            <>
              <p className="hint">Anyone with this link can read the note. Stop sharing at any time – the link then stops working.</p>
              <input className="share-url" readOnly value={url} onFocus={(e) => e.target.select()} />
              <div className="row">
                <button className="primary" onClick={() => void copy()}>
                  <Copy size={15} /> {copied ? 'Copied' : 'Copy link'}
                </button>
                {'share' in navigator && (
                  <button onClick={() => void navigator.share({ url }).catch(() => undefined)}>
                    <Share size={15} /> Share…
                  </button>
                )}
                <a className="button" href={url} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} /> Open
                </a>
              </div>
              <button className="danger-text" onClick={() => void act('DELETE')} disabled={busy}>
                Stop sharing
              </button>
            </>
          )}
          {error && <p className="status">❌ {error}</p>}
        </section>
      </div>
    </div>
  )
}
