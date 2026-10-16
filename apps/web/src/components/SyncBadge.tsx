import { useEffect, useRef, useState } from 'react'
import { Cloud, CloudOff, HardDrive, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { useStore } from '../lib/store'
import { sync, syncStatus } from '../lib/sync'
import { Popover } from './Popover'

const LABELS = {
  local: 'On this device only',
  connecting: 'Connecting…',
  online: 'Synced',
  offline: 'Offline – changes saved on this device',
  unauthorized: 'Server rejected the access token',
}

/** "just now", "5 minutes ago", "3 days ago" */
function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/** a day without reaching the server, with changes waiting: worth saying so plainly */
const LONG = 24 * 3600_000

/**
 * Sync, at a glance: the icon says connected, syncing, offline or on this device only; a number on
 * it counts the notes changed here (the note list counts as one) that the server doesn't have yet. Tap it for the details – when
 * it last synced, what's waiting – and to try again now.
 */
export function SyncBadge() {
  const s = useStore(syncStatus, (x) => x)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  // (the "… ago" stays current while it's open)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [open])
  const busy = s.state === 'online' && (s.pending > 0 || s.backgroundSyncing)
  const Icon = s.state === 'online' ? (busy ? RefreshCw : Cloud) : s.state === 'offline' ? CloudOff : s.state === 'local' ? HardDrive : s.state === 'unauthorized' ? ShieldAlert : Loader2
  const waiting = s.state === 'local' ? 0 : s.unsynced
  const stale = waiting > 0 && s.state !== 'online' && (!s.lastSyncedAt || Date.now() - s.lastSyncedAt > LONG)
  const label =
    s.state === 'online' && s.pending
      ? `Syncing ${s.pending} note${s.pending > 1 ? 's' : ''}…`
      : waiting && s.state !== 'online'
        ? `${LABELS[s.state]} · ${waiting} change${waiting === 1 ? '' : 's'} not on the server yet`
        : LABELS[s.state]
  return (
    <>
      <button ref={btn} className={`sync-badge sync-${s.state}${stale ? ' stale' : ''}`} title={label} aria-label={label} onClick={() => setOpen(!open)}>
        <Icon size={16} className={s.state === 'connecting' || busy ? 'spin' : ''} />
        {waiting > 0 && s.state !== 'online' && <span className="sync-count">{waiting > 99 ? '99+' : waiting}</span>}
      </button>
      {open && (
        <Popover anchorRef={btn} onClose={() => setOpen(false)}>
          <div className="sync-panel">
            <div className="sync-panel-state">
              <Icon size={16} /> {s.state === 'online' && !busy ? 'Synced with your server' : LABELS[s.state]}
            </div>
            {s.state !== 'local' && (
              <>
                <p>
                  {waiting > 0
                    ? `${waiting === 1 ? 'A note changed' : `${waiting} notes changed`} on this device ${waiting === 1 ? 'isn’t' : 'aren’t'} on your server yet – ${s.state === 'online' ? 'sending now' : 'sent as soon as it’s reachable'}.`
                    : 'Everything changed here is on your server.'}
                </p>
                <p className="hint">{s.lastSyncedAt ? `Last fully in sync ${ago(s.lastSyncedAt)}.` : 'Not fully in sync yet.'}</p>
                {stale && <p className="sync-warn">It’s been a while since this device reached your server. Your changes are safe here – check the connection (VPN, Wi-Fi) so they get backed up.</p>}
                {s.state === 'unauthorized' && <p className="sync-warn">The server didn’t accept this device’s key – connect it again in Settings › Sync & devices.</p>}
              </>
            )}
            {s.state === 'local' && <p className="hint">Connect a ReconNotes server in Settings to sync between devices and back up your notes.</p>}
            {s.state !== 'local' && (
              <button className="text" onClick={() => (sync.reconnect(), setOpen(false))}>
                <RefreshCw size={14} /> Sync now
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
