import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { alignWordTimes, parseWordTimes, spanAt, speakerAt, speakerName, type SpeakerSegment } from '@reconnotes/core'

/**
 * A recording's transcript that follows along as it plays: the word being
 * said is highlighted (and kept in view), and tapping a word plays from there.
 * Needs the word times Whisper gives; without them, plain text. While you
 * search the note (⌘F), the matches are marked in it – it still plays and
 * keeps its speakers.
 */
export function FollowAlong({
  text,
  timing,
  player,
  speakers,
  names = {},
  onSpeaker,
  query = '',
}: {
  text: string
  timing: string | null
  player: () => HTMLAudioElement | null
  /** who spoke when (the speaker-label service): a label where each turn starts */
  speakers?: SpeakerSegment[] | null
  names?: Record<number, string>
  /** a speaker's label tapped (to name them) */
  onSpeaker?: (speaker: number, anchor: HTMLElement) => void
  /** the words being searched for, marked where they're found */
  query?: string
}) {
  const spans = useMemo(() => {
    const words = parseWordTimes(timing)
    return words?.length ? alignWordTimes(text, words) : []
  }, [text, timing])
  const [current, setCurrent] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => findAll(text, query), [text, query])
  // the first match in view (within the transcript's own scroll area)
  useEffect(() => {
    const scroller = box.current
    const mark = scroller?.querySelector<HTMLElement>('mark')
    if (!scroller || !mark) return
    const r = mark.getBoundingClientRect()
    const v = scroller.getBoundingClientRect()
    scroller.scrollTop += r.top - v.top - v.height / 3
  }, [matches])
  // you scrolled yourself: leave the view alone for a moment
  const userScrolledAt = useRef(0)

  useEffect(() => {
    const el = player()
    if (!el || !spans.length) return
    let frame = 0
    const tick = () => {
      setCurrent(spanAt(spans, el.currentTime))
      if (!el.paused && !el.ended) frame = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    const onSeek = () => setCurrent(spanAt(spans, el.currentTime))
    el.addEventListener('play', onPlay)
    el.addEventListener('seeked', onSeek)
    el.addEventListener('timeupdate', onSeek)
    if (!el.paused) onPlay()
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('seeked', onSeek)
      el.removeEventListener('timeupdate', onSeek)
    }
  }, [spans, player])

  // the word being said stays in view (unless you've just scrolled)
  useEffect(() => {
    const el = player()
    if (current < 0 || !el || el.paused || Date.now() - userScrolledAt.current < 4000) return
    // within the transcript's own scroll area – the note itself stays where you are
    const word = box.current?.querySelector<HTMLElement>('.spoken')
    const scroller = box.current
    if (!word || !scroller) return
    const r = word.getBoundingClientRect()
    const v = scroller.getBoundingClientRect()
    if (r.top < v.top + 20 || r.bottom > v.bottom - 30) scroller.scrollTo({ top: scroller.scrollTop + (r.top - v.top) - v.height / 3, behavior: 'smooth' })
  }, [current, player])
  useEffect(() => {
    const scroller = box.current
    if (!scroller) return
    const mark = () => (userScrolledAt.current = Date.now())
    scroller.addEventListener('touchmove', mark, { passive: true })
    scroller.addEventListener('wheel', mark, { passive: true })
    return () => {
      scroller.removeEventListener('touchmove', mark)
      scroller.removeEventListener('wheel', mark)
    }
  }, [spans.length])

  // a stretch of the text, with what you searched for marked in it
  const piece = (from: number, to: number, key: string | number): React.ReactNode => {
    if (!matches.length || from >= to) return text.slice(from, to)
    const out: React.ReactNode[] = []
    let i = from
    for (const [a, b] of matches) {
      if (b <= from || a >= to) continue
      const s = Math.max(a, from)
      const e = Math.min(b, to)
      if (s > i) out.push(text.slice(i, s))
      out.push(
        <mark key={`${key}m${s}`} className={`find-match${a === matches[0][0] ? ' current' : ''}`}>
          {text.slice(s, e)}
        </mark>,
      )
      i = e
    }
    if (i < to) out.push(text.slice(i, to))
    return out.length === 1 ? out[0] : out
  }

  if (!spans.length)
    return (
      <div ref={box} className="audio-transcript">
        {piece(0, text.length, 'all')}
      </div>
    )
  const parts: React.ReactNode[] = []
  let at = 0
  let lastSpeaker: number | null = null
  spans.forEach((s, i) => {
    // a new speaker's turn: their label, on a new line
    const who = speakers?.length ? speakerAt(speakers, s.start, s.end) : null
    if (who !== null && who !== lastSpeaker) {
      if (lastSpeaker !== null) parts.push(<br key={`br${i}`} />)
      parts.push(
        <button
          key={`sp${i}`}
          type="button"
          className={`speaker-label speaker-${who % 6}${names[who] ? ' named' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onSpeaker?.(who, e.currentTarget)
          }}
          title={names[who] ? `${names[who]} – tap to change` : 'Who is this? Tap to name them'}
        >
          {speakerName(names, who)}
        </button>,
      )
      lastSpeaker = who
      // the turn's own words start the line (not the space before them)
      if (s.from > at) at = s.from
    }
    if (s.from > at) parts.push(<Fragment key={`g${i}`}>{piece(at, s.from, `g${i}`)}</Fragment>)
    parts.push(
      <span
        key={i}
        className={`timed-word${i === current ? ' spoken' : ''}`}
        onClick={() => {
          const el = player()
          if (!el) return
          el.currentTime = s.start
          void el.play()
        }}
      >
        {piece(s.from, s.to, i)}
      </span>,
    )
    at = s.to
  })
  parts.push(<Fragment key="end">{piece(at, text.length, 'end')}</Fragment>)
  return (
    <div ref={box} className="audio-transcript timed" title="Tap a word to play from there">
      {parts}
    </div>
  )
}

/** Where `query` appears in the text ([from, to) pairs), ignoring case. */
function findAll(text: string, query: string): [number, number][] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return []
  const lower = text.toLocaleLowerCase()
  const out: [number, number][] = []
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) out.push([at, at + q.length])
  return out
}
