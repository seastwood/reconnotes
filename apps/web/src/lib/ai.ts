import type { Editor } from '@tiptap/core'
import { generateJSON } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { marked } from 'marked'
import { createNote, getContent, getStrokes, getTranscripts, inkHash, noteDocName, transcriptSourceKey } from '@reconnotes/core'
import { recognizeDrawingOnDevice, recognizeImageOnDevice, renderStrokesForRecognition, useDeviceOcr } from './deviceOcr'
import { apiUrl, authHeaders, isSyncConfigured, settings } from './settings'
import { sync } from './sync'
import { attachmentBlob, flushUploads } from './attachments'
import { deviceCanDecode, speechToParagraphs, transcribeOnDevice, useDeviceSpeech } from './speech'

/**
 * AI features run on the self-hosted server (which talks to Claude and/or a
 * local Ollama model), so they need a connection; everything else works
 * offline.
 */

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!isSyncConfigured()) throw new Error('Connect a ReconNotes server in Settings to use AI features.')
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Server error ${res.status}`)
  return json as T
}

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
function insertConverted(editor: Editor, at: number, markdown: string) {
  try {
    editor.chain().focus().insertContentAt(at, markdownToHtml(markdown), { errorOnInvalidContent: true }).run()
  } catch {
    const paragraphs = markdown
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }))
    editor.chain().focus().insertContentAt(at, paragraphs).run()
  }
}

/** Recognise the handwriting in a drawing and insert it as text right below. */
export async function convertHandwriting(editor: Editor, noteId: string, drawingId: string) {
  let text = useDeviceOcr() ? await recognizeDrawingLocally(noteId, drawingId) : ''
  if (!text) {
    // web app, Apple recognition switched off, or it found nothing: use the server's agents
    if (useDeviceOcr() && !isSyncConfigured()) throw new Error('No handwriting was recognised in this drawing.')
    await flushNote(noteId)
    text = (await post<{ text: string; agent: string }>('/api/ai/handwriting', { noteId, drawingId })).text
  }
  if (!text.trim()) throw new Error('The AI returned no text for this drawing.')
  let at: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'drawing' && node.attrs.drawingId === drawingId) {
      at = pos + node.nodeSize
      return false
    }
    return at === null
  })
  if (at === null) throw new Error('Drawing no longer exists')
  insertConverted(editor, at, text)
}

/**
 * Convert every drawing in the note, top to bottom; each drawing's text is
 * inserted right below it. Returns how many drawings were converted and any
 * errors.
 */
export async function convertAllHandwriting(editor: Editor, noteId: string): Promise<{ converted: number; errors: string[] }> {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'drawing' && node.attrs.drawingId) ids.push(node.attrs.drawingId)
  })
  let converted = 0
  const errors: string[] = []
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
    const r = await post<{ text: string }>('/api/ai/tidy', { text, image: imageBase64 ?? undefined, mime })
    return r.text?.trim() || text
  } catch {
    return text
  }
}

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
 * Read the text (handwritten or printed) in a picture and insert it right
 * after the picture.
 */
export async function convertImage(editor: Editor, attachmentId: string, insertAt: () => number | undefined) {
  const blob = await attachmentBlob(attachmentId)
  if (!blob) throw new Error('This picture hasn’t been downloaded to this device yet.')
  const image = await prepareImage(blob)
  if (useDeviceOcr()) {
    // Apple's recognizer on the device (iOS app)
    let text = (await recognizeImageOnDevice(image)).trim()
    if (text) {
      if (settings.get().deviceOcrCleanup && isSyncConfigured()) {
        const b64 = await new Promise<string>((resolve) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
          r.readAsDataURL(image)
        })
        text = await tidyOnServer(text, b64, image.type || 'image/jpeg')
      }
      const at = insertAt()
      if (at === undefined) throw new Error('The picture no longer exists')
      insertConverted(editor, at, text)
      return
    }
    if (!isSyncConfigured()) throw new Error('No text was recognised in this picture.')
  }
  if (!isSyncConfigured()) throw new Error('Connect a ReconNotes server in Settings to use AI features.')
  const res = await fetch(apiUrl('/api/ai/image-to-text'), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': image.type || 'image/jpeg' },
    body: image,
  })
  const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
  if (!res.ok) throw new Error(json.error ?? `Server error ${res.status}`)
  if (!json.text?.trim()) throw new Error('The AI returned no text for this picture.')
  const at = insertAt()
  if (at === undefined) throw new Error('The picture no longer exists')
  insertConverted(editor, at, json.text)
}

/**
 * Transcribe a recording or audio file and insert the text right below it.
 * In the iOS app Apple's speech recognizer runs on the device first; the
 * server's "Audio to text" agents (e.g. a Whisper server) are the fallback
 * and the only option in the web app. Returns the transcript (also kept with
 * the recording for search).
 */
export async function transcribeAudio(editor: Editor, attachmentId: string, insertAt: () => number | undefined): Promise<string> {
  let text = ''
  let deviceError: Error | null = null
  if (useDeviceSpeech()) {
    const blob = await attachmentBlob(attachmentId)
    if (blob && deviceCanDecode(blob.type)) {
      try {
        text = await transcribeOnDevice(blob)
      } catch (e) {
        deviceError = e as Error
      }
    }
  }
  if (!text) {
    if (!isSyncConfigured()) {
      if (deviceError) throw deviceError
      throw new Error(useDeviceSpeech() ? 'No speech was recognised in this recording.' : 'Connect a ReconNotes server in Settings to transcribe audio.')
    }
    await flushUploads()
    text = (await post<{ text: string }>('/api/ai/audio-to-text', { attachmentId })).text ?? ''
  }
  if (!text.trim()) throw new Error('No speech was recognised in this recording.')
  const at = insertAt()
  if (at === undefined) throw new Error('The recording no longer exists')
  insertConverted(editor, at, speechToParagraphs(text))
  return text
}

/**
 * Turn a whole note (typed text + handwriting) into a clean document, saved
 * as a new note next to the original. Returns the new note's id.
 */
export async function compileNote(editor: Editor, noteId: string, folderId: string | null): Promise<string> {
  await flushNote(noteId)
  const { markdown, title } = await post<{ markdown: string; title: string }>('/api/ai/compile', { noteId })
  const json = generateJSON(markdownToHtml(markdown), editor.extensionManager.extensions)
  const id = createNote(sync.workspace.doc, { folderId, title: `${title || 'Untitled'} (compiled)` })
  const { handle, close } = sync.open(noteDocName(id))
  await handle.loaded
  prosemirrorJSONToYXmlFragment(editor.schema, json, getContent(handle.doc))
  close()
  return id
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
 * Summarise a note (inserted under its title) or pull out its to-dos (added
 * at the end as a checklist). Both are ordinary edits, so Undo removes them.
 */
export async function noteAction(editor: Editor, noteId: string, action: 'summary' | 'todos') {
  await flushNote(noteId)
  const { text } = await post<{ text: string }>('/api/ai/note-action', { action, noteId })
  if (!text.trim()) throw new Error(action === 'todos' ? 'No to-dos found in this note.' : 'The AI returned nothing.')
  const doc = editor.state.doc
  if (action === 'summary') {
    const at = doc.childCount > 1 ? doc.child(0).nodeSize : doc.content.size
    insertConverted(editor, at, `**Summary**\n\n${text}\n`)
  } else {
    insertConverted(editor, doc.content.size, `**To-dos**\n\n${text.replace(/^\s*[-*]\s+(?!\[)/gm, '- [ ] ')}\n`)
  }
}

/** Improve the wording of the selected text (replaces it; Undo restores it). */
export async function cleanUpSelection(editor: Editor) {
  const { from, to, empty } = editor.state.selection
  if (empty) throw new Error('Select the text you want cleaned up, then choose “Clean up wording” again.')
  const markdown = sliceToMarkdown(editor, from, to)
  if (!markdown.trim()) throw new Error('The selection has no text to clean up.')
  const { text } = await post<{ text: string }>('/api/ai/note-action', { action: 'clean', text: markdown })
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
