import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

/**
 * A system notification from the app itself (job finished…), for when the
 * app isn't on screen. iOS: a local notification (tapping it opens the note,
 * see reminders.ts). Browser: the Notification API.
 */

const native = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LocalNotifications')

export function notificationsSupported(): boolean {
  return native() || typeof Notification !== 'undefined'
}

/** Ask for permission (call from a tap). Returns whether notifications are allowed. */
export async function askNotificationPermission(): Promise<boolean> {
  if (native()) {
    const p = await LocalNotifications.checkPermissions()
    return p.display === 'granted' || (await LocalNotifications.requestPermissions()).display === 'granted'
  }
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  return (await Notification.requestPermission()) === 'granted'
}

let nextId = 1_000_000_000 + Math.floor(Math.random() * 1e6)

export async function showNotification(title: string, body: string, noteId: string | null, open: (id: string) => void) {
  if (native()) {
    const p = await LocalNotifications.checkPermissions()
    if (p.display !== 'granted') return
    await LocalNotifications.schedule({ notifications: [{ id: nextId++, title, body, extra: noteId ? { noteId } : undefined }] })
    return
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const n = new Notification(title, { body, tag: noteId ?? undefined })
  n.onclick = () => {
    window.focus()
    if (noteId) open(noteId)
    n.close()
  }
}
