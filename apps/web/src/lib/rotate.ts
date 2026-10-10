import { linesOnTheirSide, uprightTurns } from '@reconnotes/core'
import { linesToText, recognizeImageOnDevice, recognizeLinesOnDevice, useDeviceOcr } from './deviceOcr'

/**
 * Turning pictures the right way up
 * =================================
 *
 * A recipe card photographed on its side reads badly – text recognition
 * wants its lines level. A picture can be turned a quarter at a time, and a
 * photo of text can be turned automatically: read every way round, kept the
 * way that reads best.
 */

/** The picture turned clockwise by quarter turns (1 = 90°), as a new file (JPEG, or PNG for a PNG). */
export async function rotateImage(blob: Blob, quarters: number): Promise<Blob> {
  const q = ((quarters % 4) + 4) % 4
  if (!q) return blob
  // (a phone photo's own "this way up" is applied first)
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  const side = q % 2 === 1
  const canvas = document.createElement('canvas')
  canvas.width = side ? bmp.height : bmp.width
  canvas.height = side ? bmp.width : bmp.height
  const ctx = canvas.getContext('2d')!
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((q * Math.PI) / 2)
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2)
  bmp.close()
  const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg'
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t turn the picture'))), type, 0.92))
}

/** How much a reading looks like real text: its words of three letters or more, with a vowel. */
const readability = (text: string) => (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).filter((w) => /[aeiouy]/i.test(w)).length

/** The picture's width over its height, the way it's shown (a phone photo's own "this way up" applied). */
async function aspectOf(blob: Blob): Promise<number> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  const a = bmp.width / Math.max(1, bmp.height)
  bmp.close()
  return a
}

/**
 * A photo of text, the right way up (on this device's text recognition – the phone's), with what it
 * read. null: can't tell here.
 *
 * Apple's recognition reads text on its side as well as level, so how well it reads doesn't say
 * which way up the photo is – which way its words run does (uprightTurns): read once, turned the way
 * the words say. Only when they can't say (an older app without word boxes) is it read every way round,
 * kept the way that reads best.
 */
export async function uprightPhoto(blob: Blob): Promise<{ blob: Blob; text: string; quarters: number } | null> {
  if (!useDeviceOcr()) return null
  const lines = await recognizeLinesOnDevice(blob).catch(() => [])
  if (!lines.length) return null
  const aspect = await aspectOf(blob).catch(() => 1)
  const turns = uprightTurns(lines, aspect)
  if (turns === 0) return { blob, text: linesToText(lines), quarters: 0 }
  if (turns !== null) {
    const turned = await rotateImage(blob, turns)
    return { blob: turned, text: (await recognizeImageOnDevice(turned).catch(() => '')).trim(), quarters: turns }
  }
  // can't tell from the words: every way round, the best reading kept (on its side: not level as it is)
  const sideways = linesOnTheirSide(lines, aspect)
  let best: { blob: Blob; text: string; quarters: number; score: number } | null = null
  for (const quarters of sideways ? [1, 3] : [0, 1, 3, 2]) {
    const turned = await rotateImage(blob, quarters)
    const text = quarters === 0 ? linesToText(lines) : (await recognizeImageOnDevice(turned).catch(() => '')).trim()
    const score = readability(text)
    if (!best || score > best.score * 1.15) best = { blob: turned, text, quarters, score }
    // plainly the right way already: no need to try the others
    if (quarters === 0 && score >= 40) break
  }
  return best && best.score > 0 ? { blob: best.blob, text: best.text, quarters: best.quarters } : null
}
