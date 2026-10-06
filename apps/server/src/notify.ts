import type { Store } from './store'
import type { Job } from './jobs'
import { log } from './log'
import type { Apns } from './apns'

/**
 * Notifications when your jobs finish
 * ===================================
 *
 * The app shows its own notification while it's running. When it isn't (the
 * phone is locked, the app was closed), the server sends one through a
 * service that can reach your phone without an Apple developer account:
 *
 * - ntfy (https://ntfy.sh, or self-hosted): a free app; subscribe to a topic.
 * - Home Assistant: its companion app's notify service (notify.mobile_app_…).
 * - A webhook: JSON to any URL (Gotify, n8n, Node-RED…).
 *
 * Only jobs a person asked for are announced (not background work), and not
 * while the device that asked is open and watching its jobs.
 */

export interface NotifySettings {
  kind: 'off' | 'ntfy' | 'homeassistant' | 'webhook'
  /** ntfy: the topic URL (https://ntfy.sh/my-secret-topic); HA: the base URL; webhook: the URL */
  url: string
  /** ntfy access token or Home Assistant long-lived token (optional for ntfy / webhook) */
  token: string
  /** Home Assistant: the notify service, e.g. mobile_app_seths_iphone */
  service: string
  onDone: boolean
  onFailed: boolean
  /** only jobs that took at least this long (seconds) – quick ones you were watching anyway */
  minSeconds: number
}

const KEY = 'notify'
const DEFAULTS: NotifySettings = { kind: 'off', url: '', token: '', service: '', onDone: true, onFailed: true, minSeconds: 0 }

export interface Notice {
  title: string
  message: string
  /** opens the note in the app */
  link: string | null
  failed: boolean
}

export class Notifier {
  /** when each device last asked about its jobs (it's open: it notifies itself) */
  private watching = new Map<string, number>()

  constructor(
    private store: Store,
    /** push notifications straight to the iPhone / iPad app */
    readonly apns?: Apns,
  ) {}

  settings(): NotifySettings {
    return { ...DEFAULTS, ...(this.store.getSetting<Partial<NotifySettings>>(KEY) ?? {}) }
  }

  /** Settings as the app sees them (the token isn't sent back). */
  view() {
    const s = this.settings()
    return { ...s, token: '', hasToken: Boolean(s.token) }
  }

  save(patch: Partial<NotifySettings> & { token?: string }) {
    const cur = this.settings()
    const next: NotifySettings = {
      kind: (['off', 'ntfy', 'homeassistant', 'webhook'] as const).includes(patch.kind as NotifySettings['kind']) ? patch.kind! : cur.kind,
      url: patch.url !== undefined ? String(patch.url).trim().slice(0, 500) : cur.url,
      // an empty token leaves the saved one; "-" clears it
      token: patch.token === '-' ? '' : patch.token ? String(patch.token).trim().slice(0, 1000) : cur.token,
      service: patch.service !== undefined ? String(patch.service).trim().replace(/^notify\./, '').slice(0, 200) : cur.service,
      onDone: patch.onDone ?? cur.onDone,
      onFailed: patch.onFailed ?? cur.onFailed,
      minSeconds: Math.max(0, Math.min(3600, Number(patch.minSeconds ?? cur.minSeconds) || 0)),
    }
    this.store.setSetting(KEY, next)
  }

  /** A device is open and following its jobs. */
  seen(device: string | null) {
    this.watching.set(device ?? '', Date.now())
  }

  /** The device went to the background (iOS stops it soon): the server notifies it from now on. */
  away(device: string | null) {
    this.watching.delete(device ?? '')
  }

  /** A job finished: tell the person who asked for it, if they're not looking. */
  jobFinished(job: Job, label: string) {
    const s = this.settings()
    if (job.origin !== 'user') return
    if (job.status === 'done' ? !s.onDone : job.status === 'failed' ? !s.onFailed : true) return
    const took = ((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000
    if (took < s.minSeconds) return
    // the device that asked is open: it shows its own notification
    if (Date.now() - (this.watching.get(job.device ?? '') ?? 0) < 40_000) return
    const note = job.kind === 'compile' && typeof job.result?.noteId === 'string' ? job.result.noteId : job.noteId
    const notice: Notice = {
      title: job.kind === 'ask' && job.status === 'done' ? 'Your notes have an answer' : job.status === 'done' ? `${label} finished` : `${label} failed`,
      message: job.status === 'done' ? job.title : `${job.title}: ${job.error ?? 'failed'}`.slice(0, 400),
      link: note ? `reconnotes://open?note=${note}` : null,
      failed: job.status === 'failed',
    }
    // the app on the device that asked, straight through Apple
    if (this.apns?.config()) {
      const data: Record<string, string> = { jobId: job.id }
      if (note) data.noteId = note
      if (job.kind === 'ask') data.question = String(job.input.question ?? '')
      void this.apns
        .send({ title: notice.title, body: notice.message, data }, this.pushTargets(job.device))
        .catch((err) => log.warn(`push notification failed: ${(err as Error).message}`))
    }
    if (s.kind !== 'off' && s.url) void this.send(notice).catch((err) => log.warn(`notification failed: ${(err as Error).message}`))
  }

  /** Push devices of the device (key) that asked: by its name, or the main key's devices. */
  private pushTargets(device: string | null): string[] {
    const all = this.apns?.devices() ?? []
    return [...new Set(all.filter((d) => (device ? d.name === device : d.deviceId === 'main')).map((d) => d.deviceId))]
  }

  async send(n: Notice, s = this.settings()): Promise<void> {
    if (s.kind === 'off' || !s.url) throw new Error('Notifications are off.')
    const signal = AbortSignal.timeout(15_000)
    let res: Response
    if (s.kind === 'ntfy') {
      res = await fetch(s.url, {
        method: 'POST',
        signal,
        headers: {
          // header values must be plain ASCII-ish text
          Title: encodeHeader(n.title),
          Tags: n.failed ? 'warning' : 'white_check_mark',
          ...(n.link ? { Click: n.link } : {}),
          ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}),
        },
        body: n.message,
      })
    } else if (s.kind === 'homeassistant') {
      if (!s.service) throw new Error('Enter the Home Assistant notify service, e.g. mobile_app_my_phone.')
      res = await fetch(`${s.url.replace(/\/+$/, '')}/api/services/notify/${encodeURIComponent(s.service)}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        // the companion app opens data.url when tapped
        body: JSON.stringify({ title: n.title, message: n.message, data: n.link ? { url: n.link, clickAction: n.link } : {} }),
      })
    } else {
      res = await fetch(s.url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}) },
        body: JSON.stringify(n),
      })
    }
    if (!res.ok) throw new Error(`${s.kind} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
}

/** ntfy reads RFC 2047 encoded headers, so titles with emoji or accents survive. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`
}
