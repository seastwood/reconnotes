import fs from 'node:fs'
import { encodeWordTimes } from '@reconnotes/core'
import type { Config } from './config'
import type { Store, AttachmentRow } from './store'
import type { SyncEngine } from './sync'
import { Ai, isAiImage } from './ai'
import { log } from './log'
import { isOfficeFile, officeText } from './office'

const TEXT_MIMES = /^(text\/|application\/(json|xml|x-markdown))/

/** Decide up front whether an uploaded file will get text extracted. */
export function initialTextStatus(config: Config, ai: Ai, mime: string, name = ''): AttachmentRow['text_status'] {
  if (TEXT_MIMES.test(mime) || isOfficeFile(mime, name)) return 'pending'
  if (isAiImage(mime)) return ai.canImages && ai.autoImageText ? 'pending' : 'skipped'
  if (mime === 'application/pdf') return ai.canPdf && ai.autoImageText ? 'pending' : 'skipped'
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return ai.autoAudio ? 'pending' : 'skipped'
  return 'skipped'
}

/**
 * Extract searchable text from an attachment: OCR + description for images
 * (screenshots, photos, charts), text for PDFs, a transcript for audio.
 */
export async function processAttachment(config: Config, store: Store, ai: Ai, sync: SyncEngine, att: AttachmentRow) {
  const data = fs.readFileSync(store.blobPath(att.id))
  let text: string
  try {
    if (TEXT_MIMES.test(att.mime)) text = data.toString('utf8').slice(0, 200_000)
    else if (isOfficeFile(att.mime, att.name)) text = officeText(data, att.name)
    else if (isAiImage(att.mime)) text = await ai.imageText(data, att.mime)
    else if (att.mime === 'application/pdf') text = await ai.pdfText(data)
    else {
      const r = await ai.transcribeAudio(data, att.mime, att.name)
      text = r.text
      setTranscribedBy(store, att.id, r.agent)
      setWordTimes(store, att.id, r.words)
    }
  } catch (err) {
    log.error(`text extraction failed for ${att.id} (${att.mime})`, err)
    store.setAttachmentText(att.id, null, 'error')
    return
  }
  store.setAttachmentText(att.id, text, 'done')
  log.info(`extracted ${text.length} chars from ${att.id} (${att.mime})`)
  sync.reindexNotesFor(att.id)
}

export function queueAttachment(config: Config, store: Store, ai: Ai, sync: SyncEngine, id: string) {
  const att = store.getAttachment(id)
  if (!att || att.text_status !== 'pending') return
  sync.jobs.submit({ kind: 'extract-text', title: att.name || 'File', input: { attachmentId: id }, origin: 'auto', dedupeKey: `extract:${id}` })
}

/** Resume work interrupted by a restart. */
export function resumePendingAttachments(config: Config, store: Store, ai: Ai, sync: SyncEngine) {
  for (const att of store.pendingAttachments()) queueAttachment(config, store, ai, sync, att.id)
}

/**
 * After the AI agents change, extract text from images/PDFs that were skipped
 * (no agent yet) or failed (agent was unreachable).
 */
export function retryAttachments(config: Config, store: Store, ai: Ai, sync: SyncEngine) {
  for (const att of store.attachmentsWithStatus(['skipped', 'error'])) {
    const status = initialTextStatus(config, ai, att.mime, att.name)
    if (status !== 'pending') continue
    store.setAttachmentText(att.id, null, 'pending')
    queueAttachment(config, store, ai, sync, att.id)
  }
}

/**
 * Who turned a recording into text – a speech-to-text agent ("faster-whisper-large-v3-turbo"), or
 * Apple's recognition on the phone: kept, and shown with the transcript, so it's clear which reading
 * it is (and a better one can replace the phone's).
 */
export function transcribedBy(store: Store, attachmentId: string): string | null {
  return store.getSetting<Record<string, string>>('transcribedBy')?.[attachmentId] ?? null
}

export function setTranscribedBy(store: Store, attachmentId: string, by: string) {
  store.setSetting('transcribedBy', { ...(store.getSetting<Record<string, string>>('transcribedBy') ?? {}), [attachmentId]: by })
}

/** Apple's on-device reading (made for dictation): a server's speech-to-text should replace it. */
export const APPLE_SPEECH = 'Apple speech recognition (on the phone)'

/** Transcripts-map key (in the note) of a recording's word times: JSON, see `setWordTimes`. */
export const timingKey = (attachmentId: string) => `timing:att:${attachmentId}`

/**
 * When each word of a recording's transcript is said – kept with it (and copied into the note) so the
 * transcript can follow along as it plays. Compact: [word, start, end] in hundredths of a second.
 * None (a reading without times, e.g. Apple's): cleared, so old times don't stay with new words.
 */
export function setWordTimes(store: Store, attachmentId: string, words?: { word: string; start: number; end: number }[] | null) {
  store.setSetting(`wordTimes:${attachmentId}`, encodeWordTimes(words))
}

/** Word times sent by the phone (Apple's recognition gives them too): checked, since they come from outside. */
export function sentWordTimes(input: unknown): { word: string; start: number; end: number }[] | null {
  if (!Array.isArray(input)) return null
  return input
    .slice(0, 50_000)
    .filter((w): w is { word: string; start: number; end: number } => Boolean(w) && typeof w.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
    .map((w) => ({ word: w.word.slice(0, 80), start: w.start, end: w.end }))
}

export function wordTimes(store: Store, attachmentId: string): string | null {
  return store.getSetting<string | null>(`wordTimes:${attachmentId}`) ?? null
}
