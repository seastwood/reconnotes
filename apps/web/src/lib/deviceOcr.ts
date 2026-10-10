import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  linesToMarkdown,
  type PictureWords,
  positionedLinesToMarkdown,
  readingOrderText,
  recognitionStyle,
  segmentLines,
  strokePath,
  unionBounds,
  type Stroke,
} from '@reconnotes/core'
import { isSyncConfigured, settings } from './settings'
import { inkUi } from '../drawing/toolState'

/**
 * On-device handwriting recognition with Apple's Vision framework
 * ==============================================================
 *
 * In the iOS/iPadOS app, a small native plugin (TextRecognition, in
 * ios/App/App/SceneDelegate.swift) runs Apple's text recognizer on the
 * device: fast, private, free and offline. ReconNotes still works out the
 * page structure (lines, bullets, indentation) itself and only asks Vision to
 * read the text.
 */

interface VisionLine {
  text: string
  confidence: number
  /** normalised 0–1, origin top-left */
  x: number
  y: number
  w: number
  h: number
  /** each word's box (same units); older app builds don't send these */
  words?: { text: string; x: number; y: number; w: number; h: number }[]
}

interface TextRecognitionPlugin {
  recognize(options: { image: string; languages?: string[] }): Promise<{ lines: VisionLine[]; width: number; height: number }>
}

const TextRecognition = registerPlugin<TextRecognitionPlugin>('TextRecognition')

/** Is Apple's recognizer available (running in the iOS app)? */
export function deviceOcrAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('TextRecognition')
}

/** Available and switched on in Settings. */
export function useDeviceOcr(): boolean {
  return deviceOcrAvailable() && settings.get().deviceOcr !== false
}

/** Your server's handwriting models go first; Apple's recognizer is the fallback (offline, or they fail). */
export function preferServerOcr(): boolean {
  // offline: straight to Apple instead of waiting for the server
  return settings.get().ocrFirst === 'server' && isSyncConfigured() && navigator.onLine !== false
}

async function recognize(pngBase64: string): Promise<VisionLine[]> {
  const r = await TextRecognition.recognize({ image: pngBase64 })
  return r.lines.filter((l) => l.text.trim())
}

/** Render strokes like the server does for recognition: dark, even lines on white, cropped to the ink. */
export function renderStrokesForRecognition(strokes: Stroke[]): string | null {
  const ink = strokes.filter((s) => s.tool !== 'highlighter')
  const b = unionBounds(ink)
  if (!b) return null
  const pad = 20
  const x = b.x - pad
  const y = b.y - pad
  const w = b.w + pad * 2
  const h = b.h + pad * 2
  // longest side ~1500px: plenty for recognition
  const scale = Math.min(3, 1500 / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale)
  ctx.fillStyle = '#111111'
  for (const s of ink) ctx.fill(new Path2D(strokePath(s, recognitionStyle(s, scale))))
  return canvas.toDataURL('image/png').split(',')[1]
}

/** Join what Vision read on one line, left to right. */
function joinLeftToRight(lines: VisionLine[]): string {
  return [...lines]
    .sort((a, b) => a.x - b.x)
    .map((l) => l.text.trim())
    .join(' ')
}

/**
 * Recognise a drawing on the device. Lines, bullets and indentation come
 * from the pen strokes; Vision reads each line.
 */
export async function recognizeDrawingOnDevice(strokes: Stroke[]): Promise<string> {
  const lines = segmentLines(strokes)
  if (!lines.length) return ''
  if (lines.length === 1) {
    const png = renderStrokesForRecognition(strokes)
    return png ? joinLeftToRight(await recognize(png)) : ''
  }
  const texts: string[] = []
  for (const line of lines) {
    const png = renderStrokesForRecognition(line.strokes)
    texts.push(png ? joinLeftToRight(await recognize(png)) : '')
  }
  return linesToMarkdown(lines, texts)
}

/**
 * Recognise a picture (photo, screenshot) on the device. Vision finds and
 * reads the lines; their positions give the indentation.
 */
export async function recognizeImageOnDevice(blob: Blob): Promise<string> {
  const base64 = await blobToBase64(blob)
  return positionedLinesToMarkdown(await recognize(base64))
}

/**
 * A photographed page of print (a recipe card, a book, a guide) read on the device, in reading order:
 * down each column, a grid of steps row by row, a table's rows kept together.
 */
export async function recognizePageOnDevice(blob: Blob): Promise<string> {
  return readingOrderText(await recognize(await blobToBase64(blob)))
}

/**
 * Where each word of a picture is (for highlighting search matches), in
 * reading order. Vision sometimes gives handwriting words the whole line's
 * box; then the line is shared out between its words by their length.
 */
export async function recognizeImageWords(blob: Blob): Promise<PictureWords> {
  const found = await recognize(await blobToBase64(blob))
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  const lines = [...found]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((l) => {
      const words = l.words?.length ? l.words : null
      const sameAsLine = words?.every((w) => Math.abs(w.w - l.w) < 0.002 && Math.abs(w.x - l.x) < 0.002)
      if (words && !(sameAsLine && words.length > 1)) return words.map((w) => ({ t: w.text, x: r4(w.x), y: r4(w.y), w: r4(w.w), h: r4(w.h) }))
      const parts = l.text.split(/\s+/).filter(Boolean)
      const total = parts.reduce((n, p) => n + p.length, 0) + parts.length - 1
      let at = 0
      return parts.map((t) => {
        const w = { t, x: r4(l.x + (l.w * at) / total), y: r4(l.y), w: r4((l.w * t.length) / total), h: r4(l.h) }
        at += t.length + 1
        return w
      })
    })
    .filter((l) => l.length)
  return { v: 1, lines }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

interface ScribblePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>
}
const Scribble = registerPlugin<ScribblePlugin>('Scribble')

/**
 * iOS app: iPadOS Scribble (Pencil writing over text becomes typed text)
 * follows the "When the Pencil touches typed text" setting. With "Use
 * Scribble", it works in the text but is switched off while a drawing is
 * being edited, so writing in the drawing stays ink. Tapping back into the
 * text (or Done) ends the drawing and Scribble works again.
 */
export function syncScribbleSetting() {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('Scribble')) return
  let last: boolean | null = null
  const apply = () => {
    const enabled = settings.get().pencilInText === 'scribble' && !inkUi.get().activeDrawing
    if (enabled === last) return
    last = enabled
    Scribble.setEnabled({ enabled }).catch(() => undefined)
  }
  apply()
  settings.subscribe(apply)
  inkUi.subscribe(apply)
}
