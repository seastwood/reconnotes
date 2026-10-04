import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useContext, useEffect, useState } from 'react'
import { FileText, Loader2, Mic, ScanText } from 'lucide-react'
import { convertImage } from '../lib/ai'
import { getTranscripts } from '@reconnotes/core'
import { addAttachment, attachmentUrl } from '../lib/attachments'
import { NoteContext } from '../drawing/DrawingNode'

function useAttachmentUrl(id: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!id) return
    let alive = true
    let retry: ReturnType<typeof setTimeout>
    const load = async () => {
      const u = await attachmentUrl(id)
      if (!alive) return
      if (u) setUrl(u)
      else {
        setMissing(true)
        retry = setTimeout(load, 15_000) // not downloaded yet / offline
      }
    }
    void load()
    return () => {
      alive = false
      clearTimeout(retry)
    }
  }, [id])
  return { url, missing }
}

/** Text the server extracted from an attachment (OCR / transcript), synced in the note. */
function useAttachmentText(id: string) {
  const ctx = useContext(NoteContext)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!ctx) return
    const tr = getTranscripts(ctx.doc)
    const update = () => setText(tr.get(`att:${id}`) ?? null)
    update()
    tr.observe(update)
    return () => tr.unobserve(update)
  }, [ctx, id])
  return text
}

// --- Image ------------------------------------------------------------------

function ImageView({ node, selected, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      await convertImage(editor, node.attrs.attachmentId, () => {
        const pos = getPos()
        return typeof pos === 'number' ? pos + node.nodeSize : undefined
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const width = node.attrs.width as number | null
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // The frame hugs the image, so the handle always sits on its corner.
    const frame = e.currentTarget.closest('.image-frame') as HTMLElement
    const startX = e.clientX
    const startW = frame.getBoundingClientRect().width
    // the block the frame sits in is exactly the text column's width
    const parentW = (frame.parentElement as HTMLElement).clientWidth
    const move = (ev: PointerEvent) => {
      frame.style.width = `${Math.max(60, Math.min(parentW, startW + ev.clientX - startX))}px`
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const w = Math.max(60, Math.min(parentW, startW + ev.clientX - startX))
      updateAttributes({ width: Math.round((w / parentW) * 100) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <NodeViewWrapper className={`image-block${selected ? ' selected' : ''}`} data-drag-handle="">
      {url ? (
        <div className="image-frame" style={width ? { width: `${width}%` } : undefined}>
          <img src={url} alt={node.attrs.alt ?? ''} draggable={false} />
          {selected && editor.isEditable && (
            <div className="image-resize" onPointerDown={startResize} title="Drag to resize" aria-label="Resize image" />
          )}
          {editor.isEditable && (
            <div className={`image-actions${selected || busy ? ' show' : ''}`}>
              <button onClick={convert} disabled={busy} title="Read the handwriting or text in this picture and add it below">
                {busy ? <Loader2 size={16} className="spin" /> : <ScanText size={16} />} {busy ? 'Reading…' : 'Convert to text'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="attachment-placeholder">
          {missing ? 'Image will appear when synced' : <Loader2 className="spin" size={18} />}
        </div>
      )}
      {error && (
        <div className="drawing-error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </NodeViewWrapper>
  )
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, alt: { default: '' }, width: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'img[data-attachment-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.attachmentId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId, alt: HTMLAttributes.alt })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})

// --- Audio ------------------------------------------------------------------

function AudioView({ node }: ReactNodeViewProps) {
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const transcript = useAttachmentText(node.attrs.attachmentId)
  const [open, setOpen] = useState(false)
  return (
    <NodeViewWrapper className="audio-block" data-drag-handle="">
      <div className="audio-head">
        <Mic size={16} /> <span>{node.attrs.name || 'Recording'}</span>
      </div>
      {url ? <audio controls src={url} preload="metadata" /> : <div className="attachment-placeholder">{missing ? 'Audio will appear when synced' : '…'}</div>}
      {transcript && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Hide transcript' : 'Show transcript'}
        </button>
      )}
      {open && transcript && <div className="audio-transcript">{transcript}</div>}
    </NodeViewWrapper>
  )
}

export const AudioNode = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, name: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'audio[data-attachment-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.attachmentId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(AudioView)
  },
})

// --- Generic file (PDF, documents, …) -----------------------------------------

function FileView({ node }: ReactNodeViewProps) {
  const { url } = useAttachmentUrl(node.attrs.attachmentId)
  const text = useAttachmentText(node.attrs.attachmentId)
  return (
    <NodeViewWrapper className="file-block" data-drag-handle="">
      <FileText size={20} />
      {url ? (
        <a href={url} download={node.attrs.name || 'file'} target="_blank" rel="noreferrer">
          {node.attrs.name || 'Attachment'}
        </a>
      ) : (
        <span>{node.attrs.name || 'Attachment'} (not downloaded yet)</span>
      )}
      {text && <span className="file-indexed" title="Contents are searchable">searchable</span>}
    </NodeViewWrapper>
  )
}

export const FileNode = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, name: { default: '' }, mime: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-file-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.fileId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-file-id': HTMLAttributes.attachmentId })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView)
  },
})

/** Store files locally (synced later) and insert the right node for each. */
export async function insertFiles(editor: Editor, files: File[], pos?: number) {
  const nodes = []
  for (const f of files) {
    const attachmentId = await addAttachment(f, f.name)
    if (f.type.startsWith('image/')) nodes.push({ type: 'image', attrs: { attachmentId, alt: f.name.replace(/\.[^.]+$/, '') } })
    else if (f.type.startsWith('audio/')) nodes.push({ type: 'audio', attrs: { attachmentId, name: f.name } })
    else nodes.push({ type: 'file', attrs: { attachmentId, name: f.name, mime: f.type } })
  }
  if (!nodes.length) return
  const chain = editor.chain().focus()
  if (pos !== undefined) chain.insertContentAt(pos, [...nodes, { type: 'paragraph' }]).run()
  else chain.insertContent([...nodes, { type: 'paragraph' }]).run()
}
