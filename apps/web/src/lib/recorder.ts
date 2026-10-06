import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import * as Y from 'yjs'
import { getContent, noteDocName } from '@reconnotes/core'
import { addAttachment } from './attachments'
import { Store, useStore } from './store'
import { sync } from './sync'
import { showToast } from './toast'

/**
 * Recording audio
 * ===============
 *
 * In the iPhone / iPad app the recording is made natively (like Voice
 * Memos): it keeps going with the screen locked or in another app, and the
 * screen doesn't lock by itself while recording. In a browser, MediaRecorder
 * is used, with a screen wake lock; if the browser stops the microphone (the
 * page was hidden), what was recorded so far is saved, not lost.
 *
 * The recording belongs to the app, not the note on screen: you can open
 * other notes while it runs, and stopping it adds it to the note it started in.
 */

interface AudioRecorderPlugin {
  start(): Promise<{ startedAt: number }>
  stop(): Promise<{ path: string; startedAt: number; endedAt: number; mime: string }>
  status(): Promise<{ recording: boolean; startedAt?: number }>
  remove(o: { path: string }): Promise<void>
  addListener(event: 'interrupted', fn: () => void): Promise<PluginListenerHandle>
}
const Native = registerPlugin<AudioRecorderPlugin>('AudioRecorder')
const native = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AudioRecorder')

export interface Recording {
  noteId: string
  startedAt: number
}
export const recorder = new Store<{ active: Recording | null; saving: boolean }>({ active: null, saving: false })
export const useRecording = () => useStore(recorder, (s) => s.active)
export const useRecorderSaving = () => useStore(recorder, (s) => s.saving)

/** The note's editor, when it's open: the recording goes in at the cursor there. */
type Inserter = (attrs: { attachmentId: string; name: string; startedAt: number; endedAt: number }) => void
const inserters = new Map<string, Inserter>()
export function setRecordingTarget(noteId: string, insert: Inserter | null) {
  if (insert) inserters.set(noteId, insert)
  else inserters.delete(noteId)
}

// browser recording
let web: { r: MediaRecorder; stream: MediaStream; chunks: Blob[]; wake: WakeLockSentinel | null } | null = null

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly code: 'denied' | 'unsupported' | 'insecure' | 'other',
  ) {
    super(message)
  }
}

export async function startRecording(noteId: string): Promise<void> {
  if (recorder.get().active) return
  if (native()) {
    try {
      const { startedAt } = await Native.start()
      recorder.set({ active: { noteId, startedAt } })
    } catch (e) {
      const err = e as Error & { code?: string }
      throw new RecordingError(err.message, err.code === 'denied' ? 'denied' : 'other')
    }
    return
  }
  // Browsers only allow the microphone on secure (https) pages; on a plain
  // http address navigator.mediaDevices doesn't exist at all.
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    throw new RecordingError('This browser can’t record audio.', window.isSecureContext ? 'unsupported' : 'insecure')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    const err = e as Error
    throw new RecordingError(err.name === 'NotAllowedError' ? 'Microphone access was denied.' : `Microphone unavailable: ${err.message}`, err.name === 'NotAllowedError' ? 'denied' : 'other')
  }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
  const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  // the browser cut the microphone off (page hidden, device asleep): keep what we have
  const cutOff = () => {
    if (web?.r === r && r.state !== 'inactive') void stopRecording(true)
  }
  stream.getTracks().forEach((t) => t.addEventListener('ended', cutOff))
  r.onerror = cutOff
  // in pieces every second, so a cut-off recording still has its audio
  r.start(1000)
  let wake: WakeLockSentinel | null = null
  try {
    wake = (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    /* no wake lock: the screen may lock (then it's saved) */
  }
  web = { r, stream, chunks, wake }
  recorder.set({ active: { noteId, startedAt: Date.now() } })
}

/** Stop and add the recording to its note. `cutOff`: the device stopped it, not you. */
export async function stopRecording(cutOff = false): Promise<void> {
  const active = recorder.get().active
  if (!active) return
  recorder.set({ active: null, saving: true })
  try {
    let blob: Blob
    let startedAt = active.startedAt
    let endedAt = Date.now()
    if (native()) {
      const res = await Native.stop()
      startedAt = res.startedAt
      endedAt = res.endedAt
      blob = await (await fetch(Capacitor.convertFileSrc(res.path))).blob()
      blob = new Blob([blob], { type: res.mime })
      void Native.remove({ path: res.path }).catch(() => {})
    } else {
      const w = web!
      web = null
      blob = await new Promise<Blob>((resolve) => {
        const done = () => resolve(new Blob(w.chunks, { type: w.r.mimeType.split(';')[0] || 'audio/webm' }))
        if (w.r.state === 'inactive') return done()
        w.r.addEventListener('stop', done, { once: true })
        w.r.stop()
      })
      w.stream.getTracks().forEach((t) => t.stop())
      void w.wake?.release().catch(() => {})
    }
    if (!blob.size) throw new Error('Nothing was recorded.')
    const name = `Recording ${new Date(startedAt).toLocaleString()}`
    const attachmentId = await addAttachment(blob, `${name}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`)
    const attrs = { attachmentId, name, startedAt, endedAt }
    const insert = inserters.get(active.noteId)
    if (insert) insert(attrs)
    else await appendToNote(active.noteId, attrs)
    const mins = Math.max(1, Math.round((endedAt - startedAt) / 60_000))
    if (cutOff) showToast(`Recording stopped when the microphone was cut off – the first ${mins} min ${mins === 1 ? 'is' : 'are'} saved`)
    else if (!insert) showToast('Recording saved in its note')
  } catch (e) {
    showToast(`The recording couldn’t be saved: ${(e as Error).message}`)
  } finally {
    recorder.set({ saving: false })
  }
}

/** The note isn't open: put the recording at its end. */
async function appendToNote(noteId: string, attrs: Record<string, string | number>) {
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    await handle.loaded
    handle.doc.transact(() => {
      const a = new Y.XmlElement('audio')
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v as string)
      getContent(handle.doc).push([a, new Y.XmlElement('paragraph')])
    })
  } finally {
    // give the change a moment to be saved and sent
    setTimeout(close, 3000)
  }
}

/** At start: if the app was reloaded mid-recording, pick the native recording back up. */
export function resumeRecording(noteId: string | null) {
  if (!native()) return
  void Native.status().then((s) => {
    if (s.recording && s.startedAt && !recorder.get().active && noteId) recorder.set({ active: { noteId, startedAt: s.startedAt } })
  })
  void Native.addListener('interrupted', () => {
    if (recorder.get().active) void stopRecording(true)
  })
}
