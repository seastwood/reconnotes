import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { onWorkspaceChange, type WorkspaceSnapshot } from './workspace'
import { settings } from './settings'

/**
 * Reminders for due items (iOS app): a notification at 9:00 on the day an
 * open item is due. Rescheduled whenever due dates change on any device.
 * iOS keeps at most 64 pending notifications, so only the next 60 are set.
 */

const HOUR = 9
const MAX = 60
const KEY = 'reconnotes.reminders'

/** Notification ids must be numbers: a stable hash of the due item's id. */
function numId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0
  return Math.abs(h) || 1
}

function wanted(ws: WorkspaceSnapshot) {
  const now = Date.now()
  return ws.notes
    .filter((n) => !n.trashedAt && !n.template)
    .flatMap((n) => n.due.filter((d) => !d.done).map((d) => ({ ...d, noteId: n.id, noteTitle: n.title || 'Untitled' })))
    .map((d) => {
      const [y, m, day] = d.date.split('-').map(Number)
      return { ...d, at: new Date(y, m - 1, day, HOUR, 0, 0) }
    })
    .filter((d) => d.at.getTime() > now)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, MAX)
}

let last = ''
let timer: ReturnType<typeof setTimeout> | null = null

async function reschedule(ws: WorkspaceSnapshot) {
  const items = settings.get().dueReminders === false ? [] : wanted(ws)
  const sig = JSON.stringify(items.map((i) => [i.id, i.date, i.text]))
  if (sig === last) return
  last = sig
  // cancel what we scheduled before, then schedule the current set
  let previous: number[] = []
  try {
    previous = JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    /* none */
  }
  if (previous.length) await LocalNotifications.cancel({ notifications: previous.map((id) => ({ id })) }).catch(() => undefined)
  if (!items.length) {
    localStorage.setItem(KEY, '[]')
    return
  }
  const perm = await LocalNotifications.checkPermissions()
  if (perm.display !== 'granted' && (await LocalNotifications.requestPermissions()).display !== 'granted') return
  await LocalNotifications.schedule({
    notifications: items.map((i) => ({
      id: numId(i.id),
      title: i.text || 'Due today',
      body: `Due today · ${i.noteTitle}`,
      schedule: { at: i.at, allowWhileIdle: true },
      extra: { noteId: i.noteId },
    })),
  })
  localStorage.setItem(KEY, JSON.stringify(items.map((i) => numId(i.id))))
}

/** Start keeping reminders in step with the notes; tapping one opens its note. */
export function startReminders(openNote: (noteId: string) => void) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LocalNotifications')) return
  void LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const id = (e.notification.extra as { noteId?: string } | undefined)?.noteId
    if (id) openNote(id)
  })
  const run = (ws: WorkspaceSnapshot) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void reschedule(ws).catch(() => undefined), 2000)
  }
  onWorkspaceChange(run)
  settings.subscribe(() => {
    last = ''
  })
}
