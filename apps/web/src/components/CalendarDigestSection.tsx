import { useEffect, useState } from 'react'
import { CalendarPlus, Copy, Loader2, RefreshCw, Send } from 'lucide-react'
import { api } from '../lib/api'
import { openExternal } from '../lib/appLinks'
import { watchingJob, type Job } from '../lib/jobs'
import { showToast } from '../lib/toast'

interface Digest {
  enabled: boolean
  day: number
  hour: number
  tzOffset: number
}

const DAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 4 + i).toLocaleDateString(undefined, { weekday: 'long' }))
const HOURS = Array.from({ length: 24 }, (_, h) => new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }))

/**
 * Settings › Calendar & weekly digest: subscribe to your due dates in any
 * calendar app, and get a note about your week every week.
 */
export function CalendarDigestSection() {
  const [feed, setFeed] = useState<string | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void api<{ url: string }>('GET', '/api/calendar').then((r) => setFeed(r.url)).catch(() => {})
    void api<Digest>('GET', '/api/digest').then(setDigest).catch(() => {})
  }, [])

  const webcal = feed?.replace(/^https?:/, 'webcal:')
  const copy = async () => {
    if (!feed) return
    try {
      await navigator.clipboard.writeText(feed)
      showToast('Calendar address copied')
    } catch {
      prompt('Copy this address', feed)
    }
  }
  const reset = async () => {
    if (!confirm('Make a new address? Calendars subscribed to the old one stop getting your due dates.')) return
    setFeed((await api<{ url: string }>('POST', '/api/calendar/reset')).url)
  }
  const saveDigest = async (patch: Partial<Digest>) => {
    if (!digest) return
    setBusy('digest')
    try {
      setDigest(await api<Digest>('PUT', '/api/digest', { ...digest, ...patch, tzOffset: new Date().getTimezoneOffset() }))
    } finally {
      setBusy(null)
    }
  }
  const sendNow = async () => {
    setBusy('now')
    try {
      const { job } = await api<{ job: Job }>('POST', '/api/digest/run', { tzOffset: new Date().getTimezoneOffset() })
      watchingJob(job.id, false)
      showToast('Writing this week’s digest – it’ll be a new note (see Jobs)')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <p className="hint">
        Your to-dos with a due date, in Apple Calendar, Google Calendar or Outlook – kept up to date as you add and tick them. Locked folders are left out.
        The address is private: anyone with it can see your dated to-dos.
      </p>
      {feed && (
        <>
          <input className="mono feed-url" readOnly value={feed} onFocus={(e) => e.target.select()} aria-label="Calendar feed address" />
          <div className="row">
            <button onClick={() => webcal && openExternal(webcal)}>
              <CalendarPlus size={15} /> Subscribe
            </button>
            <button onClick={() => void copy()}>
              <Copy size={15} /> Copy address
            </button>
            <button className="text" onClick={() => void reset()}>
              <RefreshCw size={14} /> New address
            </button>
          </div>
          <p className="hint">On iPhone: Subscribe, or Settings › Calendar › Accounts › Add Account › Other › Add Subscribed Calendar. Your server must be reachable from where the calendar app checks (for Google Calendar, from the internet).</p>
        </>
      )}

      <h4>Weekly digest</h4>
      <p className="hint">
        Once a week, a note about your week: a short summary by your AI, the notes you wrote or edited, what’s overdue and what’s due next. It goes in your Daily
        notes folder, and you’re notified like for other jobs.
      </p>
      {digest && (
        <>
          <label className="check">
            <input type="checkbox" checked={digest.enabled} disabled={busy === 'digest'} onChange={(e) => void saveDigest({ enabled: e.target.checked })} /> Write a weekly digest
          </label>
          {digest.enabled && (
            <div className="row">
              <select value={digest.day} onChange={(e) => void saveDigest({ day: Number(e.target.value) })} aria-label="Day">
                {DAYS.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              <select value={digest.hour} onChange={(e) => void saveDigest({ hour: Number(e.target.value) })} aria-label="Time">
                {HOURS.map((h, i) => (
                  <option key={i} value={i}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button onClick={() => void sendNow()} disabled={busy === 'now'}>
            {busy === 'now' ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Write one now
          </button>
        </>
      )}
    </>
  )
}
