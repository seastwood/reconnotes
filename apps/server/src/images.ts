import { Resvg } from '@resvg/resvg-js'

/** Read width/height from a PNG, JPEG, GIF or WebP header (no decoding). */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    // PNG
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    // GIF
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    // WebP
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
      }
    }
    // JPEG: walk the segments to the start-of-frame marker
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        i += 2 + len
      }
    }
  } catch {
    /* malformed header */
  }
  return null
}

/**
 * Make an image safe to send to any model: if it's larger than `max` pixels
 * on its longest side (or very large in bytes), scale it down to a PNG.
 * Small images are passed through untouched.
 */
export function fitForAi(data: Buffer, mime: string, max = 1600): { data: Buffer; mime: string } {
  const size = imageSize(data)
  if (!size || mime === 'image/gif') return { data, mime }
  const longest = Math.max(size.width, size.height)
  if (longest <= max && data.length <= 3_500_000) return { data, mime }
  const scale = Math.min(1, max / longest)
  const w = Math.max(1, Math.round(size.width * scale))
  const h = Math.max(1, Math.round(size.height * scale))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">` +
    `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${data.toString('base64')}"/></svg>`
  try {
    const png = new Resvg(svg, { background: '#ffffff' }).render().asPng()
    return png.length > 0 ? { data: png, mime: 'image/png' } : { data, mime }
  } catch {
    return { data, mime }
  }
}
