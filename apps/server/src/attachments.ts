import fs from 'node:fs'
import type { Config } from './config'
import type { Store, AttachmentRow } from './store'
import type { SyncEngine } from './sync'
import { Ai, isAiImage, transcribeAudio } from './ai'
import { log } from './log'

const TEXT_MIMES = /^(text\/|application\/(json|xml|x-markdown))/

/** Decide up front whether an uploaded file will get text extracted. */
export function initialTextStatus(config: Config, ai: Ai, mime: string): AttachmentRow['text_status'] {
  if (TEXT_MIMES.test(mime)) return 'pending'
  if (isAiImage(mime)) return ai.canImages && ai.autoImageText ? 'pending' : 'skipped'
  if (mime === 'application/pdf') return ai.canPdf && ai.autoImageText ? 'pending' : 'skipped'
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return config.transcribeUrl ? 'pending' : 'skipped'
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
    else if (isAiImage(att.mime)) text = await ai.imageText(data, att.mime)
    else if (att.mime === 'application/pdf') text = await ai.pdfText(data)
    else text = await transcribeAudio(config, data, att.mime, att.name)
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
  void sync.enqueue(() => processAttachment(config, store, ai, sync, att))
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
    const status = initialTextStatus(config, ai, att.mime)
    if (status !== 'pending') continue
    store.setAttachmentText(att.id, null, 'pending')
    queueAttachment(config, store, ai, sync, att.id)
  }
}
