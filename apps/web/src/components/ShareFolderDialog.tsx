import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ExternalLink, KeyRound, Link2, Loader2, Share, Users, X } from 'lucide-react'
import { copyText, lastOpened, refreshShares, setShareAddress, shareFolder, stopShare, updateShare, useShares, type ShareLink } from '../lib/shares'

/**
 * Share a folder: a read-only link for each person ("Sydney"), to everything in the folder and its
 * subfolders – notes, pictures, drawings, recordings, files – always as it is now. Each link has its
 * own passcode (or none) and is stopped on its own. Folders with a password stay out.
 */
export function ShareFolderDialog({ folderId, name, onClose }: { folderId: string; name: string; onClose: () => void }) {
  const all = useShares((s) => s.shares)
  const address = useShares((s) => s.address)
  const port = useShares((s) => s.port)
  const loaded = useShares((s) => s.loaded)
  const links = all.filter((l) => l.folderId === folderId)
  const [who, setWho] = useState('')
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [editingAddress, setEditingAddress] = useState(false)
  const [newAddress, setNewAddress] = useState('')

  useEffect(() => void refreshShares(), [])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const copy = async (l: ShareLink) => {
    await copyText(l.url)
    setCopied(l.id)
    setTimeout(() => setCopied(null), 1500)
  }
  const make = () =>
    run(async () => {
      const l = await shareFolder(folderId, who.trim(), passcode || null)
      setWho('')
      setPasscode('')
      await copy(l)
    })
  const changePasscode = (l: ShareLink) => {
    const next = prompt(l.hasPasscode ? `A new passcode for ${l.name || 'this link'} (leave it empty for none):` : `A passcode for ${l.name || 'this link'} (at least 4 characters):`, '')
    if (next === null) return
    void run(() => updateShare(l.id, { passcode: next || null }))
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog share-folder-dialog" role="dialog" aria-label={`Share ${name}`} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Users size={18} /> Share “{name}”
          </h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <p className="hint">
          Everything in this folder and its subfolders – notes, pictures, drawings, recordings and files – read-only and always up to date. Nothing else on
          your server can be reached through the link{port ? ` (it’s served on its own port, ${port})` : ''}. Folders with a password are left out.
        </p>

        {!loaded && <Loader2 size={18} className="spin" />}
        {links.length > 0 && (
          <ul className="share-links">
            {links.map((l) => (
              <li key={l.id}>
                <div className="share-link-head">
                  <strong>{l.name || 'A link'}</strong>
                  {l.hasPasscode && (
                    <span className="share-tag" title="Asks for a passcode (once on each device)">
                      <KeyRound size={12} /> passcode
                    </span>
                  )}
                  <span className="share-seen">{lastOpened(l.lastSeenAt)}</span>
                </div>
                <input className="share-url" readOnly value={l.url} onFocus={(e) => e.target.select()} aria-label={`Link for ${l.name || 'this link'}`} />
                <div className="row">
                  <button onClick={() => void copy(l)}>
                    {copied === l.id ? <Check size={15} /> : <Copy size={15} />} {copied === l.id ? 'Copied' : 'Copy link'}
                  </button>
                  {'share' in navigator && (
                    <button onClick={() => void navigator.share({ url: l.url, title: name }).catch(() => undefined)}>
                      <Share size={15} /> Send…
                    </button>
                  )}
                  <a className="button" href={l.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} /> Open
                  </a>
                  <button onClick={() => changePasscode(l)} disabled={busy}>
                    <KeyRound size={15} /> {l.hasPasscode ? 'Passcode…' : 'Add passcode…'}
                  </button>
                  <button className="danger-text" disabled={busy} onClick={() => confirm(`Stop sharing “${name}” with ${l.name || 'this link'}? The link stops working at once.`) && void run(() => stopShare(l.id))}>
                    Stop sharing
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form
          className="share-new"
          onSubmit={(e) => {
            e.preventDefault()
            void make()
          }}
        >
          <h3>{links.length ? 'Share with someone else' : 'Share with…'}</h3>
          <label>
            Who it’s for
            <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="e.g. Sydney" autoCapitalize="words" required maxLength={80} />
          </label>
          <label>
            Passcode <span className="hint-inline">(optional – asked once on each of their devices)</span>
            <input value={passcode} onChange={(e) => setPasscode(e.target.value)} type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="None" />
          </label>
          <button type="submit" className="primary" disabled={busy || !who.trim()}>
            {busy ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} Make their link
          </button>
        </form>

        <div className="share-address">
          {editingAddress ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await setShareAddress(newAddress)
                  setEditingAddress(false)
                })
              }}
            >
              <label>
                The address links start with – your domain for sharing, or this server on your network
                <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder={`https://notes.example.com or http://192.168.1.20:${port || 8790}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
              </label>
              <div className="row">
                <button type="button" onClick={() => setEditingAddress(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={busy}>
                  Save
                </button>
              </div>
              <p className="hint">Leave it empty to use this server’s address on the share port. Links you’ve already sent keep working at whichever address reaches the share port.</p>
            </form>
          ) : (
            <p className="hint">
              Links start with <code>{address || '…'}</code>{' '}
              <button type="button" className="text" onClick={() => (setNewAddress(address), setEditingAddress(true))}>
                Change
              </button>
            </p>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>,
    document.body,
  )
}
