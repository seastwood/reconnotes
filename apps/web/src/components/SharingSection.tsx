import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, FileText, Folder, KeyRound, Loader2, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react'
import {
  addPerson,
  addPool,
  copyText,
  deletePool,
  lastOpened,
  poolPeople,
  refreshShares,
  renamePool,
  setPoolItem,
  stopPerson,
  stopShare,
  updatePerson,
  useShares,
  type SharePerson,
} from '../lib/shares'
import { useWorkspace } from '../lib/workspace'

/**
 * Settings › Sharing & backups: the people things are shared with (one link each, for good)
 * and the pools – sets of folders and notes – they see. Add more to someone's pool, put other people
 * in it, or put one person in several pools; stop a link or a pool at any time. Also single notes'
 * own links, so nothing stays shared by accident.
 */
export function SharingSection() {
  const shares = useShares((s) => s.shares)
  const people = useShares((s) => s.people)
  const pools = useShares((s) => s.pools)
  const address = useShares((s) => s.address)
  const port = useShares((s) => s.port)
  const loaded = useShares((s) => s.loaded)
  const ws = useWorkspace()
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPass, setNewPass] = useState('')
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
  const copy = (id: string, url: string) => void copyText(url).then(() => (setCopied(id), setTimeout(() => setCopied(null), 1500)))
  const folderName = (id: string) => ws.folders.find((f) => f.id === id)?.name || 'A folder (deleted)'
  const noteName = (id: string) => ws.allNotes.find((n) => n.id === id)?.title || 'A note'
  const togglePool = (p: SharePerson, pool: string, on: boolean) => run(() => updatePerson(p.id, { pools: on ? [...p.pools, pool] : p.pools.filter((x) => x !== pool) }))
  const changePasscode = (p: SharePerson) => {
    const next = prompt(p.hasPasscode ? `A new passcode for ${p.name} (leave it empty for none):` : `A passcode for ${p.name} (at least 4 characters):`, '')
    if (next !== null) void run(() => updatePerson(p.id, { passcode: next || null }))
  }

  return (
    <>
      <p className="hint">
        Each person has one link for everything shared with them: whatever is in the pools they’re in. Share a folder from its ⋯ menu, or a note from its ⋯
        menu, into anyone’s pool. {port ? `Links are served on their own port (${port}), the one to open up for the people you share with. ` : ''}Links start
        with <code>{address || '…'}</code>.
      </p>
      {!loaded && <Loader2 size={18} className="spin" />}

      <h3>People</h3>
      {loaded && !people.length && <p className="hint">Nobody yet.</p>}
      <ul className="share-people">
        {people.map((p) => (
          <li key={p.id}>
            <div className="share-link-head">
              <strong>{p.name}</strong>
              {p.hasPasscode && (
                <span className="share-tag" title="Asks for a passcode (once on each device)">
                  <KeyRound size={11} /> passcode
                </span>
              )}
              <span className="share-seen">{lastOpened(p.lastSeenAt)}</span>
            </div>
            <div className="share-chips" aria-label={`Pools ${p.name} sees`}>
              <span className="share-chips-label">Sees:</span>
              {pools.map((pool) => (
                <label key={pool.id} className={`share-chip${p.pools.includes(pool.id) ? ' on' : ''}`}>
                  <input type="checkbox" checked={p.pools.includes(pool.id)} disabled={busy} onChange={(e) => void togglePool(p, pool.id, e.target.checked)} />
                  {pool.name}
                </label>
              ))}
            </div>
            <div className="row">
              <button onClick={() => copy(p.id, p.url)}>
                {copied === p.id ? <Check size={15} /> : <Copy size={15} />} {copied === p.id ? 'Copied' : 'Copy link'}
              </button>
              <a className="button" href={p.url} target="_blank" rel="noreferrer">
                <ExternalLink size={15} /> Open
              </a>
              <button onClick={() => changePasscode(p)} disabled={busy}>
                <KeyRound size={15} /> {p.hasPasscode ? 'Passcode…' : 'Add passcode…'}
              </button>
              <button
                onClick={() => {
                  const n = prompt('Their name:', p.name)
                  if (n?.trim()) void run(() => updatePerson(p.id, { name: n.trim() }))
                }}
              >
                <Pencil size={15} /> Rename
              </button>
              <button className="danger-text" disabled={busy} onClick={() => confirm(`Stop ${p.name}’s link? It stops working at once. Their pools stay, with anyone else in them.`) && void run(() => stopPerson(p.id))}>
                Stop link
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="share-new inline"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            const p = await addPerson(newName.trim(), newPass || null)
            setNewName('')
            setNewPass('')
            copy(p.id, p.url)
          })
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Someone new, e.g. Mom" autoCapitalize="words" maxLength={80} aria-label="Name" />
        <input value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="Passcode (optional)" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label="Passcode" />
        <button type="submit" disabled={busy || !newName.trim()}>
          <UserPlus size={15} /> Add
        </button>
      </form>

      <h3>Pools</h3>
      {loaded && !pools.length && <p className="hint">No pools yet: sharing a folder with someone makes them one.</p>}
      <ul className="share-pools">
        {pools.map((pool) => (
          <li key={pool.id}>
            <div className="share-link-head">
              <strong>{pool.name}</strong>
              <span className="share-seen">{poolPeople(pool, people) ? `seen by ${poolPeople(pool, people)}` : 'nobody sees it'}</span>
              <span className="spacer" />
              <button
                className="icon"
                title="Rename"
                aria-label={`Rename ${pool.name}`}
                onClick={() => {
                  const n = prompt('Name of the pool:', pool.name)
                  if (n?.trim()) void run(() => renamePool(pool.id, n.trim()))
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon"
                title="Delete the pool"
                aria-label={`Delete ${pool.name}`}
                onClick={() => confirm(`Delete “${pool.name}”? What’s in it is no longer shared through it. The people and their links stay.`) && void run(() => deletePool(pool.id))}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {pool.items.length ? (
              <ul className="share-items">
                {pool.items.map((i) => (
                  <li key={`${i.kind}:${i.id}`}>
                    {i.kind === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
                    <span>{i.kind === 'folder' ? folderName(i.id) : noteName(i.id)}</span>
                    <button className="icon" aria-label="Take it out of the pool" title="Take it out of the pool" disabled={busy} onClick={() => void run(() => setPoolItem(pool.id, i, false))}>
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Empty – share a folder or note into it from its ⋯ menu.</p>
            )}
          </li>
        ))}
      </ul>
      <button
        onClick={() => {
          const n = prompt('Name of the new pool (e.g. Family recipes):', '')
          if (n?.trim()) void run(() => addPool(n.trim()))
        }}
      >
        <Plus size={15} /> New pool
      </button>

      {shares.length > 0 && (
        <>
          <h3>Single notes’ own links</h3>
          <p className="hint">Anyone with one of these can read that note.</p>
          <ul className="share-overview">
            {shares.map((l) => (
              <li key={l.id}>
                <FileText size={15} />
                <div className="share-overview-text">
                  <div>
                    <strong>{noteName(l.noteId)}</strong>
                  </div>
                  <div className="share-seen">{lastOpened(l.lastSeenAt)}</div>
                </div>
                <button className="icon" aria-label="Copy link" title="Copy link" onClick={() => copy(l.id, l.url)}>
                  {copied === l.id ? <Check size={16} /> : <Copy size={16} />}
                </button>
                <button className="danger-text" onClick={() => confirm('Stop sharing? The link stops working at once.') && void run(() => stopShare(l.id))}>
                  Stop
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </>
  )
}
