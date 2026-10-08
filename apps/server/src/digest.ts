import { WORKSPACE_DOC, effectiveFolderId, folderPaths, getSettings, listFolders, noteDocName, noteToMarkdown } from '@reconnotes/core'
import type { Ai } from './ai'
import type { Jobs } from './jobs'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { DIGEST_PREFIX, noteFilter } from './access'
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
export { DIGEST_PREFIX }
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

/** A note's title on one line (a handwritten note's title can be a whole paragraph). */
export function oneLine(title: string, max = 50): string {
  const t = (title || 'Untitled').split('\n')[0].replace(/[[\]|#]/g, '').replace(/\s+/g, ' ').trim() || 'Untitled'
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t
}

const SECTIONS = [
  { heading: 'This week', match: /week|happen|highlight|summary|done|progress/i, max: 5 },
  { heading: 'Decisions', match: /decid|decision/i, max: 4 },
  { heading: 'Still open', match: /open|todo|to-do|next|pending|follow/i, max: 5 },
] as const

/**
 * Make the AI's summary short and tidy, whatever it wrote: no "Here is…",
 * one level of bullets, a few per section, each cut to one line, with its
 * note linked (`[n]` → the note). `link(n)` gives the link for source n.
 */
export function tidySummary(raw: string, link: (n: number) => string | null): string {
  const out = new Map<string, string[]>(SECTIONS.map((x) => [x.heading, []]))
  let cur: string = SECTIONS[0].heading
  const seen = new Set<string>()
  for (const line0 of raw.split('\n')) {
    const line = line0.replace(/\*\*|__/g, '').trim()
    if (!line) continue
    // a heading (### Decisions, Decisions:, **Still open**)
    const heading = /^#{1,6}\s*(.+)$/.exec(line)?.[1] ?? (/^[^-*•\d][^.]{0,40}:$/.test(line) ? line.slice(0, -1) : null)
    if (heading) {
      const sec = SECTIONS.find((x) => x.match.test(heading))
      if (sec) cur = sec.heading
      continue
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1]
    if (!bullet || /:\s*$/.test(bullet)) continue // prose (an introduction) or a group label
    const cites = [...new Set([...bullet.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
    let text = bullet.replace(/\s*\[\d+\]/g, '').trim().replace(/[.;,]+$/, '')
    if (text.length > 120) text = `${text.slice(0, 117).replace(/\s+\S*$/, '')}…`
    const key = text.toLowerCase().replace(/\W+/g, ' ').trim()
    if (!text || seen.has(key)) continue
    seen.add(key)
    const links = cites.map(link).filter(Boolean).slice(0, 2)
    const list = out.get(cur)!
    if (list.length < SECTIONS.find((x) => x.heading === cur)!.max) list.push(`- ${text}${links.length ? ` – ${links.join(', ')}` : ''}`)
  }
  return SECTIONS.filter((x) => out.get(x.heading)!.length)
    .map((x) => `## ${x.heading}\n${out.get(x.heading)!.join('\n')}`)
    .join('\n\n')
}

/** The digest note's title and Markdown, for the 7 days before today. */
export async function buildDigest(store: Store, sync: SyncEngine, ai: Ai, now: number, tz: number): Promise<{ title: string; markdown: string; noteFor: (t: string) => string | null; agent: string | null }> {
  const allowed = noteFilter(sync)
  const meta = sync.noteMeta()
  const today = startOfToday(now, tz)
  const from = today - 7 * DAY
  const title = `${DIGEST_PREFIX} – ${shortDate(from, tz)} to ${shortDate(today - DAY, tz)}`
  const ws = sync.getDoc(WORKSPACE_DOC)
  const folders = ws ? listFolders(ws) : []
  const paths = folderPaths(folders)
  const live = new Set(paths.keys())
  const dailyFolder = digestFolder(sync)
  const notes = [...meta.values()]
    .filter((m) => !m.trashedAt && !m.template && allowed(m.id) && m.updatedAt >= from && m.updatedAt < today && !m.title.startsWith(DIGEST_PREFIX))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  // each note's text, and whether it says enough to be worth a mention
  const text = new Map(notes.map((n) => [n.id, ((d) => (d ? noteToMarkdown(d) : ''))(sync.getDoc(noteDocName(n.id)))]))
  const substantial = (id: string) => (text.get(id) ?? '').replace(/[^\p{L}\p{N}]+/gu, '').length >= 40
  // links: [[n12|Short title]] (a key per note, so long or repeated titles still link)
  const keyOf = new Map(notes.map((n, i) => [n.id, `n${i + 1}`]))
  const idOf = new Map(notes.map((n, i) => [`n${i + 1}`, n.id]))
  const link = (id: string) => `[[${keyOf.get(id)}|${oneLine(meta.get(id)!.title, 40)}]]`

  const md: string[] = []
  // a short summary, when an AI is set up (the rest doesn't need one)
  let agent: string | null = null
  const worth = notes.filter((n) => substantial(n.id) && n.folderId !== dailyFolder)
  if (worth.length && ai.agents.available('compile')) {
    const sources: string[] = []
    let context = ''
    for (const n of worth.slice(0, 15)) {
      const t = (text.get(n.id) ?? '').slice(0, 1200)
      if (context.length + t.length > 10000) break
      sources.push(n.id)
      context += `\n\n=== [${sources.length}] ${oneLine(n.title, 60)} ===\n${t}`
    }
    try {
      const r = await ai.ask(
        `Write a short review of my week from my notes below. Use exactly these headings and nothing else:

## This week
(3 to 5 bullets: the main things that happened or were worked on)
## Decisions
(only decisions the notes state; leave the heading out if there are none)
## Still open
(up to 5 bullets: things still to do)

Rules:
- Each bullet is ONE short line (at most 15 words) and ends with the note it came from, like [2].
- Merge related points into one bullet. No sub-bullets, no bold, no introduction, no closing remarks.
- Only what the notes say.

Notes:${context}`,
      )
      const summary = tidySummary(r.text, (k) => (sources[k - 1] ? link(sources[k - 1]) : null))
      if (summary) {
        md.push(summary, '')
        agent = r.agent
      }
    } catch (err) {
      log.warn(`weekly digest: no summary – ${(err as Error).message}`)
    }
  }

  // to-dos with dates: plain lines (not checkboxes, so they aren't to-dos twice)
  const tasks = new Tasks(store, sync).list(allowed, { done: false }).filter((t) => !t.title.startsWith(DIGEST_PREFIX))
  const dayOf = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, dd) + tz * 60_000
  }
  const noteLink = (id: string) => (keyOf.has(id) ? link(id) : oneLine(meta.get(id)?.title ?? '', 40))
  const line = (t: (typeof tasks)[number]) => `- ${oneLine(t.text, 80)} – ${shortDate(dayOf(t.due!), tz)} (${noteLink(t.noteId)})`
  const overdue = tasks.filter((t) => t.due && dayOf(t.due) < today).sort((a, b) => a.due!.localeCompare(b.due!))
  const coming = tasks.filter((t) => t.due && dayOf(t.due) >= today && dayOf(t.due) < today + 7 * DAY).sort((a, b) => a.due!.localeCompare(b.due!))
  if (overdue.length) md.push(`## Overdue (${overdue.length})`, ...overdue.slice(0, 10).map(line), ...(overdue.length > 10 ? [`- …and ${overdue.length - 10} more – see Due`] : []), '')
  if (coming.length) md.push('## Due in the next 7 days', ...coming.slice(0, 10).map(line), '')
  const undated = tasks.filter((t) => !t.due).length
  if (undated) md.push(`${undated} open to-do${undated === 1 ? '' : 's'} without a date – see Tasks.`, '')

  // the notes, by folder, on one line each
  md.push(`## Notes this week (${notes.length})`)
  if (!notes.length) md.push('No notes written or edited this week.')
  const byFolder = new Map<string, string[]>()
  let quick = 0
  for (const n of notes) {
    if (!substantial(n.id)) {
      quick++
      continue
    }
    const f = effectiveFolderId(n, live)
    const where = f ? (paths.get(f) ?? []).join(' › ') : 'Not in a folder'
    byFolder.set(where, [...(byFolder.get(where) ?? []), link(n.id)])
  }
  for (const [where, links] of [...byFolder].sort((a, b) => b[1].length - a[1].length)) md.push(`- **${where}:** ${links.join(' · ')}`)
  if (quick) md.push(`- ${quick} short note${quick === 1 ? '' : 's'} (a line or two)`)

  return { title, markdown: md.join('\n').trim(), noteFor: (t) => idOf.get(t) ?? null, agent }
}

/** Where digests go: the Daily notes folder, when there is one. */
export function digestFolder(sync: SyncEngine): string | null {
  const ws = sync.getDoc(WORKSPACE_DOC)
  return ws ? ((getSettings(ws).get('dailyFolder') as string | undefined) ?? null) : null
}
