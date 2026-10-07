import { useState } from 'react'
import { Lock } from 'lucide-react'
import { getFolders, readFolder } from '@reconnotes/core'
import { workspaceDoc } from '../lib/workspace'
import { PasswordDialog } from './PasswordDialog'
import { hasBiometricPassword } from '../lib/biometric'

/** Shown instead of a locked folder's notes, or a note in it. */
export function LockedScreen({ folderId, what }: { folderId: string; what: 'folder' | 'note' }) {
  // with Face ID set up for it, ask straight away
  const [asking, setAsking] = useState(() => hasBiometricPassword(folderId))
  const m = getFolders(workspaceDoc).get(folderId)
  const name = m ? readFolder(m).name : 'Folder'
  return (
    <div className="locked-screen">
      <Lock size={34} />
      <p>{what === 'note' ? `This note is in “${name}”, which is locked.` : `“${name}” is locked.`}</p>
      <button className="primary" onClick={() => setAsking(true)}>
        Unlock
      </button>
      {asking && <PasswordDialog folderId={folderId} folderName={name} mode="unlock" onClose={() => setAsking(false)} />}
    </div>
  )
}
