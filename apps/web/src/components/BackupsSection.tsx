import { useEffect, useState } from 'react'
import { ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import { api } from '../lib/api'

interface Backup {
  name: string
  createdAt: string
  notes: number
}
interface BackupNote {
  id: string
  title: string
  folder: string
  status: 'same' | 'changed' | 'deleted' | 'trashed'
}

const STATUS: Record<BackupNote['status'], string> = {
  same: 'unchanged',
  changed: 'changed since',
  deleted: 'deleted since',
  trashed: 'in Recently Deleted',
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * Settings › Backups: the server's backups, and restoring notes from them —
 * a few notes, or the whole library as it was then.
 */
export function BackupsSection() {
  const [backups, setBackups] = useState<Backup[] | null>(null)
  const [interval, setInterval] = useState(24)
  const [open, setOpen] = useState<string | null>(null)
  const [notes, setNotes] = useState<BackupNote[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = () =>
    api<{ details: Backup[]; intervalHours: number }>('GET', '/api/backups')
      .then((r) => {
        setBackups(r.details)
        setInterval(r.intervalHours)
      })
      .catch((e) => setMessage(`❌ ${(e as Error).message}`))
  useEffect(() => void load(), [])

  const openBackup = async (name: string) => {
    if (open === name) return setOpen(null)
    setOpen(name)
    setShowAll(false)
    await loadNotes(name)
  }
  const loadNotes = async (name: string) => {
    setNotes(null)
    setPicked(new Set())
    try {
      setNotes((await api<{ notes: BackupNote[] }>('GET', `/api/backups/${name}/notes`)).notes)
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`)
    }
  }

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label)
    setMessage(null)
    try {
      setMessage(`✅ ${await fn()}`)
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const backUpNow = () =>
    run('backup', async () => {
      await api('POST', '/api/backups')
      await load()
      return 'Backup made.'
    })

  const restore = (name: string, all: boolean) => {
    const what = all ? 'every note' : `${picked.size} note${picked.size === 1 ? '' : 's'}`
    const warn = all ? '\n\nNotes made since then go to Recently Deleted.' : ''
    if (!confirm(`Restore ${what} to how ${all ? 'they were' : picked.size === 1 ? 'it was' : 'they were'} on ${when(backups!.find((b) => b.name === name)!.createdAt)}?\n\nEach note's current state is kept in its version history, so you can undo this.${warn}`)) return
    void run('restore', async () => {
      const r = await api<{ restored: number; trashed: number }>('POST', `/api/backups/${name}/restore`, all ? { all: true } : { noteIds: [...picked] })
      await loadNotes(name)
      if (!r.restored && !r.trashed) return 'Nothing to restore – those notes are already the same.'
      return `Restored ${r.restored} note${r.restored === 1 ? '' : 's'}.${r.trashed ? ` ${r.trashed} newer note${r.trashed === 1 ? ' is' : 's are'} in Recently Deleted.` : ''}`
    })
  }

  const visible = notes?.filter((n) => showAll || n.status !== 'same') ?? []
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="backups">
      <p className="hint">
        Your server backs up every note {interval > 0 ? `every ${interval === 24 ? 'day' : `${interval} hours`}` : 'when you ask'} (also as
        plain Markdown files in its backups folder). Restoring keeps each note’s current state in its version history.
      </p>
      <div className="row">
        <button onClick={backUpNow} disabled={busy !== null}>
          {busy === 'backup' ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      {message && <p className="status">{message}</p>}
      {backups === null ? (
        <p className="hint">
          <Loader2 size={14} className="spin" /> Loading backups…
        </p>
      ) : !backups.length ? (
        <p className="hint">No backups yet.</p>
      ) : (
        <ul className="backup-list">
          {backups.map((b) => (
            <li key={b.name} className={open === b.name ? 'open' : ''}>
              <button className="backup-row" onClick={() => void openBackup(b.name)} aria-expanded={open === b.name}>
                <ChevronRight size={16} className="chev" />
                <span>{when(b.createdAt)}</span>
                <span className="muted">{b.notes} note{b.notes === 1 ? '' : 's'}</span>
              </button>
              {open === b.name && (
                <div className="backup-detail">
                  {notes === null ? (
                    <p className="hint">
                      <Loader2 size={14} className="spin" /> Comparing with your notes…
                    </p>
                  ) : (
                    <>
                      {!visible.length && <p className="hint">Every note is the same as in this backup.</p>}
                      <ul className="backup-notes">
                        {visible.map((n) => (
                          <li key={n.id}>
                            <label className="check">
                              <input type="checkbox" checked={picked.has(n.id)} onChange={() => toggle(n.id)} />
                              <span>
                                {n.title}
                                {n.folder && <span className="muted"> · {n.folder}</span>}
                              </span>
                              <span className={`backup-status ${n.status}`}>{STATUS[n.status]}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      {notes.some((n) => n.status === 'same') && (
                        <button className="text" onClick={() => setShowAll(!showAll)}>
                          {showAll ? 'Only show notes that changed' : `Show all ${notes.length} note${notes.length === 1 ? '' : 's'}`}
                        </button>
                      )}
                      <div className="row">
                        <button className="primary" disabled={!picked.size || busy !== null} onClick={() => restore(b.name, false)}>
                          <RotateCcw size={15} /> Restore {picked.size ? `${picked.size} selected` : 'selected'}
                        </button>
                        <button disabled={busy !== null} onClick={() => restore(b.name, true)}>
                          Restore everything as it was then
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
