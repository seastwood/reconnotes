import type { Stroke } from '@reconnotes/core'
import { Store, useStore } from './store'

/**
 * Recordings linked to handwriting
 * ================================
 *
 * Every stroke remembers when it was written, and a recording remembers when
 * it started and stopped. In replay mode (the recording's "Replay with
 * writing" button) ink written later than the point the recording has
 * reached is faded, and tapping any writing plays the recording from the
 * moment it was written – like Notability.
 */

export interface ReplayState {
  attachmentId: string | null
  startedAt: number
  endedAt: number
  /** the recording's position as a wall-clock time (null: not started) */
  playhead: number | null
}

export const replay = new Store<ReplayState>({ attachmentId: null, startedAt: 0, endedAt: 0, playhead: null })
export const useReplay = <S,>(select: (s: ReplayState) => S) => useStore(replay, select)

const players = new Map<string, HTMLAudioElement>()

/** The recording's <audio> element, so taps on ink can play it. */
export function registerPlayer(attachmentId: string, el: HTMLAudioElement | null) {
  if (el) players.set(attachmentId, el)
  else players.delete(attachmentId)
}

export function startReplay(attachmentId: string, startedAt: number, endedAt: number) {
  replay.set({ attachmentId, startedAt, endedAt, playhead: null })
}

export function stopReplay() {
  replay.set({ attachmentId: null, playhead: null })
}

/** Was this stroke written while the replayed recording was being made? */
export function inRecording(s: Stroke, r: ReplayState = replay.get()): boolean {
  return Boolean(r.attachmentId && s.t && s.t >= r.startedAt - 1000 && s.t <= r.endedAt)
}

/** Play the recording from a little before this stroke was written. */
export function playFrom(s: Stroke) {
  const r = replay.get()
  const el = r.attachmentId ? players.get(r.attachmentId) : null
  if (!el || !s.t) return
  el.currentTime = Math.max(0, (s.t - r.startedAt) / 1000 - 1.5)
  void el.play().catch(() => undefined)
}

/** Strokes written during the recording, near a point (drawing units). */
export function strokeAt(strokes: Stroke[], x: number, y: number, radius: number): Stroke | null {
  let best: Stroke | null = null
  let bestD = radius * radius
  const r = replay.get()
  for (const s of strokes) {
    if (!inRecording(s, r)) continue
    for (let i = 0; i < s.pts.length; i += 3) {
      const d = (s.pts[i] - x) ** 2 + (s.pts[i + 1] - y) ** 2
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
  }
  return best
}

/** Does this note have writing from while the recording was made? */
export function hasLinkedInk(strokes: Stroke[], startedAt: number, endedAt: number): boolean {
  return strokes.some((s) => s.t && s.t >= startedAt - 1000 && s.t <= endedAt)
}

/**
 * A meeting note's ▶ link (listen:<recording>@<seconds>): play the recording from that moment.
 * False when it isn't such a link; a message when the recording can't be played here.
 */
export function playListenLink(href: string, say: (msg: string) => void): boolean {
  const m = href.match(/^listen:([a-z0-9]+)@(\d+)$/i)
  if (!m) return false
  const el = players.get(m[1])
  if (!el) {
    say('That recording isn’t in this note, or hasn’t downloaded to this device yet.')
    return true
  }
  el.currentTime = Number(m[2])
  void el.play().catch(() => undefined)
  return true
}
