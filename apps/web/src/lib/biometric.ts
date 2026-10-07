import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Face ID / Touch ID for locked folders
 * =====================================
 *
 * In the iPhone / iPad app, after you type a folder's password once, it can
 * be kept in this device's Keychain behind Face ID (or Touch ID), so the next
 * time the folder opens with a glance. Nothing leaves the device; changing
 * the enrolled faces / fingers forgets it, and so does changing or removing
 * the folder's password.
 */

interface BiometricPlugin {
  available(): Promise<{ available: boolean; kind: 'faceID' | 'touchID' | 'opticID' | 'none' }>
  save(o: { key: string; secret: string }): Promise<void>
  read(o: { key: string; reason: string }): Promise<{ secret: string }>
  remove(o: { key: string }): Promise<void>
}
const Native = registerPlugin<BiometricPlugin>('Biometric')
const native = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Biometric')

const NAMES = { faceID: 'Face ID', touchID: 'Touch ID', opticID: 'Optic ID' } as const

let kind: Promise<string | null> | null = null
/** "Face ID" / "Touch ID" when this device can use it, else null */
export function biometricName(): Promise<string | null> {
  kind ??= native()
    ? Native.available()
        .then((r) => (r.available && r.kind !== 'none' ? NAMES[r.kind] : null))
        .catch(() => null)
    : Promise.resolve(null)
  return kind
}

// which folders have a password saved here (so we only ask Face ID for those)
const LIST = 'reconnotes.biometricFolders'
const saved = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIST) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
const store = (s: Set<string>) => {
  try {
    localStorage.setItem(LIST, JSON.stringify([...s]))
  } catch {
    /* private mode */
  }
}
export const hasBiometricPassword = (folderId: string) => native() && saved().has(folderId)

export async function saveBiometricPassword(folderId: string, password: string) {
  await Native.save({ key: `folder:${folderId}`, secret: password })
  store(new Set([...saved(), folderId]))
}

/** The saved password, after Face ID; null if cancelled or not saved. */
export async function readBiometricPassword(folderId: string, folderName: string): Promise<string | null> {
  try {
    return (await Native.read({ key: `folder:${folderId}`, reason: `Unlock “${folderName}”` })).secret
  } catch (e) {
    if ((e as { code?: string }).code === 'not-found') forgetBiometricPassword(folderId)
    return null
  }
}

export function forgetBiometricPassword(folderId: string) {
  if (!native()) return
  void Native.remove({ key: `folder:${folderId}` }).catch(() => {})
  const s = saved()
  s.delete(folderId)
  store(s)
}
