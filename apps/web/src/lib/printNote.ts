import type { Editor, JSONContent } from '@tiptap/core'
import type * as Y from 'yjs'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { getDrawingHeight, getNotes, getStrokes, getTranscripts, readNote, strokeOpacity, strokePath, unionBounds, DRAWING_WIDTH } from '@reconnotes/core'
import { attachmentBlob } from './attachments'
import { workspaceDoc } from './workspace'

/**
 * Print / PDF
 * ===========
 *
 * Builds a clean, self-contained HTML page of a note – text, checklists,
 * drawings (as vector graphics), pictures (with any ink drawn on them),
 * recordings with their transcripts – and prints it. On the web that's the
 * browser's print dialog (which offers "Save as PDF"); in the iOS app a
 * small native plugin turns it into a paginated PDF and opens the share
 * sheet (Files, Mail, Print, AirDrop…).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inkSvg(doc: Y.Doc, drawingId: string, opts: { overlay?: { aspect: number } } = {}): string {
  const strokes = getStrokes(doc, drawingId).toArray()
  if (!strokes.length) return ''
  const b = unionBounds(strokes)!
  const height = opts.overlay ? DRAWING_WIDTH * opts.overlay.aspect : Math.min(getDrawingHeight(doc, drawingId), b.y + b.h + 24)
  const paths = [...strokes.filter((s) => s.tool === 'highlighter'), ...strokes.filter((s) => s.tool !== 'highlighter')]
    .map((s) => {
      const d = strokePath(s)
      const op = strokeOpacity(s)
      return d ? `<path d="${d}" fill="${esc(s.color)}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>` : ''
    })
    .join('')
  const cls = opts.overlay ? 'ink-overlay' : 'drawing'
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DRAWING_WIDTH} ${Math.max(40, Math.round(height))}" preserveAspectRatio="xMinYMin meet">${paths}</svg>`
}

async function dataUrl(id: string): Promise<{ url: string; aspect: number } | null> {
  const blob = await attachmentBlob(id)
  if (!blob) return null
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
  const aspect = await new Promise<number>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1)
    img.onerror = () => resolve(1)
    img.src = url
  })
  return { url, aspect }
}

async function render(nodes: JSONContent[] | undefined, doc: Y.Doc): Promise<string> {
  let out = ''
  for (const n of nodes ?? []) out += await node(n, doc)
  return out
}

function marks(text: string, ms: JSONContent['marks']): string {
  let t = esc(text)
  for (const m of ms ?? []) {
    if (m.type === 'bold') t = `<strong>${t}</strong>`
    else if (m.type === 'italic') t = `<em>${t}</em>`
    else if (m.type === 'underline') t = `<u>${t}</u>`
    else if (m.type === 'strike') t = `<s>${t}</s>`
    else if (m.type === 'code') t = `<code>${t}</code>`
    else if (m.type === 'link' && m.attrs?.href) t = `<a href="${esc(String(m.attrs.href))}">${t}</a>`
  }
  return t
}

async function node(n: JSONContent, doc: Y.Doc): Promise<string> {
  const inner = () => render(n.content, doc)
  const transcripts = getTranscripts(doc)
  switch (n.type) {
    case 'text':
      return marks(n.text ?? '', n.marks)
    case 'hardBreak':
      return '<br>'
    case 'paragraph':
      return `<p>${(await inner()) || '&nbsp;'}</p>`
    case 'heading':
      return `<h${n.attrs?.level ?? 1}>${await inner()}</h${n.attrs?.level ?? 1}>`
    case 'bulletList':
      return `<ul>${await inner()}</ul>`
    case 'orderedList':
      return `<ol start="${n.attrs?.start ?? 1}">${await inner()}</ol>`
    case 'listItem':
      return `<li>${await inner()}</li>`
    case 'taskList':
      return `<ul class="tasks">${await inner()}</ul>`
    case 'taskItem':
      return `<li class="${n.attrs?.checked ? 'done' : ''}"><span class="box">${n.attrs?.checked ? '☑' : '☐'}</span><div>${await inner()}</div></li>`
    case 'blockquote':
      return `<blockquote>${await inner()}</blockquote>`
    case 'codeBlock':
      return `<pre><code>${esc((n.content ?? []).map((c) => c.text ?? '').join(''))}</code></pre>`
    case 'horizontalRule':
      return '<hr>'
    case 'video': {
      // paper can't play it: its address
      const src = String(n.attrs?.src ?? '')
      if (!/^https?:\/\//.test(src)) return ''
      return `<p>▶ ${esc(String(n.attrs?.title || 'Video'))}: <a href="${esc(src)}">${esc(src)}</a></p>`
    }
    case 'table':
      return `<table>${await inner()}</table>`
    case 'tableRow':
      return `<tr>${await inner()}</tr>`
    case 'tableHeader':
      return `<th>${await inner()}</th>`
    case 'tableCell':
      return `<td>${await inner()}</td>`
    case 'drawing': {
      const svg = inkSvg(doc, n.attrs?.drawingId)
      return svg ? `<figure class="drawing">${svg}</figure>` : ''
    }
    case 'image': {
      const img = await dataUrl(n.attrs?.attachmentId)
      if (!img) return '<p class="muted">[picture not downloaded to this device]</p>'
      // resized in the note: same share of the page width; otherwise its natural size (at most the page)
      const sized = n.attrs?.width ? `class="image" style="width:${n.attrs.width}%"` : 'class="image natural"'
      const ink = n.attrs?.drawingId ? inkSvg(doc, n.attrs.drawingId, { overlay: { aspect: img.aspect } }) : ''
      return `<figure ${sized}><img src="${img.url}" alt="${esc(n.attrs?.alt ?? '')}">${ink}</figure>`
    }
    case 'audio': {
      const t = transcripts.get(`att:${n.attrs?.attachmentId}`)
      return `<div class="attachment">🎙️ ${esc(n.attrs?.name || 'Recording')}${t ? `<blockquote>${esc(t)}</blockquote>` : ''}</div>`
    }
    case 'file':
      return `<div class="attachment">📎 ${esc(n.attrs?.name || 'File')}</div>`
    case 'noteLink': {
      const meta = getNotes(workspaceDoc).get(n.attrs?.noteId)
      return `<span class="link">↗ ${esc((meta && readNote(meta).title) || n.attrs?.title || 'note')}</span>`
    }
    default:
      return await inner()
  }
}

const STYLE = `
@page { margin: 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 12pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; }
.meta { color: #777; font-size: 9pt; margin-bottom: 14pt; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
th, td { border: 1px solid #bbb; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #f1f1f1; }
th p, td p { margin: 0; }
h1 { font-size: 20pt; margin: 0 0 6pt; } h2 { font-size: 16pt; margin: 14pt 0 4pt; } h3 { font-size: 13pt; margin: 12pt 0 4pt; }
p { margin: 0 0 6pt; }
ul, ol { margin: 0 0 6pt; padding-left: 18pt; }
ul.tasks { list-style: none; padding-left: 2pt; }
ul.tasks li { display: flex; gap: 6pt; }
ul.tasks li .box { font-size: 13pt; line-height: 1.2; }
ul.tasks li.done div { color: #888; text-decoration: line-through; }
ul.tasks li div p { margin: 0; }
blockquote { margin: 4pt 0 8pt; padding-left: 10pt; border-left: 3px solid #ddd; color: #444; }
pre { background: #f5f5f5; padding: 8pt; border-radius: 4pt; white-space: pre-wrap; }
figure { margin: 6pt 0 10pt; break-inside: avoid; }
figure.drawing svg { width: 100%; height: auto; display: block; }
figure.image { position: relative; max-width: 100%; }
figure.image img { width: 100%; display: block; border-radius: 4pt; }
figure.image.natural { width: fit-content; }
figure.image.natural img { width: auto; max-width: 100%; }
.title { font-size: 20pt; font-weight: 700; margin: 0 0 8pt; }
figure.image .ink-overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
.attachment { margin: 6pt 0; color: #333; }
.link { color: #8a6200; }
.muted { color: #888; }
a { color: #8a6200; }
`

export async function buildPrintHtml(editor: Editor, doc: Y.Doc, noteId: string): Promise<{ html: string; title: string }> {
  const meta = getNotes(workspaceDoc).get(noteId)
  const note = meta ? readNote(meta) : null
  const title = note?.title || 'Note'
  const content = editor.getJSON().content ?? []
  // the first line is the note's title: print it like one
  const first = content[0]?.type === 'paragraph' ? `<p class="title">${await render(content[0].content, doc)}</p>` : ''
  const body = first + (await render(first ? content.slice(1) : content, doc))
  const when = new Date(note?.updatedAt || Date.now()).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="meta">${esc(when)}</div>${body}</body></html>`
  return { html, title }
}

interface PdfSharePlugin {
  share(options: { html: string; fileName: string }): Promise<{ completed: boolean }>
}
const PdfShare = registerPlugin<PdfSharePlugin>('PdfShare')

/** Print the note (web) or share it as a PDF (iOS app). */
export async function printNote(editor: Editor, doc: Y.Doc, noteId: string) {
  const { html, title } = await buildPrintHtml(editor, doc, noteId)
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PdfShare')) {
    await PdfShare.share({ html, fileName: title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Note' })
    return
  }
  // web: print from a hidden frame holding just the note
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve()
    frame.srcdoc = html
  })
  const w = frame.contentWindow!
  w.focus()
  w.print()
  setTimeout(() => frame.remove(), 60_000)
}
