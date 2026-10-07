import { useEffect, useRef, useState } from 'react'
import { Loader2, Lock, ScanFace } from 'lucide-react'
import { removeFolderPassword, setFolderPassword, unlockFolder } from '../lib/folderLock'
import { biometricName, forgetBiometricPassword, hasBiometricPassword, readBiometricPassword, saveBiometricPassword } from '../lib/biometric'

export type PasswordMode = 'set' | 'unlock' | 'change' | 'remove'

/**
 * Asks for a folder's password: to set one, open the folder, change it, or
 * take it off. `onDone` runs when it worked (e.g. to show the folder).
 */
export function PasswordDialog({ folderId, folderName, mode, onClose, onDone }: { folderId: string; folderName: string; mode: PasswordMode; onClose: () => void; onDone?: () => void }) {
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const needsCurrent = mode !== 'set'
  // Face ID / Touch ID (iPhone / iPad app): open with it, or offer to keep the password for it
  const [bio, setBio] = useState<string | null>(null)
  const [useBio, setUseBio] = useState(true)
  const saved = hasBiometricPassword(folderId)
  const tried = useRef(false)
  useEffect(() => {
    void biometricName().then(setBio)
  }, [])

  const finish = () => {
    onDone?.()
    onClose()
  }
  const tryBiometric = async () => {
    const secret = await readBiometricPassword(folderId, folderName)
    if (secret === null) return
    if (await unlockFolder(folderId, secret)) return finish()
    // the password was changed on another device
    forgetBiometricPassword(folderId)
    setError(`The password has changed – type it once more to use ${bio ?? 'Face ID'} again.`)
  }
  useEffect(() => {
    if (mode !== 'unlock' || !saved || tried.current) return
    tried.current = true
    void tryBiometric()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const needsNew = mode === 'set' || mode === 'change'
  const title = mode === 'set' ? `Lock “${folderName}”` : mode === 'unlock' ? `“${folderName}” is locked` : mode === 'change' ? `Change the password for “${folderName}”` : `Remove the password from “${folderName}”`

  const submit = async () => {
    setError(null)
    if (needsNew && pw.length < 4) return setError('Use at least 4 characters.')
    if (needsNew && pw !== again) return setError('The two passwords don’t match.')
    setBusy(true)
    try {
      if (mode === 'set') await setFolderPassword(folderId, pw)
      else if (mode === 'unlock') {
        if (!(await unlockFolder(folderId, current))) return setError('That’s not the password.')
      } else if (mode === 'change') {
        if (!(await unlockFolder(folderId, current))) return setError('The current password isn’t right.')
        await setFolderPassword(folderId, pw)
      } else if (!(await removeFolderPassword(folderId, current))) return setError('That’s not the password.')
      if (mode === 'remove') forgetBiometricPassword(folderId)
      else if (bio && (saved || useBio)) {
        const keep = mode === 'unlock' ? current : pw
        await saveBiometricPassword(folderId, keep).catch(() => forgetBiometricPassword(folderId))
      } else if (mode === 'change') forgetBiometricPassword(folderId)
      finish()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog password-dialog"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="password-icon">
          <Lock size={26} />
        </div>
        <h2>{title}</h2>
        {mode === 'set' && (
          <p className="hint">
            Its notes (and its subfolders’) are hidden – in lists, search, tags and “Ask your notes” – until it’s unlocked with this password, on any of your
            devices. It locks again after a minute in the background. This keeps them private on screen; it doesn’t encrypt them on your server. There’s no way
            to recover a forgotten password.
          </p>
        )}
        {needsCurrent && (
          <label>
            {mode === 'change' ? 'Current password' : 'Password'}
            <input type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </label>
        )}
        {needsNew && (
          <>
            <label>
              {mode === 'change' ? 'New password' : 'Password'}
              <input type="password" autoFocus={!needsCurrent} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            </label>
            <label>
              Again
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        {bio && mode !== 'remove' && !saved && (
          <label className="check">
            <input type="checkbox" checked={useBio} onChange={(e) => setUseBio(e.target.checked)} /> Open it with {bio} on this device
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          {bio && mode === 'unlock' && saved && (
            <button type="button" onClick={() => void tryBiometric()}>
              <ScanFace size={15} /> {bio}
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />} {mode === 'unlock' ? 'Unlock' : mode === 'remove' ? 'Remove password' : mode === 'set' ? 'Lock folder' : 'Change'}
          </button>
        </div>
      </form>
    </div>
  )
}
