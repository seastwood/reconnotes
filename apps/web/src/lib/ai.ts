import type { Editor } from '@tiptap/core'
import { generateJSON } from '@tiptap/core'
import { marked } from 'marked'
import * as Y from 'yjs'
import { getNotes, readNote, getStrokes, getTranscripts, inkHash, noteDocName, transcriptSourceKey } from '@reconnotes/core'
import { recognizeDrawingOnDevice, recognizeImageOnDevice, renderStrokesForRecognition, useDeviceOcr } from './deviceOcr'
import { apiUrl, authHeaders, isSyncConfigured, settings } from './settings'
import { sync } from './sync'
import { attachmentBlob, flushUploads } from './attachments'
import { localJobId, recordJob, runJob, submitJob, waitJob } from './jobs'
import { deviceCanDecode, speechToParagraphs, transcribeOnDevice, useDeviceSpeech } from './speech'

/**
 * AI features run on the self-hosted server (which talks to Claude and/or a
 * local Ollama model), so they need a connection; everything else works
 * offline.
 */

/** Make sure the server has our latest edits to this note before asking about it. */
async function flushNote(noteId: string) {
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    const start = Date.now()
    while (!handle.synced) {
      if (Date.now() - start > 10_000) throw new Error('Not connected to your server – try again when online.')
      await new Promise((r) => setTimeout(r, 150))
    }
    // give the server's debounced save a moment
    await new Promise((r) => setTimeout(r, 300))
  } finally {
    close()
  }
}

export function markdownToHtml(md: string): string {
  // Task list syntax -> TipTap task list markup
  const html = marked.parse(md, { async: false, gfm: true }) as string
  return html
    // empty list items (a lone "-") are invalid in the editor: drop them, then any list left empty
    .replace(/<li>\s*(<p>\s*<\/p>)?\s*<\/li>/g, '')
    .replace(/<(ul|ol)>\s*<\/\1>/g, '')
    .replace(/<ul>\s*(<li><input[^>]*type="checkbox"[\s\S]*?)<\/ul>/g, (_m, items: string) => `<ul data-type="taskList">${items}</ul>`)
    .replace(
      /<li><input([^>]*)type="checkbox"([^>]*)>\s*([\s\S]*?)<\/li>/g,
      (_m, a: string, b: string, body: string) =>
        `<li data-type="taskItem" data-checked="${/checked/.test(a + b)}"><p>${body.trim()}</p></li>`,
    )
}

/**
 * Insert converted text. If the formatted version is rejected by the editor
 * (odd Markdown from a model), fall back to plain paragraphs rather than
 * losing the result.
 */
function insertConverted(editor: Editor, at: number, markdown: string, jobId?: string) {
  const tag = (nodes: NodeJSON[]) => (jobId ? nodes.map((n) => ({ ...n, attrs: { ...(n.attrs ?? {}), job: jobId } })) : nodes)
  try {
    const json = generateJSON(markdownToHtml(markdown), editor.extensionManager.extensions) as NodeJSON
    editor.chain().focus().insertContentAt(at, tag(json.content ?? []), { errorOnInvalidContent: true }).run()
  } catch {
    const paragraphs = markdown
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }))
    editor.chain().focus().insertContentAt(at, tag(paragraphs)).run()
  }
}

type NodeJSON = { type: string; attrs?: Record<string, unknown>; content?: NodeJSON[]; text?: string; marks?: unknown[] }

const noteTitle = (noteId: string) => readNote(getNotes(sync.workspace.doc).get(noteId) ?? new Y.Map()).title || 'Untitled'
const APPLE_TEXT = 'Apple text recognition (on this device)'

/**
 * Recognise the handwriting in a drawing and put the text right below it.
 * Apple's recognizer runs here on the device (iOS); otherwise it's a job on
 * the server, which writes the text into the note itself – so it finishes
 * even if you leave the note. Either way it shows in the Jobs list.
 */
