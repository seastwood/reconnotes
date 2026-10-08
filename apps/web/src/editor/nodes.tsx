import { errorText } from '../lib/jobs'
import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type ReactNodeViewProps } from '@tiptap/react'
import { useContext, useEffect, useRef, useState } from 'react'
import { AudioLines, Copy, Eye, FileText, Loader2, Mic, PenLine, ScanText, Scissors, Share, TextQuote } from 'lucide-react'
import { copyBlock } from './blockClipboard'
import { convertImage, transcribeAudio } from '../lib/ai'
import { getNotes, getTranscripts, newId, readNote, wordsKey, type Stroke } from '@reconnotes/core'
import * as Y from 'yjs'
import { isMarkdownFile, noteFromMarkdown } from '../lib/markdownNotes'
import { navigateToNote } from '../lib/jobs'
import { workspaceDoc } from '../lib/workspace'
import { hasLinkedInk, registerPlayer, replay, startReplay, stopReplay, useReplay } from '../lib/replay'
import { addAttachment, attachmentBlob, attachmentUrl } from '../lib/attachments'
import { NoteContext } from '../drawing/DrawingNode'
import { DrawingCanvas } from '../drawing/DrawingCanvas'
import { inkUi, useInkUi } from '../drawing/toolState'
import { useUndoManager } from './undo'
import { fileKind, formatSize, openFile, shareFile } from '../lib/files'
import { openImageViewer } from '../components/ImageViewer'
import { findKey } from './find'
import { useFindInNode, useInkMatches, usePictureMatches, useTranscript, WordHighlights } from './findHighlights'
import { recognizeImageWords, useDeviceOcr } from '../lib/deviceOcr'

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

/**
 * Button handlers that work for finger and Pencil on iPad as well as the
 * mouse: touch/pen act on pointerup (inside a note, iOS doesn't always
 * deliver the click), the mouse on click.
 */
export function tap(action: () => void) {
  let handledAt = 0
  return {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
      e.preventDefault()
      handledAt = Date.now()
      action()
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      if (Date.now() - handledAt < 800) return // already handled on pointerup
      action()
    },
  }
}

// --- Image ------------------------------------------------------------------

/** Pictures located by attachment id this session, so each is read at most once. */
const wordBoxesTried = new Set<string>()

/**
 * iOS app: work out where each word of a picture is (Apple Vision), the first
 * time a search matches its text. Kept with the note, so every device can
 * then highlight the words.
 */
function usePictureWordBoxes(doc: import('yjs').Doc | undefined, attachmentId: string, wanted: boolean) {
  useEffect(() => {
    if (!doc || !wanted || !useDeviceOcr() || wordBoxesTried.has(attachmentId)) return
    wordBoxesTried.add(attachmentId)
    void (async () => {
      try {
        const blob = await attachmentBlob(attachmentId)
        if (!blob) return wordBoxesTried.delete(attachmentId) // not downloaded yet: try again later
        const words = await recognizeImageWords(blob)
        getTranscripts(doc).set(wordsKey(attachmentId), JSON.stringify(words))
      } catch {
        /* best effort: the whole picture is still marked */
      }
    })()
  }, [doc, attachmentId, wanted])
}

