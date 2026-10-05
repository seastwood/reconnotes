import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { useEditorState, type Editor } from '@tiptap/react'
import { findWordBoxes, getStrokes, getTranscripts, parsePictureWords, wordsInInk, wordsKey, type Rect } from '@reconnotes/core'
import { findKey } from './find'

/**
 * Find in note, inside drawings and pictures: which words to highlight.
 * See packages/core/src/locate.ts for how words are located.
 */

/** The find bar's text while it matches this node, and whether it's the current match. */
export function useFindInNode(editor: Editor, getPos: () => number | undefined): { query: string; current: boolean } {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const f = e ? findKey.getState(e.state) : undefined
      if (!f?.query.trim()) return { query: '', current: false }
      const pos = getPos()
      const i = f.matches.findIndex((m) => m.block && m.from === pos)
      return i < 0 ? { query: '', current: false } : { query: f.query, current: i === f.current }
    },
    equalityFn: (a, b) => a.query === b?.query && a.current === b?.current,
  })
}

/** Value of a transcripts-map key, kept up to date. */
export function useTranscript(doc: Y.Doc | undefined, key: string | null): string | null {
  const [value, setValue] = useState<string | null>(null)
  useEffect(() => {
    if (!doc || !key) return setValue(null)
    const tr = getTranscripts(doc)
    const update = () => setValue(tr.get(key) ?? null)
    update()
    tr.observe(update)
    return () => tr.unobserve(update)
  }, [doc, key])
  return value
}

/** Boxes (drawing units) of the words matching `query` in a drawing's handwriting. */
export function useInkMatches(doc: Y.Doc | undefined, drawingId: string | null, query: string): Rect[] {
  const transcript = useTranscript(doc, drawingId)
  const [inkVersion, setInkVersion] = useState(0)
  const active = Boolean(query.trim() && transcript)
  useEffect(() => {
    if (!doc || !drawingId || !active) return
    const strokes = getStrokes(doc, drawingId)
    const bump = () => setInkVersion((v) => v + 1)
    strokes.observe(bump)
    return () => strokes.unobserve(bump)
  }, [doc, drawingId, active])
  return useMemo(() => {
    if (!doc || !drawingId || !active || !transcript) return []
    return findWordBoxes(wordsInInk(getStrokes(doc, drawingId).toArray(), transcript), query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, drawingId, active, transcript, query, inkVersion])
}

/** Boxes (0–1 of the picture) of the words matching `query` in a picture's text. */
export function usePictureMatches(doc: Y.Doc | undefined, attachmentId: string, query: string): { rects: Rect[]; located: boolean } {
  const json = useTranscript(doc, wordsKey(attachmentId))
  return useMemo(() => {
    const lines = parsePictureWords(json)
    return { rects: lines && query.trim() ? findWordBoxes(lines, query) : [], located: lines !== null }
  }, [json, query])
}

/**
 * Highlight boxes over a drawing or picture. `scale` turns the boxes' units
 * into CSS pixels; without it they are fractions (0–1) of the container.
 */
export function WordHighlights({ rects, current, scale }: { rects: Rect[]; current: boolean; scale?: number }) {
  if (!rects.length) return null
  const pad = scale ? 4 : 0.006
  const unit = (v: number) => (scale ? `${v * scale}px` : `${v * 100}%`)
  return (
    <div className="word-highlights" aria-hidden="true">
      {rects.map((r, i) => (
        <div
          key={i}
          className={`word-highlight${current ? ' current' : ''}`}
          style={{ left: unit(r.x - pad), top: unit(r.y - pad), width: unit(r.w + pad * 2), height: unit(r.h + pad * 2) }}
        />
      ))}
    </div>
  )
}
