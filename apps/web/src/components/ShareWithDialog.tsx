import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, KeyRound, Link2, Loader2, Share, Users, X } from 'lucide-react'
import { addPerson, copyText, lastOpened, poolPeople, refreshShares, setPoolItem, setShareAddress, useShares, type ShareItem, type SharePerson } from '../lib/shares'

/**
 * Share a folder or a note with people: tick the pools it goes in (each person has one of their own,
 * and anyone can be in more than one), or share with someone new – who gets a link of their own,
 * for good. Read-only, always up to date. Who's in which pool: Settings › Sharing & backups.
 */
export function ShareWithDialog({ item, name, onClose }: { item: ShareItem; name: string; onClose: () => void }) {
  const pools = useShares((s) => s.pools)
  const people = useShares((s) => s.people)
  const address = useShares((s) => s.address)
  const port = useShares((s) => s.port)
  const loaded = useShares((s) => s.loaded)
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
  const copy = async (p: SharePerson) => {
    await copyText(p.url)
    setCopied(p.id)
    setTimeout(() => setCopied(null), 1500)
  }
  const isIn = (poolId: string) => pools.find((p) => p.id === poolId)?.items.some((i) => i.kind === item.kind && i.id === item.id) ?? false
  // who sees it now: everyone in a pool it's in
  const seeing = people.filter((p) => p.pools.some(isIn))
  const make = () =>
    run(async () => {
      const p = await addPerson(who.trim(), passcode || null, { item })
      setWho('')
      setPasscode('')
      await copy(p)
    })
  const what = item.kind === 'folder' ? 'Everything in this folder and its subfolders – notes, pictures, drawings, recordings and files' : 'This note, with its pictures, drawings, recordings and files'

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
          {what}, read-only and always up to date. Each person has one link for everything shared with them, and nothing else on your server can be reached
          through it{port ? ` (it’s served on its own port, ${port})` : ''}.{item.kind === 'folder' ? ' Folders with a password are left out.' : ''}
        </p>

        {!loaded && <Loader2 size={18} className="spin" />}
        {pools.length > 0 && (
          <>
            <h3>Share in…</h3>
            <ul className="share-pools-pick">
              {pools.map((p) => (
                <li key={p.id}>
                  <label>
                    <input type="checkbox" checked={isIn(p.id)} disabled={busy} onChange={(e) => void run(() => setPoolItem(p.id, item, e.target.checked))} />
                    <span>
                      <strong>{p.name}</strong>
                      <span className="share-seen">{poolPeople(p, people) ? `seen by ${poolPeople(p, people)}` : 'nobody sees it yet'}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        {seeing.length > 0 && (
          <>
            <h3>Who sees it</h3>
            <ul className="share-links">
              {seeing.map((p) => (
                <li key={p.id}>
                  <div className="share-link-head">
                    <strong>{p.name}</strong>
                    {p.hasPasscode && (
                      <span className="share-tag" title="Asks for a passcode (once on each device)">
                        <KeyRound size={12} /> passcode
                      </span>
                    )}
                    <span className="share-seen">{lastOpened(p.lastSeenAt)}</span>
                  </div>
                  <div className="row">
                    <button onClick={() => void copy(p)}>
                      {copied === p.id ? <Check size={15} /> : <Copy size={15} />} {copied === p.id ? 'Copied' : 'Copy their link'}
                    </button>
                    {'share' in navigator && (
                      <button onClick={() => void navigator.share({ url: p.url, title: `Shared with ${p.name}` }).catch(() => undefined)}>
                        <Share size={15} /> Send…
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <form
          className="share-new"
          onSubmit={(e) => {
            e.preventDefault()
            void make()
          }}
        >
          <h3>Share with someone new</h3>
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
          <p className="hint">They get a pool of their own with this in it. Add more to it any time, or add other people to it, in Settings › Sharing & backups.</p>
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
