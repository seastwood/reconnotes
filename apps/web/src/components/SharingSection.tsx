import { useEffect, useState } from 'react'
import { Check, Copy, FileText, Folder, KeyRound } from 'lucide-react'
import { copyText, lastOpened, refreshShares, stopShare, useShares } from '../lib/shares'
import { useWorkspace } from '../lib/workspace'

/**
 * Settings › Data › Shared with others: every link that's live – each shared folder (and who it's
 * for) and each shared note – so nothing stays shared by accident. Stopping one ends it at once.
 */
export function SharingSection() {
  const shares = useShares((s) => s.shares)
  const address = useShares((s) => s.address)
  const port = useShares((s) => s.port)
  const loaded = useShares((s) => s.loaded)
  const ws = useWorkspace()
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => void refreshShares(), [])

  const what = (folderId: string | null, noteId: string) =>
    folderId ? (ws.folders.find((f) => f.id === folderId)?.name ?? 'A folder') : (ws.allNotes.find((n) => n.id === noteId)?.title || 'A note')

  return (
    <>
      <p className="hint">
        Shared folders and notes can be read by whoever has their link – nothing else on your server.
        {port ? ` Links are served on their own port (${port}), the one to open up for the people you share with.` : ''} Links start with <code>{address || '…'}</code>.
        Share a folder from its ⋯ menu.
      </p>
      {loaded && !shares.length && <p className="hint">Nothing is shared.</p>}
      <ul className="share-overview">
        {shares.map((l) => (
          <li key={l.id}>
            {l.kind === 'folder' ? <Folder size={15} /> : <FileText size={15} />}
            <div className="share-overview-text">
              <div>
                <strong>{what(l.folderId, l.noteId)}</strong>
                {l.kind === 'folder' && <> with {l.name || 'a link'}</>}
                {l.hasPasscode && (
                  <span className="share-tag" title="Asks for a passcode">
                    <KeyRound size={11} /> passcode
                  </span>
                )}
              </div>
              <div className="share-seen">{lastOpened(l.lastSeenAt)}</div>
            </div>
            <button
              className="icon"
              aria-label="Copy link"
              title="Copy link"
              onClick={() => void copyText(l.url).then(() => (setCopied(l.id), setTimeout(() => setCopied(null), 1500)))}
            >
              {copied === l.id ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button
              className="danger-text"
              onClick={() => confirm('Stop sharing? The link stops working at once.') && void stopShare(l.id).catch((e) => setError((e as Error).message))}
            >
              Stop
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error-text">{error}</p>}
    </>
  )
}
