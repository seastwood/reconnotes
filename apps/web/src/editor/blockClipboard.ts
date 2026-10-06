import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'
import { Slice, type Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import * as Y from 'yjs'
import { getDrawingMeta, getStrokes, getTranscripts, newId, transcriptSourceKey, wordsKey, type Stroke } from '@reconnotes/core'
import { blocksToText } from './checklistCopy'
import { showToast } from '../lib/toast'

/**
 * Copying handwriting, pictures, recordings and files
 * ===================================================
 *
 * A drawing's ink lives in its note (beside the text), so a plain copy would
 * paste an empty drawing – or, in the same note, a second view of the same
 * ink. When a copy includes drawings, pictures, recordings or files, the
 * clipboard also gets everything needed to rebuild them: the ink, drawing
 * heights and recognised text. Pasting (in any note, on any device sharing
 * the clipboard) makes independent copies with new drawing ids. Pictures,
 * recordings and files are stored once on the server and simply referenced.
 */

const ATOMS = new Set(['drawing', 'image', 'audio', 'file'])
const MARK = 'data-reconnotes-blocks'

interface InkCopy {
  strokes: Stroke[]
  height?: number
  transcripts: Record<string, string>
}
interface Payload {
  v: 1
  slice: ReturnType<Slice['toJSON']>
  inks: Record<string, InkCopy>
  /** recognised text of pictures and recordings (att:…, words:att:…) */
  texts: Record<string, string>
}

function hasAtoms(slice: Slice): boolean {
  let found = false
  slice.content.descendants((n) => {
    if (ATOMS.has(n.type.name)) found = true
    return !found
  })
  return found
}

/** Everything needed to rebuild the slice in another note. */
function payloadFor(slice: Slice, doc: Y.Doc): Payload {
  const inks: Record<string, InkCopy> = {}
  const texts: Record<string, string> = {}
  const tr = getTranscripts(doc)
  slice.content.descendants((n) => {
    const drawingId = n.attrs?.drawingId as string | undefined
    if (drawingId && !inks[drawingId]) {
      const transcripts: Record<string, string> = {}
      for (const k of [drawingId, transcriptSourceKey(drawingId)]) {
        const v = tr.get(k)
        if (v) transcripts[k] = v
      }
      inks[drawingId] = { strokes: getStrokes(doc, drawingId).toArray(), height: getDrawingMeta(doc).get(drawingId)?.height, transcripts }
    }
    const att = n.attrs?.attachmentId as string | undefined
    if (att) {
      for (const k of [`att:${att}`, wordsKey(att)]) {
        const v = tr.get(k)
        if (v) texts[k] = v
      }
    }
    return true
  })
  // results an AI job wrote stay with that job: a copy is just text
  const json = slice.toJSON() ?? { content: [] }
  const strip = (n: { attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.attrs && 'job' in n.attrs) n.attrs = { ...n.attrs, job: null }
    ;(n.content as (typeof n)[] | undefined)?.forEach(strip)
  }
  ;(json.content as Parameters<typeof strip>[0][] | undefined)?.forEach(strip)
  return { v: 1, slice: json, inks, texts }
}

const encode = (p: Payload) => btoa(unescape(encodeURIComponent(JSON.stringify(p))))
const decode = (s: string): Payload | null => {
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(s)))) as Payload
    return p?.v === 1 ? p : null
  } catch {
    return null
  }
}

/** The clipboard contents: normal HTML and text for other apps, plus the payload for ReconNotes. */
function clipboardContent(view: EditorView, slice: Slice, doc: Y.Doc): { html: string; text: string } {
  const { dom } = view.serializeForClipboard(slice)
  const wrap = document.createElement('div')
  wrap.setAttribute(MARK, encode(payloadFor(slice, doc)))
  wrap.append(...Array.from(dom.childNodes))
  const nodes: PMNode[] = []
  slice.content.forEach((n) => nodes.push(n))
  const text = blocksToText(nodes).join('\n').trim() || slice.content.textBetween(0, slice.content.size, '\n', (n) => (ATOMS.has(n.type.name) ? `[${n.type.name}]` : '')).trim()
  return { html: wrap.outerHTML, text }
}