function ImageView({ node, selected, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const ctx = useContext(NoteContext)
  const um = useUndoManager()
  const drawingId = node.attrs.drawingId as string | null
  const markingUp = useInkUi((s) => drawingId !== null && s.activeDrawing === drawingId)
  const [aspect, setAspect] = useState<number | null>(null)
  /** the file isn't a picture this device can show */
  const [broken, setBroken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Find in note: highlight matching words in the picture and in handwriting drawn on it
  const find = useFindInNode(editor, getPos)
  const inkMatches = useInkMatches(ctx?.doc, drawingId, find.query)
  const picture = usePictureMatches(ctx?.doc, node.attrs.attachmentId, find.query)
  const pictureText = useTranscript(ctx?.doc, `att:${node.attrs.attachmentId}`)
  usePictureWordBoxes(ctx?.doc, node.attrs.attachmentId, Boolean(find.query && !picture.located && pictureText?.toLocaleLowerCase().includes(find.query.trim().toLocaleLowerCase())))
  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      await convertImage(editor, ctx?.noteId ?? '', node.attrs.attachmentId, () => {
        const pos = getPos()
        return typeof pos === 'number' ? pos + node.nodeSize : undefined
      })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  /** Open the picture's ink layer (created on first use) to draw on it. */
  const markUp = () => {
    let id = drawingId
    if (!id) {
      id = newId()
      updateAttributes({ drawingId: id })
    }
    inkUi.set({ activeDrawing: id, palette: null })
  }
  // The Pencil touching a picture starts marking it up (that first touch
  // only opens it, like a closed drawing); mouse and fingers keep selecting,
  // resizing and scrolling.
  const onPenDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'pen' || !editor.isEditable || markingUp) return
    if ((e.target as HTMLElement).closest('button, .image-resize')) return
    e.preventDefault()
    e.stopPropagation()
    markUp()
  }

  // A tap on the picture (finger or mouse) selects it – its corner handle
  // resizes it – and a tap on the selected picture opens it full screen. The
  // Pencil marks it up instead. (Read-only: a tap opens it.)
  const tapStart = useRef<{ x: number; y: number; t: number; selected: boolean } | null>(null)
  const openViewer = () => {
    if (!url || !ctx) return
    openImageViewer({
      attachmentId: node.attrs.attachmentId,
      url,
      alt: (node.attrs.alt as string) || 'Picture',
      doc: ctx.doc,
      undoManager: um,
      drawingId,
      ensureDrawing: () => {
        const id = newId()
        updateAttributes({ drawingId: id })
        return id
      },
      editable: editor.isEditable,
    })
  }
  const onImgPointerDown = (e: React.PointerEvent) => {
    tapStart.current = e.pointerType === 'pen' || markingUp ? null : { x: e.clientX, y: e.clientY, t: Date.now(), selected }
  }
  const onImgPointerUp = (e: React.PointerEvent) => {
    const s = tapStart.current
    tapStart.current = null
    if (!s || Date.now() - s.t >= 500 || Math.hypot(e.clientX - s.x, e.clientY - s.y) >= 8) return
    if (s.selected || !editor.isEditable) return openViewer()
    const pos = getPos()
    if (typeof pos === 'number') editor.chain().setNodeSelection(pos).run()
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
    <NodeViewWrapper className={`image-block${selected ? ' selected' : ''}${markingUp ? ' marking-up' : ''}`} data-drag-handle="">
      {url && broken ? (
        <div className="attachment-placeholder">This picture can’t be shown{node.attrs.alt ? `: ${node.attrs.alt}` : ''}</div>
      ) : url ? (
        <div className="image-frame" style={width ? { width: `${width}%` } : undefined} onPointerDownCapture={onPenDown}>
          <img
            src={url}
            alt={node.attrs.alt ?? ''}
            draggable={false}
            onPointerDown={onImgPointerDown}
            onPointerUp={onImgPointerUp}
            onError={() => setBroken(true)}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth) setAspect(img.naturalHeight / img.naturalWidth)
            }}
          />
          <WordHighlights rects={picture.rects} current={find.current} />
          {ctx && drawingId && aspect && (
            <DrawingCanvas
              doc={ctx.doc}
              drawingId={drawingId}
              undoManager={um}
              editable={editor.isEditable}
              overlay={{ aspect }}
              highlights={{ rects: inkMatches, current: find.current }}
            />
          )}
          {/* its buttons, once it's tapped (selected): over its top edge, so
              nothing moves when they appear */}
          {selected && editor.isEditable && !markingUp && (
            <div className="image-actions">
              <button {...tap(markUp)} title="Draw on this picture (or just touch it with Apple Pencil)">
                <PenLine size={15} /> Mark up
              </button>
              <button {...tap(() => void convert())} disabled={busy} title="Read the handwriting or text in this picture and add it below">
                {busy ? <Loader2 size={15} className="spin" /> : <ScanText size={15} />} {busy ? 'Reading…' : 'Convert to text'}
              </button>
              {ctx && <BlockCopyButtons editor={editor} getPos={getPos} doc={ctx.doc} what="picture" />}
            </div>
          )}
          {selected && editor.isEditable && !markingUp && (
            <div className="image-resize" onPointerDown={startResize} title="Drag to resize" aria-label="Resize image" />
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
    // drawingId: ink drawn on top of the picture (created when first marked up)
    return { attachmentId: { default: null }, alt: { default: '' }, width: { default: null }, drawingId: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'img[data-attachment-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.attachmentId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId, alt: HTMLAttributes.alt })]
  },
  addNodeView() {
    // Touches on the picture's own controls are theirs alone: the editor
    // mustn't turn them into selecting the picture (which can swallow the tap).
    return ReactNodeViewRenderer(ImageView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('.image-actions, .image-resize, .drawing-canvas.overlay.open, .drawing-canvas.overlay.replay')),
    })
  },
})