export async function convertHandwriting(editor: Editor, noteId: string, drawingId: string) {
  const startedAt = Date.now()
  const text = useDeviceOcr() ? await recognizeDrawingLocally(noteId, drawingId) : ''
  if (text) {
    let at: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'drawing' && node.attrs.drawingId === drawingId) {
        at = pos + node.nodeSize
        return false
      }
      return at === null
    })
    if (at === null) throw new Error('Drawing no longer exists')
    const id = localJobId()
    insertConverted(editor, at, text, id)
    recordJob({ id, kind: 'convert-drawing', title: noteTitle(noteId), noteId, input: { drawingId }, result: { noteId, text: text.slice(0, 1500) }, agent: APPLE_TEXT, startedAt })
    return
  }
  // web app, Apple recognition switched off, or it found nothing: the server's agents
  if (useDeviceOcr() && !isSyncConfigured()) throw new Error('No handwriting was recognised in this drawing.')
  await flushNote(noteId)
  await runJob({ kind: 'convert-drawing', noteId, input: { drawingId } })
}

/**
 * Convert every drawing in the note, top to bottom; each drawing's text goes
 * right below it. Server jobs are all queued at once. Returns how many
 * drawings were converted and any errors.
 */
export async function convertAllHandwriting(editor: Editor, noteId: string): Promise<{ converted: number; errors: string[] }> {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'drawing' && node.attrs.drawingId) ids.push(node.attrs.drawingId)
  })
  let converted = 0
  const errors: string[] = []
  if (!useDeviceOcr() && isSyncConfigured()) {
    await flushNote(noteId)
    const jobs = await Promise.all(ids.map((drawingId) => submitJob({ kind: 'convert-drawing', noteId, input: { drawingId } })))
    for (const r of await Promise.allSettled(jobs.map((j) => waitJob(j.id)))) {
      if (r.status === 'fulfilled') converted++
      else errors.push((r.reason as Error).message)
    }
    return { converted, errors }
  }
  for (const id of ids) {
    try {
      await convertHandwriting(editor, noteId, id)
      converted++
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  return { converted, errors }
}

/**
 * Recognise a drawing with Apple's on-device recognizer (iOS app). The
 * result is also stored as the drawing's transcript (synced, searchable) and
 * marked so the server doesn't redo it. Returns '' if nothing was found.
 */
export async function recognizeDrawingLocally(noteId: string, drawingId: string, opts: { cleanup?: boolean } = {}): Promise<string> {
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    await handle.loaded
    const strokes = getStrokes(handle.doc, drawingId).toArray()
    let text = (await recognizeDrawingOnDevice(strokes)).trim()
    if (!text) return ''
    if ((opts.cleanup ?? true) && settings.get().deviceOcrCleanup && isSyncConfigured()) {
      text = await tidyOnServer(text, renderStrokesForRecognition(strokes), 'image/png')
    }
    handle.doc.transact(() => {
      const tr = getTranscripts(handle.doc)
      tr.set(drawingId, text)
      tr.set(transcriptSourceKey(drawingId), `device:${inkHash(strokes)}`)
    })
    return text
  } finally {
    close()
  }
}

/** Optional polish by the server's "Clean up converted text" agents; never fails. */
async function tidyOnServer(text: string, imageBase64: string | null, mime: string): Promise<string> {
  try {
    const job = await runJob({ kind: 'tidy', title: text.slice(0, 60), input: { text, mime }, file: imageBase64 ?? undefined })
    return String(job.result?.text ?? '').trim() || text
  } catch {
    return text
  }
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.readAsDataURL(blob)
  })

/**
 * Shrink a photo so its longest side is at most `max` pixels and re-encode
 * it as JPEG (transparent areas become white). Handwriting stays perfectly
 * legible at this size, and uploads/recognition are much faster.
 */
async function prepareImage(blob: Blob, max = 2048): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    if (/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) return blob // can't decode here; let the server try
    throw new Error('This image format can’t be converted. Try a PNG or JPEG.')
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && blob.type === 'image/jpeg' && blob.size < 4_000_000) return blob
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the image'))), 'image/jpeg', 0.9),
  )
}

