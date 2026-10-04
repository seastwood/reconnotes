import { Cloud, CloudOff, HardDrive, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { useStore } from '../lib/store'
import { sync, syncStatus } from '../lib/sync'

const LABELS = {
  local: 'On this device only',
  connecting: 'Connecting…',
  online: 'Synced',
  offline: 'Offline – changes saved on this device',
  unauthorized: 'Server rejected the access token',
}

export function SyncBadge() {
  const s = useStore(syncStatus, (x) => x)
  const Icon =
    s.state === 'online' ? (s.pending || s.backgroundSyncing ? RefreshCw : Cloud) : s.state === 'offline' ? CloudOff : s.state === 'local' ? HardDrive : s.state === 'unauthorized' ? ShieldAlert : Loader2
  const label = s.state === 'online' && s.pending ? `Syncing ${s.pending} note${s.pending > 1 ? 's' : ''}…` : LABELS[s.state]
  return (
    <button className={`sync-badge sync-${s.state}`} title={label} aria-label={label} onClick={() => sync.reconnect()}>
      <Icon size={16} className={s.state === 'connecting' || (s.state === 'online' && (s.pending || s.backgroundSyncing)) ? 'spin' : ''} />
    </button>
  )
}