/** Put HTML + text on the system clipboard from a button (not a copy event). */
async function writeClipboard(html: string, text: string): Promise<boolean> {
  // a copy event we fill ourselves works everywhere, inside the tap
  let done = false
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    e.clipboardData.setData('text/html', html)
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
    e.stopImmediatePropagation()
    done = true
  }
  window.addEventListener('copy', onCopy, { capture: true })
  const ta = document.createElement('textarea')
  ta.value = text || ' '
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  const active = document.activeElement as HTMLElement | null
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* fall back below */
  }
  ta.remove()
  window.removeEventListener('copy', onCopy, { capture: true })
  active?.focus?.({ preventScroll: true })
  if (done) return true
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) }),
    ])
    return true
  } catch {
    return false
  }
}

/** Paste a payload: fresh drawing ids with their ink copied into this note. */
function pastePayload(view: EditorView, p: Payload, doc: Y.Doc): boolean {
  const ids = new Map<string, string>()
  const remap = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.attrs) {
      const d = n.attrs.drawingId as string | undefined
      if (d) {
        if (!ids.has(d)) ids.set(d, newId())
        n.attrs = { ...n.attrs, drawingId: ids.get(d) }
      }
      if (n.type === 'dueDate' && n.attrs.id) n.attrs = { ...n.attrs, id: newId() }
    }
    ;(n.content as (typeof n)[] | undefined)?.forEach(remap)
  }
  const json = JSON.parse(JSON.stringify(p.slice)) as { content?: Parameters<typeof remap>[0][] }
  json.content?.forEach(remap)
  let slice: Slice
  try {
    slice = Slice.fromJSON(view.state.schema, json)
  } catch {
    return false
  }
  doc.transact(() => {
    const tr = getTranscripts(doc)
    for (const [oldId, newDrawing] of ids) {
      const ink = p.inks[oldId]
      if (!ink) continue
      getStrokes(doc, newDrawing).push(ink.strokes.map((s) => ({ ...s, pts: [...s.pts] })))
      if (ink.height) getDrawingMeta(doc).set(newDrawing, { height: ink.height })
      for (const [k, v] of Object.entries(ink.transcripts)) tr.set(k === oldId ? newDrawing : k.replace(oldId, newDrawing), v)
    }
    for (const [k, v] of Object.entries(p.texts)) if (!tr.has(k)) tr.set(k, v)
  })
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true))
  return true
}

/** Copy or cut the block (drawing, picture, recording, file) at a position – the blocks' own Copy / Cut buttons. */
export async function copyBlock(editor: Editor, pos: number | undefined, doc: Y.Doc, cut = false) {
  if (typeof pos !== 'number') return
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return
  const slice = new Slice(editor.state.doc.slice(pos, pos + node.nodeSize).content, 0, 0)
  const { html, text } = clipboardContent(editor.view, slice, doc)
  const ok = await writeClipboard(html, text)
  if (!ok) return showToast('Couldn’t copy – try selecting it and using Copy')
  const what = node.type.name === 'drawing' ? 'Handwriting' : node.type.name === 'image' ? 'Picture' : node.type.name === 'audio' ? 'Recording' : 'File'
  if (cut) {
    const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)).deleteSelection()
    editor.view.dispatch(tr)
  }
  showToast(`${what} ${cut ? 'cut' : 'copied'} – paste it in any note`)
}

export const BlockClipboard = Extension.create<{ doc: Y.Doc | null }>({
  name: 'blockClipboard',
  addOptions() {
    return { doc: null }
  },
  addProseMirrorPlugins() {
    const doc = this.options.doc
    const copy = (view: EditorView, e: ClipboardEvent, cut: boolean) => {
      const sel = view.state.selection
      if (!doc || sel.empty || !e.clipboardData) return false
      const slice = sel.content()
      if (!hasAtoms(slice)) return false // plain text: the usual copy
      const { html, text } = clipboardContent(view, slice, doc)
      e.clipboardData.setData('text/html', html)
      e.clipboardData.setData('text/plain', text)
      e.preventDefault()
      if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'))
      return true
    }
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            copy: (view, e) => copy(view, e, false),
            cut: (view, e) => copy(view, e, true),
          },
          handlePaste: (view, e) => {
            const html = e.clipboardData?.getData('text/html') ?? ''
            if (!doc || !html.includes(MARK)) return false
            const m = new RegExp(`${MARK}="([^"]+)"`).exec(html)
            const p = m ? decode(m[1]) : null
            return p ? pastePayload(view, p, doc) : false
          },
        },
      }),
    ]
  },
})
