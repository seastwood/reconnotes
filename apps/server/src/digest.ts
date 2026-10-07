import { WORKSPACE_DOC, getSettings, noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Ai } from './ai'
import type { Jobs } from './jobs'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { noteFilter } from './access'
import { log } from './log'
import { Tasks } from './tasks'
import { shortDate, startOfToday } from './timeRange'

/**
 * Weekly digest
 * =============
 *
 * Once a week (the day and hour you choose), a note about the week that was:
 * a short summary written by your AI (when one is set up), the notes you
 * wrote or edited (linked), what's overdue and what's due in the week ahead.
 * It goes in your Daily notes folder, and you're notified like any job.
 * Locked folders are left out.
 */

export interface DigestSettings {
  enabled: boolean
  /** 0 = Sunday … 6 = Saturday */
  day: number
  /** 0–23, in the time zone below */
  hour: number
  /** Date#getTimezoneOffset of the device that set it */
  tzOffset: number
  /** when it last ran (ms) */
  lastRun?: number
}

export const DIGEST_DEFAULTS: DigestSettings = { enabled: false, day: 0, hour: 18, tzOffset: 0 }
export const DIGEST_PREFIX = 'Week in review'
const DAY = 86_400_000

export function digestSettings(store: Store): DigestSettings {
  return { ...DIGEST_DEFAULTS, ...(store.getSetting<Partial<DigestSettings>>('weeklyDigest') ?? {}) }
}

/** The last time it should have run (at or before `now`). */
export function lastSlot(s: DigestSettings, now: number): number {
  // the wall clock where the person is
  const local = new Date(now - s.tzOffset * 60_000)
  const slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), s.hour) - ((local.getUTCDay() - s.day + 7) % 7) * DAY
  const at = slot + s.tzOffset * 60_000
  return at > now ? at - 7 * DAY : at
}

/** Check every few minutes whether it's time; submits a 'digest' job when it is. */
export function startDigestSchedule(store: Store, jobs: Jobs): () => void {
  const check = () => {
    const s = digestSettings(store)
    if (!s.enabled) return
    const slot = lastSlot(s, Date.now())
    // only a recent slot (the server was off for a week: don't send an old one)
    if ((s.lastRun ?? 0) >= slot || Date.now() - slot > DAY) return
    store.setSetting('weeklyDigest', { ...s, lastRun: Date.now() })
    jobs.submit({ kind: 'digest', title: 'Weekly digest', input: { tzOffset: s.tzOffset }, origin: 'user' })
  }
  const timer = setInterval(check, 5 * 60_000)
  timer.unref?.()
  setTimeout(check, 30_000).unref?.()
  return () => clearInterval(timer)
}

/** The digest note's title and Markdown, for the 7 days up to `now`. */
export async function buildDigest(store: Store, sync: SyncEngine, ai: Ai, now: number, tz: number): Promise<{ title: string; markdown: string; noteFor: (t: string) => string | null; agent: string | null }> {
  const allowed = noteFilter(sync)
  const meta = sync.noteMeta()
  const today = startOfToday(now, tz)
  const from = today - 7 * DAY
  const title = `${DIGEST_PREFIX} – ${shortDate(from, tz)} to ${shortDate(now - DAY, tz)}`
  const notes = [...meta.values()]
    .filter((m) => !m.trashedAt && !m.template && allowed(m.id) && m.updatedAt >= from && !m.title.startsWith(DIGEST_PREFIX))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  // [[Title]] links: titles to notes (the first of each title)
  const byTitle = new Map<string, string>()
  for (const n of notes) if (n.title && !byTitle.has(n.title)) byTitle.set(n.title, n.id)

  const md: string[] = []
  // a short summary, when an AI is set up (the rest doesn't need one)
  let agent: string | null = null
  if (notes.length && ai.agents.available('compile')) {
    let context = ''
    for (const n of notes.slice(0, 15)) {
      const doc = sync.getDoc(noteDocName(n.id))
      if (!doc) continue
      const text = noteToMarkdown(doc).slice(0, 1500)
      if (context.length + text.length > 12000) break
      context += `\n\n=== "${n.title || 'Untitled'}" ===\n${text}`
    }
    try {
      const r = await ai.ask(
        `Summarise my week from the notes below (my own notes): 3 to 6 short bullet points ("- ") about what happened, what was decided and what's still open. Only what the notes say – no advice, no introduction.\n\nNotes:${context}`,
      )
      if (r.text.trim()) {
        md.push('## Summary', r.text.trim(), '')
        agent = r.agent
      }
    } catch (err) {
      log.warn(`weekly digest: no summary – ${(err as Error).message}`)
    }
  }

  md.push(`## Notes this week (${notes.length})`)
  if (!notes.length) md.push('No notes written or edited this week.')
  for (const n of notes.slice(0, 40)) {
    const created = n.createdAt >= from
    const label = n.title && byTitle.get(n.title) === n.id ? `[[${n.title}]]` : n.title || 'Untitled'
    md.push(`- ${label} – ${created ? 'new' : 'edited'} ${shortDate(n.updatedAt, tz)}`)
  }
  if (notes.length > 40) md.push(`- …and ${notes.length - 40} more`)

  // to-dos with dates: plain lines (not checkboxes, so they aren't to-dos twice)
  const open = new Tasks(store, sync).list(allowed, { done: false }).filter((t) => t.due && !t.title.startsWith(DIGEST_PREFIX))
  const dayOf = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, dd) + tz * 60_000
  }
  const overdue = open.filter((t) => dayOf(t.due!) < today).sort((a, b) => a.due!.localeCompare(b.due!))
  const coming = open.filter((t) => dayOf(t.due!) >= today && dayOf(t.due!) < today + 7 * DAY).sort((a, b) => a.due!.localeCompare(b.due!))
  const line = (t: (typeof open)[number]) => `- ${t.text} – ${shortDate(dayOf(t.due!), tz)}${t.title ? ` (${byTitle.get(t.title) === t.noteId ? `[[${t.title}]]` : t.title})` : ''}`
  if (overdue.length) md.push('', `## Overdue (${overdue.length})`, ...overdue.slice(0, 30).map(line))
  md.push('', '## Due this coming week', ...(coming.length ? coming.slice(0, 30).map(line) : ['Nothing with a date.']))
  const undated = new Tasks(store, sync).list(allowed, { done: false }).filter((t) => !t.due && !t.title.startsWith(DIGEST_PREFIX)).length
  if (undated) md.push('', `${undated} other open to-do${undated === 1 ? '' : 's'} without a date – see Tasks.`)

  return { title, markdown: md.join('\n'), noteFor: (t) => byTitle.get(t) ?? null, agent }
}

/** Where digests go: the Daily notes folder, when there is one. */
export function digestFolder(sync: SyncEngine): string | null {
  const ws = sync.getDoc(WORKSPACE_DOC)
  return ws ? ((getSettings(ws).get('dailyFolder') as string | undefined) ?? null) : null
}
