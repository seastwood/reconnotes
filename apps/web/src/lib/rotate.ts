import { recognizeImageOnDevice, useDeviceOcr } from './deviceOcr'

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

/**
 * A photo of text, the right way up (on this device's text recognition – the phone's): read every
 * way round, kept the way that reads best, with what it read. null: can't tell here.
 */
export async function uprightPhoto(blob: Blob): Promise<{ blob: Blob; text: string; quarters: number } | null> {
  if (!useDeviceOcr()) return null
  let best: { blob: Blob; text: string; quarters: number; score: number } | null = null
  for (const quarters of [0, 1, 3, 2]) {
    const turned = await rotateImage(blob, quarters)
    const text = (await recognizeImageOnDevice(turned).catch(() => '')).trim()
    const score = readability(text)
    if (!best || score > best.score * 1.15) best = { blob: turned, text, quarters, score }
    // plainly the right way already: no need to try the others
    if (quarters === 0 && score >= 40) break
  }
  return best && best.score > 0 ? { blob: best.blob, text: best.text, quarters: best.quarters } : null
}
