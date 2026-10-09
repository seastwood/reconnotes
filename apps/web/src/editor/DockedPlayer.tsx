import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpToLine, Mic, Pause, Play, X } from 'lucide-react'

const clock = (s: number) => {
  if (!Number.isFinite(s)) return '–:––'
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * A recording that's playing stays at hand: once its own player has scrolled
 * out of view, a slim player sits at the top of the note, just under the
 * toolbar – play / pause, where it is, and a tap back to the recording.
 * It works the same <audio> element, so nothing restarts.
 */
export function DockedPlayer({ audio, anchor, name }: { audio: HTMLAudioElement | null; anchor: HTMLElement | null; name: string }) {
  const [playing, setPlaying] = useState(false)
  const [inView, setInView] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(NaN)
  const [closed, setClosed] = useState(false)
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null)
  const scroller = anchor?.closest('.editor-scroll') as HTMLElement | null

  // playing or not, and where
  useEffect(() => {
    if (!audio) return
    const sync = () => {
      setPlaying(!audio.paused && !audio.ended)
      setTime(audio.currentTime)
      setDuration(audio.duration)
    }
    const onPlay = () => (setClosed(false), sync())
    const events = ['pause', 'ended', 'timeupdate', 'seeked', 'loadedmetadata', 'durationchange'] as const
    audio.addEventListener('play', onPlay)
    for (const e of events) audio.addEventListener(e, sync)
    sync()
    return () => {
      audio.removeEventListener('play', onPlay)
      for (const e of events) audio.removeEventListener(e, sync)
    }
  }, [audio])

  // is the recording's own player on screen?
  useEffect(() => {
    if (!anchor || !scroller) return
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { root: scroller, threshold: 0.6 })
    io.observe(anchor)
    return () => io.disconnect()
  }, [anchor, scroller])

  // the note's visible area: the bar spans it, at its top
  const shown = playing && !inView && !closed && Boolean(scroller)
  useEffect(() => {
    if (!shown || !scroller) return
    const place = () => {
      const r = scroller.getBoundingClientRect()
      setBox({ top: r.top, left: r.left, width: r.width })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(scroller)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [shown, scroller])

  if (!shown || !box || !audio) return null
  const seek = (t: number) => {
    audio.currentTime = t
    setTime(t)
  }
  return createPortal(
    <div className="docked-player" style={{ top: box.top, left: box.left, width: box.width }} role="region" aria-label="Recording playing">
      <button className="icon" aria-label={playing ? 'Pause' : 'Play'} onClick={() => (audio.paused ? void audio.play() : audio.pause())}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <span className="docked-name">
        <Mic size={13} /> {name}
      </span>
      <span className="docked-time">{clock(time)}</span>
      <input
        type="range"
        min={0}
        max={Number.isFinite(duration) ? duration : 0}
        step={1}
        value={Math.min(time, Number.isFinite(duration) ? duration : time)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Position"
      />
      <span className="docked-time">{clock(duration)}</span>
      <button className="icon" aria-label="Show the recording" title="Show the recording" onClick={() => anchor?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
        <ArrowUpToLine size={17} />
      </button>
      <button
        className="icon"
        aria-label="Stop"
        title="Stop"
        onClick={() => {
          audio.pause()
          setClosed(true)
        }}
      >
        <X size={17} />
      </button>
    </div>,
    document.body,
  )
}
