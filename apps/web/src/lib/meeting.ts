import * as Y from 'yjs'
import { attendeeNames, attendeesText, createNote, getContent, noteDocName } from '@reconnotes/core'
import { flushNote } from './ai'
import { flushUploads } from './attachments'
import { Store } from './store'
import { submitJob } from './jobs'
import { isSyncConfigured } from './settings'
import { deviceCanDecode, transcribeOnDevice, useDeviceSpeech } from './speech'
import { sync } from './sync'
import { showToast } from './toast'
import { workspaceDoc } from './workspace'

/**
 * Meeting mode
 * ============
 *
 * One tap: a note for the meeting (its date and time, attendees, a place for
 * notes) and the recording starts. When it's stopped, the recording's
 * transcript and what you wrote become meeting notes: a summary, decisions
 * and the action items as a checklist – with due dates where a day was said.
 */

const block = (name: string, text = '', attrs: Record<string, unknown> = {}) => {
  const el = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string)
  if (text) el.insert(0, [new Y.XmlText(text)])
  return el
}

/** Make the meeting note and start recording in it. Returns the note's id (to open it). */
export async function startMeeting(folderId: string | null): Promise<string> {
  const now = new Date()
  const when = now.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  const title = `Meeting – ${when}`
  const id = createNote(workspaceDoc, { folderId, title })
  const { handle, close } = sync.open(noteDocName(id))
  await handle.loaded
  handle.doc.transact(() => {
    getContent(handle.doc).insert(0, [block('heading', title, { level: 1 }), block('paragraph', 'Attendees: '), block('heading', 'Notes', { level: 2 }), block('paragraph')])
  })
  setTimeout(close, 3000)
  // the note opens with its setup (who's there, the agenda – all optional), then records
  meetingSetup.set({ noteId: id })
  return id
}

/** The meeting note waiting for its setup (shown at the top of it until started or skipped). */
export const meetingSetup = new Store<{ noteId: string | null }>({ noteId: null })
/** Start the meeting's recording in this note (the setup's Start button; the note's recorder listens). */
export const meetingStart = new Store<{ noteId: string | null }>({ noteId: null })

const RECENT = 'reconnotes.recentAttendees'
/** People from your recent meetings (one tap to add them again). */
export function recentAttendees(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 24) : []
  } catch {
    return []
  }
}
function rememberAttendees(names: string[]) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([...new Set([...names, ...recentAttendees()])].slice(0, 24)))
  } catch {
    /* private mode */
  }
}

const textOf = (el: Y.XmlElement) =>
  el
    .toArray()
    .map((c) => (c instanceof Y.XmlText ? c.toString() : ''))
    .join('')
const setText = (el: Y.XmlElement, text: string) => {
  el.delete(0, el.length)
  el.insert(0, [new Y.XmlText(text)])
}

/**
 * Put the meeting's setup into its note: the name in the title, who's there on the
 * "Attendees:" line (Whisper spells them right, and the voices get their names), and the
 * agenda as a list under its own heading (the notes follow its order).
 */
/**
 * How many people were at a meeting, on its note's Attendees line ("Attendees: Seth, Jesse – 6
 * people", or "Attendees: 6 people" when nobody's named): the speaker labels find at most that many
 * voices. Keeps the names already there.
 */
export function setPeopleCount(doc: Y.Doc, count: number) {
  const content = getContent(doc)
  doc.transact(() => {
    const kids = content.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
    const att = kids.find((c) => c.nodeName === 'paragraph' && /^\s*attendees\s*:/i.test(textOf(c)))
    const names = att ? attendeeNames(textOf(att)) : []
    const text = `Attendees: ${attendeesText(names, count)}`
    if (att) setText(att, text)
    else {
      const title = kids.find((c) => c.nodeName === 'heading')
      content.insert(title ? content.toArray().indexOf(title) + 1 : 0, [block('paragraph', text)])
    }
  })
}

export function applyMeetingSetup(doc: Y.Doc, setup: { title?: string; attendees: string[]; count?: number; agenda: string[] }) {
  const content = getContent(doc)
  doc.transact(() => {
    const kids = content.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
    const title = kids.find((c) => c.nodeName === 'heading')
    if (setup.title?.trim() && title) setText(title, setup.title.trim())
    let att = kids.find((c) => c.nodeName === 'paragraph' && /^\s*attendees\s*:/i.test(textOf(c)))
    if (setup.attendees.length || setup.count) {
      const line = `Attendees: ${attendeesText(setup.attendees, setup.count)}`
      if (att) setText(att, line)
      else {
        att = block('paragraph', line)
        content.insert(title ? content.toArray().indexOf(title) + 1 : 0, [att])
      }
    }
    const items = setup.agenda.map((a) => a.trim()).filter(Boolean)
    if (items.length) {
      const list = new Y.XmlElement('bulletList')
      list.insert(
        0,
        items.map((t) => {
          const li = new Y.XmlElement('listItem')
          li.insert(0, [block('paragraph', t)])
          return li
        }),
      )
      const after = att ?? title
      const at = after ? content.toArray().indexOf(after) + 1 : 0
      content.insert(at, [block('heading', 'Agenda', { level: 2 }), list])
    }
  })
  if (setup.attendees.length) rememberAttendees(setup.attendees)
}

/** "Seth, Jesse and Paul" → the names. */
export const splitNames = (text: string) => [
  ...new Set(
    text
      .split(/\s*(?:,|;|\band\b|&|\n)\s*/i)
      .map((n) => n.trim())
      .filter(Boolean),
  ),
]

/** The meeting's recording is in the note: write the meeting notes (a job). */
export async function writeMeetingNotes(noteId: string, attachmentId: string, blob: Blob) {
  if (!isSyncConfigured()) return showToast('Connect your ReconNotes server in Settings to get meeting notes written for you.')
  showToast('Writing the meeting notes – they’ll appear at the end of the note (see Jobs)')
  try {
    // Apple's speech recognition on this device, when it can; otherwise the server transcribes
    let transcript = ''
    let words: unknown = null
    if (useDeviceSpeech() && deviceCanDecode(blob.type)) ({ text: transcript, words } = await transcribeOnDevice(blob).catch(() => ({ text: '', words: null })))
    await flushUploads()
    await flushNote(noteId)
    await submitJob({ kind: 'meeting', noteId, input: { attachmentId, transcript, ...(words ? { words } : {}), tzOffset: new Date().getTimezoneOffset() } })
  } catch (e) {
    showToast(`Couldn’t write the meeting notes: ${(e as Error).message}`)
  }
}

/**
 * Meeting notes from a recording already in a note (its ⋯ menu): the server reads it (Whisper),
 * or uses the transcript it already has.
 */
export async function meetingNotesFor(noteId: string, attachmentId: string) {
  if (!isSyncConfigured()) return showToast('Connect your ReconNotes server in Settings to get meeting notes written for you.')
  await flushUploads()
  await flushNote(noteId)
  await submitJob({ kind: 'meeting', noteId, input: { attachmentId, tzOffset: new Date().getTimezoneOffset() } })
  showToast('Writing the meeting notes – they’ll appear at the end of the note (see Jobs)')
}