/** Copy / Cut for a picture, recording or file: to paste it in another note. */
export function BlockCopyButtons({ editor, getPos, doc, what }: { editor: Editor; getPos: () => number | undefined; doc: Y.Doc; what: string }) {
  return (
    <>
      <button className="block-copy" {...tap(() => void copyBlock(editor, getPos(), doc))} title={`Copy this ${what} (paste it in any note)`} aria-label={`Copy ${what}`}>
        <Copy size={15} />
      </button>
      <button className="block-copy" {...tap(() => void copyBlock(editor, getPos(), doc, true))} title={`Cut this ${what} – to move it to another note`} aria-label={`Cut ${what}`}>
        <Scissors size={15} />
      </button>
    </>
  )
}

// --- Audio ------------------------------------------------------------------

/** Copy text, with a fallback for browsers without the async clipboard. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/** The transcript with the words being searched for (⌘F) marked. */
function highlight(text: string, query: string) {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return text
  const out: (string | React.ReactElement)[] = []
  const lower = text.toLocaleLowerCase()
  let i = 0
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    out.push(text.slice(i, at), <mark key={at} className="find-match current">{text.slice(at, at + q.length)}</mark>)
    i = at + q.length
  }
  out.push(text.slice(i))
  return out
}

/** Is there writing in this note from while the recording was made? */
function useLinkedInk(startedAt: number | null, endedAt: number | null): boolean {
  const ctx = useContext(NoteContext)
  const [linked, setLinked] = useState(false)
  useEffect(() => {
    if (!ctx || !startedAt || !endedAt) return setLinked(false)
    const check = () => {
      for (const key of ctx.doc.share.keys()) {
        if (key.startsWith('ink:') && hasLinkedInk(ctx.doc.getArray<Stroke>(key).toArray(), startedAt, endedAt)) return setLinked(true)
      }
      setLinked(false)
    }
    check()
    ctx.doc.on('afterTransaction', check)
    return () => ctx.doc.off('afterTransaction', check)
  }, [ctx, startedAt, endedAt])
  return linked
}

/** Keep the replay's playhead in step with the audio while it plays. */
function setPlayhead(el: HTMLAudioElement) {
  const r = replay.get()
  if (r.attachmentId) replay.set({ playhead: r.startedAt + el.currentTime * 1000 })
}
function followPlayhead(el: HTMLAudioElement) {
  const step = () => {
    if (!replay.get().attachmentId) return
    setPlayhead(el)
    if (!el.paused && !el.ended) requestAnimationFrame(step)
  }
  step()
}

