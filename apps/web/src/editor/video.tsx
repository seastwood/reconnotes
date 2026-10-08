import { useContext, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { ExternalLink, Play } from 'lucide-react'
import { videoInfo } from '@reconnotes/core'
import { NoteContext } from '../drawing/DrawingNode'
import { BlockCopyButtons, tap } from './nodes'

/**
 * Videos that play in the note
 * ============================
 *
 * A YouTube or Vimeo video, or a video file on the web, shown in the note:
 * its picture with a play button (nothing loads until then, so a guide with
 * many videos stays quick), then the player itself, right there. Paste a
 * video's address on its own line to add one; imported web pages bring
 * their videos this way too.
 */

function VideoView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const ctx = useContext(NoteContext)
  const src = (node.attrs.src as string) ?? ''
  const title = (node.attrs.title as string) || ''
  const info = videoInfo(src)
  const [playing, setPlaying] = useState(false)
  if (!info)
    return (
      <NodeViewWrapper className="video-block">
        <a href={src} target="_blank" rel="noopener noreferrer">
          {title || src}
        </a>
      </NodeViewWrapper>
    )
  const label = title || (info.provider === 'youtube' ? 'YouTube video' : info.provider === 'vimeo' ? 'Vimeo video' : 'Video')
  return (
    <NodeViewWrapper className={`video-block${selected ? ' selected' : ''}`} data-drag-handle="">
      <div className="image-actions">
        <a className="video-open" href={info.watchUrl} target="_blank" rel="noopener noreferrer" title="Open it on its own site" onPointerDown={(e) => e.stopPropagation()}>
          <ExternalLink size={14} /> {info.provider === 'youtube' ? 'YouTube' : info.provider === 'vimeo' ? 'Vimeo' : 'Open'}
        </a>
        {ctx && editor.isEditable && <BlockCopyButtons editor={editor} getPos={getPos} doc={ctx.doc} what="video" />}
      </div>
      <div className="video-frame">
        {info.provider === 'file' ? (
          <video src={info.embedUrl} controls playsInline preload="metadata" />
        ) : playing ? (
          <iframe
            src={`${info.embedUrl}&autoplay=1`}
            title={label}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button className="video-poster" {...tap(() => setPlaying(true))} aria-label={`Play ${label}`}>
            {info.thumbnail && <img src={info.thumbnail} alt="" draggable={false} loading="lazy" />}
            <span className="video-play">
              <Play size={30} fill="currentColor" />
            </span>
          </button>
        )}
      </div>
      {title && <div className="video-title">{title}</div>}
    </NodeViewWrapper>
  )
}

export const VideoNode = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: '' }, title: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-video-src]', getAttrs: (el) => ({ src: (el as HTMLElement).dataset.videoSrc, title: (el as HTMLElement).dataset.videoTitle ?? '' }) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-video-src': HTMLAttributes.src, 'data-video-title': HTMLAttributes.title })]
  },
  addNodeView() {
    // taps on the player and its buttons are theirs, not the editor's
    return ReactNodeViewRenderer(VideoView, {
      stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('button, a, iframe, video')),
    })
  },
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        props: {
          // a video's address pasted on its own: the video
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
            if (!text || /\s/.test(text) || !videoInfo(text)) return false
            const { $from } = view.state.selection
            // into a table cell or a list item it stays a link
            if ($from.parent.type.name !== 'paragraph' || $from.depth > 1) return false
            const node = type.create({ src: text })
            const tr = $from.parent.content.size ? view.state.tr.insert($from.after(), node) : view.state.tr.replaceWith($from.before(), $from.after(), node)
            view.dispatch(tr.scrollIntoView())
            return true
          },
        },
      }),
    ]
  },
})
