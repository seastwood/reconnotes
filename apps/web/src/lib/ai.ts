import type { Editor } from '@tiptap/core'
import { generateJSON } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { marked } from 'marked'
import { createNote, getContent, noteDocName } from '@reconnotes/core'
import { apiUrl, authHeaders, isSyncConfigured, settings } from './settings'
import { sync } from './sync'

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
    .replace(/<ul>\s*(<li><input[^>]*type="checkbox"[\s\S]*?)<\/ul>/g, (_m, items: string) => `<ul data-type="taskList">${items}</ul>`)
    .replace(
      /<li><input([^>]*)type="checkbox"([^>]*)>\s*([\s\S]*?)<\/li>/g,
      (_m, a: string, b: string, body: string) =>
        `<li data-type="taskItem" data-checked="${/checked/.test(a + b)}"><p>${body.trim()}</p></li>`,
    )
}

/** Recognise the handwriting in a drawing and insert it as text right below. */
export async function convertHandwriting(editor: Editor, noteId: string, drawingId: string) {
  await flushNote(noteId)
  const { text } = await post<{ text: string; agent: string }>('/api/ai/handwriting', { noteId, drawingId })
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
  editor.chain().focus().insertContentAt(at, markdownToHtml(text)).run()
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