function AudioView({ node, editor, getPos }: ReactNodeViewProps) {
  const ctx = useContext(NoteContext)
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const startedAt = node.attrs.startedAt as number | null
  const endedAt = node.attrs.endedAt as number | null
  const linked = useLinkedInk(startedAt, endedAt)
  const replaying = useReplay((r) => r.attachmentId === node.attrs.attachmentId)
  // leaving the note ends replay mode
  useEffect(() => () => {
    if (replay.get().attachmentId === node.attrs.attachmentId) stopReplay()
  }, [node.attrs.attachmentId])
  const transcript = useAttachmentText(node.attrs.attachmentId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const flash = (msg: string) => {
    setCopied(msg)
    setTimeout(() => setCopied(null), 1500)
  }
  // Find (⌘F) landed on this recording because its transcript matches: show the transcript
  const findHere = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const f = e ? findKey.getState(e.state) : undefined
      const m = f?.matches[f.current]
      return Boolean(m?.block && m.from === getPos())
    },
  })
  useEffect(() => {
    if (findHere) setOpen(true)
  }, [findHere])
  const findQuery = useEditorState({ editor, selector: ({ editor: e }) => (e ? (findKey.getState(e.state)?.query ?? '') : '') })
  const [error, setError] = useState<string | null>(null)
  const transcribe = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await transcribeAudio(
        editor,
        ctx?.noteId ?? '',
        node.attrs.attachmentId,
        () => {
          const pos = getPos()
          return typeof pos === 'number' ? pos + node.nodeSize : undefined
        },
        transcript,
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <NodeViewWrapper className="audio-block" data-drag-handle="">
      <div className="audio-head">
        <Mic size={16} /> <span>{node.attrs.name || 'Recording'}</span>
        {editor.isEditable && (
          <button className="audio-transcribe" {...tap(() => void transcribe())} disabled={busy} title="Turn the speech into text below this recording">
            {busy ? <Loader2 size={15} className="spin" /> : <AudioLines size={15} />} {busy ? 'Transcribing…' : 'Transcribe'}
          </button>
        )}
        {editor.isEditable && ctx && <BlockCopyButtons editor={editor} getPos={getPos} doc={ctx.doc} what="recording" />}
      </div>
      {error && (
        <div className="drawing-error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {url ? (
        <audio
          ref={(el) => registerPlayer(node.attrs.attachmentId, el)}
          controls
          src={url}
          preload="metadata"
          onPlay={(e) => replaying && followPlayhead(e.currentTarget)}
          onSeeked={(e) => replaying && setPlayhead(e.currentTarget)}
        />
      ) : (
        <div className="attachment-placeholder">{missing ? 'Audio will appear when synced' : '…'}</div>
      )}
      {linked && url && (
        <div className={`replay-bar${replaying ? ' on' : ''}`}>
          <button
            className="audio-transcribe"
            {...tap(() => (replaying ? stopReplay() : startReplay(node.attrs.attachmentId, startedAt!, endedAt!)))}
            title="Tap your writing to hear what was being said when you wrote it"
          >
            <PenLine size={15} /> {replaying ? 'Done replaying' : 'Replay with writing'}
          </button>
          {replaying && <span className="hint">Tap any writing to hear what was said as you wrote it. Writing still to come is faded.</span>}
        </div>
      )}
      {transcript && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Hide transcript' : 'Show transcript'}
        </button>
      )}
      {open && transcript && (
        <>
          <div className="audio-transcript">{highlight(transcript, findQuery)}</div>
          <div className="audio-transcript-actions">
            <button {...tap(() => void copyText(transcript).then(() => flash('Copied')))}>
              <Copy size={14} /> {copied ?? 'Copy'}
            </button>
            {editor.isEditable && (
              <button
                {...tap(() => {
                  const pos = getPos()
                  if (typeof pos !== 'number') return
                  editor
                    .chain()
                    .focus()
                    .insertContentAt(
                      pos + node.nodeSize,
                      transcript.split(/\n+/).filter(Boolean).map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
                    )
                    .run()
                })}
              >
                <TextQuote size={14} /> Insert into note
              </button>
            )}
          </div>
        </>
      )}
    </NodeViewWrapper>
  )
}

export const AudioNode = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    // startedAt / endedAt: when it was recorded here (ms), to link it to the writing done meanwhile
    return { attachmentId: { default: null }, name: { default: '' }, startedAt: { default: null }, endedAt: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'audio[data-attachment-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.attachmentId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(AudioView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('button, audio, .audio-transcript')),
    })
  },
})

