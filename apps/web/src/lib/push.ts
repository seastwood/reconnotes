import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { api } from './api'
import { isSyncConfigured, settings } from './settings'

/**
 * Push notifications in the iPhone / iPad app
 * ===========================================
 *
 * Your ReconNotes server sends them straight through Apple (APNs), so they
 * arrive like any other app's – with the app closed or the phone locked.
 * The app registers with Apple, gets a device token and hands it to the server.
 */

export const pushSupported = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PushNotifications')

/** this device gets its notifications from the server (so it doesn't show its own as well) */
export const pushOn = () => pushSupported() && Boolean(settings.get().pushNotifications)

/** Register with Apple and give the token to the server. */
function register(): Promise<string> {
  return new Promise((resolve, reject) => {
    const handles: Promise<{ remove: () => Promise<void> }>[] = []
    const done = () => handles.forEach((h) => void h.then((x) => x.remove()))
    const timer = setTimeout(() => {
      done()
      reject(new Error('Apple didn’t answer. Check the internet connection and try again.'))
    }, 20_000)
    handles.push(
      PushNotifications.addListener('registration', (t) => {
        clearTimeout(timer)
        done()
        void api('POST', '/api/push/register', { token: t.value, name: deviceLabel() })
          .then(() => resolve(t.value))
          .catch(reject)
      }),
      PushNotifications.addListener('registrationError', (e) => {
        clearTimeout(timer)
        done()
        reject(
          new Error(
            /entitlement|aps-environment/i.test(e.error)
              ? 'This build of the app can’t receive notifications yet: turn on Push Notifications for it (npm run ios:enable-push on the Mac – needs a paid Apple developer account), then rebuild.'
              : `Apple refused: ${e.error}`,
          ),
        )
      }),
    )
    void PushNotifications.register().catch((e) => {
      clearTimeout(timer)
      done()
      reject(e as Error)
    })
  })
}

const deviceLabel = () => (/iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent)) ? 'iPad' : 'iPhone')

/** Turn notifications on for this device (from a tap: asks for permission). */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Only in the iPhone / iPad app.')
  let p = await PushNotifications.checkPermissions()
  if (p.receive !== 'granted') p = await PushNotifications.requestPermissions()
  if (p.receive !== 'granted') throw new Error('Notifications are blocked: allow them for ReconNotes in the iPhone’s Settings › Notifications.')
  const token = await register()
  settings.set({ pushNotifications: true, pushToken: token })
}

export async function disablePush(): Promise<void> {
  const token = settings.get().pushToken
  settings.set({ pushNotifications: false })
  if (token) await api('POST', '/api/push/unregister', { token }).catch(() => {})
}

/**
 * At start: refresh the registration (Apple can change the token), and open
 * what a tapped notification is about.
 */
export function startPush(open: { note(id: string): void; search(q: string): void }) {
  if (!pushSupported()) return
  void PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    const d = (a.notification.data ?? {}) as { noteId?: string; question?: string }
    if (d.question) open.search(d.question)
    else if (d.noteId) open.note(d.noteId)
  })
  if (pushOn() && isSyncConfigured())
    void PushNotifications.checkPermissions().then((p) => {
      if (p.receive === 'granted') void register().then((t) => settings.set({ pushToken: t })).catch(() => {})
    })
}
