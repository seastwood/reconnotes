import * as Y from 'yjs'
import { createNote, getContent, noteDocName } from '@reconnotes/core'
import { flushNote } from './ai'
import { flushUploads } from './attachments'
import { quickAction } from './appLinks'
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
  // the note's recorder starts as soon as it's open
  quickAction.set({ noteId: id, action: 'meeting' })
  return id
}

/** The meeting's recording is in the note: write the meeting notes (a job). */
export async function writeMeetingNotes(noteId: string, attachmentId: string, blob: Blob) {
  if (!isSyncConfigured()) return showToast('Connect your ReconNotes server in Settings to get meeting notes written for you.')
  showToast('Writing the meeting notes – they’ll appear at the end of the note (see Jobs)')
  try {
    // Apple's speech recognition on this device, when it can; otherwise the server transcribes
    let transcript = ''
    if (useDeviceSpeech() && deviceCanDecode(blob.type)) transcript = await transcribeOnDevice(blob).catch(() => '')
    await flushUploads()
    await flushNote(noteId)
    await submitJob({ kind: 'meeting', noteId, input: { attachmentId, transcript, tzOffset: new Date().getTimezoneOffset() } })
  } catch (e) {
    showToast(`Couldn’t write the meeting notes: ${(e as Error).message}`)
  }
}