/**
 * Read the text (handwritten or printed) in a picture and put it right after
 * the picture (Apple's recognizer here, or a job on the server).
 */
export async function convertImage(editor: Editor, noteId: string, attachmentId: string, insertAt: () => number | undefined) {
  const startedAt = Date.now()
  const blob = await attachmentBlob(attachmentId)
  if (!blob) throw new Error('This picture hasn’t been downloaded to this device yet.')
  const image = await prepareImage(blob)
  if (useDeviceOcr()) {
    // Apple's recognizer on the device (iOS app)
    let text = (await recognizeImageOnDevice(image)).trim()
    if (text) {
      if (settings.get().deviceOcrCleanup && isSyncConfigured()) text = await tidyOnServer(text, await toBase64(image), image.type || 'image/jpeg')
      const at = insertAt()
      if (at === undefined) throw new Error('The picture no longer exists')
      const id = localJobId()
      insertConverted(editor, at, text, id)
      recordJob({ id, kind: 'convert-picture', title: noteTitle(noteId), noteId, input: { attachmentId }, result: { noteId, text: text.slice(0, 1500) }, agent: APPLE_TEXT, startedAt })
      return
    }
    if (!isSyncConfigured()) throw new Error('No text was recognised in this picture.')
  }
  if (!isSyncConfigured()) throw new Error('Connect a ReconNotes server in Settings to use AI features.')
  // the downscaled picture goes with the job, so it works before the upload finishes
  await flushNote(noteId)
  await runJob({ kind: 'convert-picture', noteId, input: { attachmentId, mime: image.type || 'image/jpeg' }, file: await toBase64(image) })
}

/**
 * Transcribe a recording or audio file and insert the text right below it.
 * In the iOS app Apple's speech recognizer runs on the device first; the
 * server's "Audio to text" agents (e.g. a Whisper server) are the fallback
 * and the only option in the web app. Returns the transcript (also kept with
 * the recording for search).
 */
export async function transcribeAudio(
  editor: Editor,
  noteId: string,
  attachmentId: string,
  insertAt: () => number | undefined,
  /** a transcript the server already made (Whisper): usually the best one */
  existing?: string | null,
): Promise<string> {
  const startedAt = Date.now()
  let text = ''
  let deviceError: Error | null = null
  // the server's transcript is used by its job; otherwise Apple's recognizer here first
  if (!(existing?.trim() && isSyncConfigured()) && useDeviceSpeech()) {
    const blob = await attachmentBlob(attachmentId)
    if (blob && deviceCanDecode(blob.type)) {
      try {
        text = await transcribeOnDevice(blob)
      } catch (e) {
        deviceError = e as Error
      }
    }
  }
  if (text.trim()) {
    const at = insertAt()
    if (at === undefined) throw new Error('The recording no longer exists')
    const id = localJobId()
    insertConverted(editor, at, speechToParagraphs(text), id)
    recordJob({ id, kind: 'transcribe', title: noteTitle(noteId), noteId, input: { attachmentId }, result: { noteId, text: text.slice(0, 1500) }, agent: 'Apple speech recognition (on this device)', startedAt })
    return text
  }
  if (!isSyncConfigured()) {
    if (deviceError) throw deviceError
    throw new Error(useDeviceSpeech() ? 'No speech was recognised in this recording.' : 'Connect a ReconNotes server in Settings to transcribe audio.')
  }
  await flushUploads()
  await flushNote(noteId)
  const job = await runJob({ kind: 'transcribe', noteId, input: { attachmentId } })
  return String(job.result?.text ?? '')
}

/**
 * Turn a whole note (typed text + handwriting) into a clean document, saved
 * as a new note next to the original (a job on the server). Returns the new
 * note's id.
 */
export async function compileNote(_editor: Editor, noteId: string): Promise<string> {
  await flushNote(noteId)
  const job = await runJob({ kind: 'compile', noteId })
  return job.result!.noteId as string
}