// --- Generic file (PDF, documents, …) -----------------------------------------

function FileView({ node, editor, getPos }: ReactNodeViewProps) {
  const ctx = useContext(NoteContext)
  const { url, missing } = useAttachmentUrl(node.attrs.attachmentId)
  const text = useAttachmentText(node.attrs.attachmentId)
  const [error, setError] = useState<string | null>(null)
  const name = (node.attrs.name as string) || 'Attachment'
  const mime = (node.attrs.mime as string) || ''
  const size = Number(node.attrs.size) || 0
  const run = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e) => setError((e as Error).message))
  }
  return (
    <NodeViewWrapper className="file-block" data-drag-handle="">
      <div className="file-card">
        <div className="file-icon" aria-hidden="true">
          <FileText size={22} />
          <span>{fileKind(name, mime).slice(0, 4)}</span>
        </div>
        <div className="file-info">
          <div className="file-name">{name}</div>
          <div className="file-meta">
            {[fileKind(name, mime), formatSize(size), !url && missing ? 'not downloaded yet' : '', text ? 'searchable' : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="file-actions">
          {isMarkdownFile(name, mime) && (
            <button
              {...tap(
                run(async () => {
                  const blob = await attachmentBlob(node.attrs.attachmentId)
                  if (!blob) throw new Error('This file hasn’t been downloaded to this device yet.')
                  const folderId = ctx ? (readNote(getNotes(workspaceDoc).get(ctx.noteId) ?? new Y.Map()).folderId ?? null) : null
                  navigateToNote(await noteFromMarkdown(await blob.text(), name, folderId))
                }),
              )}
              title="Make a note from this Markdown file (headings, lists and checklists become the real thing)"
            >
              <FileText size={16} /> Open as note
            </button>
          )}
          <button {...tap(run(() => openFile(node.attrs.attachmentId, name, mime)))} title="Open">
            <Eye size={16} /> Open
          </button>
          <button {...tap(run(() => shareFile(node.attrs.attachmentId, name)))} title="Share or save a copy" aria-label="Share or save">
            <Share size={16} />
          </button>
          {editor.isEditable && ctx && <BlockCopyButtons editor={editor} getPos={getPos} doc={ctx.doc} what="file" />}
        </div>
      </div>
      {error && (
        <div className="drawing-error" role="alert">
          {error}
        </div>
      )}
    </NodeViewWrapper>
  )
}

export const FileNode = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, name: { default: '' }, mime: { default: '' }, size: { default: 0 } }
  },
  parseHTML() {
    return [{ tag: 'div[data-file-id]', getAttrs: (el) => ({ attachmentId: (el as HTMLElement).dataset.fileId }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-file-id': HTMLAttributes.attachmentId })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('button')),
    })
  },
})

/** Store files locally (synced later) and insert the right node for each. */
/** Put files in the note (pictures, recordings, other files); returns their attachment ids. */
export async function insertFiles(editor: Editor, files: File[], pos?: number): Promise<string[]> {
  const nodes = []
  const ids: string[] = []
  for (const f of files) {
    const attachmentId = await addAttachment(f, f.name)
    ids.push(attachmentId)
    if (f.type.startsWith('image/')) nodes.push({ type: 'image', attrs: { attachmentId, alt: f.name.replace(/\.[^.]+$/, '') } })
    else if (f.type.startsWith('audio/')) nodes.push({ type: 'audio', attrs: { attachmentId, name: f.name } })
    else nodes.push({ type: 'file', attrs: { attachmentId, name: f.name, mime: f.type, size: f.size } })
  }
  if (!nodes.length) return ids
  const chain = editor.chain().focus()
  if (pos !== undefined) chain.insertContentAt(pos, [...nodes, { type: 'paragraph' }]).run()
  else chain.insertContent([...nodes, { type: 'paragraph' }]).run()
  return ids
}