/** URL of the exact image the server sends to the AI for a drawing (for troubleshooting). */
export function drawingImageUrl(noteId: string, drawingId: string): string {
  const t = encodeURIComponent(settings.get().token)
  return apiUrl(`/api/ai/drawing-image?noteId=${noteId}&drawingId=${drawingId}&token=${t}`)
}

export interface ServerInfo {
  ok: boolean
  version: string
  ai: { handwriting: boolean; images: boolean; pdf: boolean; compile: boolean }
  autoHandwriting: boolean
  transcription: boolean
}

export async function serverInfo(url: string, token: string): Promise<ServerInfo & { authorized: boolean }> {
  const base = url.replace(/\/$/, '')
  const info = (await fetch(`${base}/api/health`).then((r) => r.json())) as ServerInfo
  const auth = await fetch(`${base}/api/auth/check`, { headers: { Authorization: `Bearer ${token}` } })
  return { ...info, authorized: auth.ok }
}

// --- One-tap note actions --------------------------------------------------

/**
 * Summarise a note (put under its title) or pull out its to-dos (added at
 * the end as a checklist) – a job on the server, which writes the result
 * into the note.
 */
export async function noteAction(_editor: Editor, noteId: string, action: 'summary' | 'todos') {
  await flushNote(noteId)
  await runJob({ kind: action, noteId })
}

/** Improve the wording of the selected text (replaces it; Undo restores it). */
export async function cleanUpSelection(editor: Editor, noteId?: string) {
  const { from, to, empty } = editor.state.selection
  if (empty) throw new Error('Select the text you want cleaned up, then choose “Clean up wording” again.')
  const markdown = sliceToMarkdown(editor, from, to)
  if (!markdown.trim()) throw new Error('The selection has no text to clean up.')
  const job = await runJob({ kind: 'clean', title: markdown.slice(0, 60), noteId: noteId ?? null, input: { text: markdown } })
  const text = String(job.result?.text ?? '')
  if (!text.trim()) throw new Error('The AI returned nothing.')
  editor.chain().focus().insertContentAt({ from, to }, markdownToHtml(text)).run()
}

/** The selected part of the note as simple Markdown (text, lists, checkboxes, headings). */
function sliceToMarkdown(editor: Editor, from: number, to: number): string {
  const lines: string[] = []
  const inline = (node: import('@tiptap/pm/model').Node) => {
    let s = ''
    node.forEach((child) => {
      if (child.isText) {
        let t = child.text ?? ''
        if (child.marks.some((m) => m.type.name === 'bold')) t = `**${t}**`
        if (child.marks.some((m) => m.type.name === 'italic')) t = `*${t}*`
        s += t
      } else if (child.type.name === 'hardBreak') s += '\n'
    })
    return s
  }
  const walk = (node: import('@tiptap/pm/model').Node, indent: string, marker?: string) => {
    const name = node.type.name
    if (node.isText) lines.push(indent + (node.text ?? ''))
    else if (name === 'paragraph') lines.push(indent + (marker ?? '') + inline(node))
    else if (name === 'heading') lines.push('#'.repeat(node.attrs.level ?? 1) + ' ' + inline(node))
    else if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') {
      let n = 1
      node.forEach((item) => {
        const m = name === 'orderedList' ? `${n++}. ` : name === 'taskList' ? (item.attrs.checked ? '- [x] ' : '- [ ] ') : '- '
        let first = true
        item.forEach((c) => {
          walk(c, first ? indent : indent + '  ', first ? m : undefined)
          first = false
        })
      })
      lines.push('')
    } else if (node.isTextblock) lines.push(indent + inline(node))
    else node.forEach((c) => walk(c, indent))
  }
  editor.state.doc.slice(from, to).content.forEach((n) => walk(n, ''))
  const md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return md || editor.state.doc.textBetween(from, to, '\n', ' ').trim()
}
