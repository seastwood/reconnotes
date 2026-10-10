import { Resvg } from '@resvg/resvg-js'
import { deflateSync } from 'node:zlib'
import { segmentBoxes } from '@reconnotes/core'

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

// ---------------------------------------------------------------------------
// Finding text lines in pictures
// ---------------------------------------------------------------------------

export interface Bitmap {
  width: number
  height: number
  /** 1 = ink, 0 = background */
  ink: Uint8Array
  /** blob number per pixel, filled in by inkBoxes() */
  labels?: Int32Array
}

/** Decode any PNG/JPEG/GIF/WebP into RGBA pixels, scaled to at most `max` px. */
export function decodeImage(data: Buffer, mime: string, max = 1600): { width: number; height: number; rgba: Uint8Array } | null {
  const size = imageSize(data)
  if (!size) return null
  const scale = Math.min(1, max / Math.max(size.width, size.height))
  const w = Math.max(1, Math.round(size.width * scale))
  const h = Math.max(1, Math.round(size.height * scale))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">` +
    `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${data.toString('base64')}"/></svg>`
  try {
    const r = new Resvg(svg, { background: '#ffffff' }).render()
    return { width: r.width, height: r.height, rgba: new Uint8Array(r.pixels) }
  } catch {
    return null
  }
}

/**
 * Separate writing from the background. Works on photos with uneven light
 * (local adaptive threshold), on dark-mode screenshots (light text on a dark
 * background is inverted first), and removes ruled notebook lines.
 */
export function binarize(img: { width: number; height: number; rgba: Uint8Array }): Bitmap {
  const { width: w, height: h, rgba } = img
  const gray = new Float64Array(w * h)
  let sum = 0
  for (let i = 0; i < w * h; i++) {
    const g = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
    gray[i] = g
    sum += g
  }
  if (sum / (w * h) < 110) for (let i = 0; i < w * h; i++) gray[i] = 255 - gray[i] // dark background

  // integral image for fast local means
  const integral = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x]
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) / 24))
  const ink = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const area = (x1 - x0) * (y1 - y0)
      const mean = (integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0]) / area
      const g = gray[y * w + x]
      ink[y * w + x] = g < mean * 0.82 && g < 200 ? 1 : 0
    }
  }

  // remove long straight runs: notebook rules, margins, table borders
  // (they span most of the page; tall letters in a tight crop don't)
  const longH = w * 0.5
  for (let y = 0; y < h; y++) {
    let start = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && ink[y * w + x]
      if (on && start < 0) start = x
      if (!on && start >= 0) {
        if (x - start > longH) for (let k = start; k < x; k++) ink[y * w + k] = 0
        start = -1
      }
    }
  }
  const longV = h * 0.7
  for (let x = 0; x < w; x++) {
    let start = -1
    for (let y = 0; y <= h; y++) {
      const on = y < h && ink[y * w + x]
      if (on && start < 0) start = y
      if (!on && start >= 0) {
        if (y - start > longV) for (let k = start; k < y; k++) ink[k * w + x] = 0
        start = -1
      }
    }
  }
  return { width: w, height: h, ink }
}

/** Bounding boxes of connected blobs of ink (letters, words, marks), minus specks and huge shapes. */
export function inkBoxes(bmp: Bitmap): { id: string; box: { x: number; y: number; w: number; h: number }; area: number }[] {
  const { width: w, height: h, ink } = bmp
  const seen = new Uint8Array(w * h)
  // which blob each ink pixel belongs to (index into `out` + 1; 0 = none)
  const labels = new Int32Array(w * h)
  bmp.labels = labels
  const pixels: number[] = []
  const out: { id: string; box: { x: number; y: number; w: number; h: number }; area: number }[] = []
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (!ink[start] || seen[start]) continue
    let minX = w
    let minY = h
    let maxX = 0
    let maxY = 0
    let area = 0
    stack.push(start)
    seen[start] = 1
    pixels.length = 0
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      const x = p % w
      const y = (p - x) / w
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const q = ny * w + nx
          if (ink[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    if (area < 6 || (bw < 3 && bh < 3)) continue // specks
    const fill = area / (bw * bh)
    if (bw > w * 0.9 && bh > h * 0.9) continue // frames, borders
    if (fill > 0.5 && bw * bh > w * h * 0.05) continue // solid shapes: photos, shadows – not pen strokes
    out.push({ id: `c${out.length}`, box: { x: minX, y: minY, w: bw, h: bh }, area })
    for (const p of pixels) labels[p] = out.length
  }
  return out
}

/** A region of the bitmap as a clean black-on-white grayscale PNG. */
export function cropPng(bmp: Bitmap, box: { x: number; y: number; w: number; h: number }, pad: number, only?: Set<number>): Buffer {
  const x0 = Math.max(0, Math.floor(box.x - pad))
  const y0 = Math.max(0, Math.floor(box.y - pad))
  const x1 = Math.min(bmp.width, Math.ceil(box.x + box.w + pad))
  const y1 = Math.min(bmp.height, Math.ceil(box.y + box.h + pad))
  const w = x1 - x0
  const h = y1 - y0
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0
    for (let x = 0; x < w; x++) {
      const i = (y0 + y) * bmp.width + x0 + x
      const on = only && bmp.labels ? only.has(bmp.labels[i]) : bmp.ink[i] === 1
      raw[y * (w + 1) + 1 + x] = on ? 17 : 255
    }
  }
  return encodePng(w, h, raw)
}

function encodePng(width: number, height: number, filteredGray: Buffer): Buffer {
  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filteredGray)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export interface PictureLine {
  png: Buffer
  bullet: boolean
  level: number
}

/**
 * Find the written lines in a picture: returns one clean crop per line plus
 * its bullet/indent structure, or null when the picture doesn't look like
 * lines of text (a photo of objects, a single word, a diagram…).
 */
export function pictureLines(data: Buffer, mime: string): PictureLine[] | null {
  const img = decodeImage(data, mime)
  if (!img) return null
  const bmp = binarize(img)
  const boxes = inkBoxes(bmp)
  if (boxes.length < 3 || boxes.length > 4000) return null
  const lines = segmentBoxes(boxes)
  if (lines.length < 2 || lines.length > 80) return null
  const byId = new Map(boxes.map((b) => [b.id, b.box]))
  return lines.map((l) => {
    const parts = l.ids.map((id) => byId.get(id)!)
    const x = Math.min(...parts.map((p) => p.x))
    const y = Math.min(...parts.map((p) => p.y))
    const box = { x, y, w: Math.max(...parts.map((p) => p.x + p.w)) - x, h: Math.max(...parts.map((p) => p.y + p.h)) - y }
    // draw only this line's ink (not descenders of the line above poking in)
    const only = new Set(l.ids.map((id) => Number(id.slice(1)) + 1))
    return { png: cropPng(bmp, box, Math.max(6, box.h * 0.25), only), bullet: l.bullet, level: l.level }
  })
}

// ---------------------------------------------------------------------------
// Which way up a photo of a page is
// ---------------------------------------------------------------------------

/**
 * Does the text in this photo run up or down the page (the photo is on its side)? From the letters'
 * shapes alone: in a line of print, each letter's nearest neighbour is beside it (letters sit closer
 * than lines), so on a page on its side, the nearest neighbours are above and below. null: can't
 * tell (too few letters – a photo of food, a blank page).
 */
export function textRunsSideways(data: Buffer, mime: string): boolean | null {
  const img = decodeImage(data, mime, 1200)
  if (!img) return null
  const boxes = inkBoxes(binarize(img))
    .map((b) => b.box)
    // letter-sized blobs only (not pictures, rules or specks)
    .filter((b) => b.w >= 3 && b.h >= 3 && b.w <= 40 && b.h <= 40)
  if (boxes.length < 60) return null
  // a sample is enough (and keeps it quick)
  const step = Math.max(1, Math.floor(boxes.length / 1500))
  const pts = boxes.filter((_, i) => i % step === 0).map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2, s: Math.max(b.w, b.h) }))
  let across = 0
  let down = 0
  for (const p of pts) {
    let best = Infinity
    let dx = 0
    let dy = 0
    for (const q of pts) {
      if (q === p) continue
      const ddx = q.x - p.x
      const ddy = q.y - p.y
      const d = ddx * ddx + ddy * ddy
      if (d < best) {
        best = d
        dx = ddx
        dy = ddy
      }
    }
    // a neighbour in the same word (within a couple of letters), clearly one way or the other
    if (Math.sqrt(best) > p.s * 2.5) continue
    if (Math.abs(dx) > Math.abs(dy) * 1.5) across++
    else if (Math.abs(dy) > Math.abs(dx) * 1.5) down++
  }
  if (across + down < 40) return null
  if (down > across * 1.6) return true
  if (across > down * 1.6) return false
  return null
}

/** The picture turned clockwise by quarter turns, as a JPEG (or a PNG, without the canvas library), at most `max` px. */
export async function rotatePicture(data: Buffer, mime: string, quarters: number, max = 2400): Promise<{ data: Buffer; mime: string } | null> {
  const q = ((quarters % 4) + 4) % 4
  const size = imageSize(data)
  if (!size) return null
  const scale = Math.min(1, max / Math.max(size.width, size.height))
  const w = Math.max(1, Math.round(size.width * scale))
  const h = Math.max(1, Math.round(size.height * scale))
  const side = q % 2 === 1
  const W = side ? h : w
  const H = side ? w : h
  const napi = await import('@napi-rs/canvas').catch(() => null)
  if (napi) {
    try {
      const img = await napi.loadImage(data)
      const canvas = napi.createCanvas(W, H)
      const ctx = canvas.getContext('2d')
      ctx.translate(W / 2, H / 2)
      ctx.rotate((q * Math.PI) / 2)
      ctx.drawImage(img, -w / 2, -h / 2, w, h)
      return { data: await canvas.encode('jpeg', 88), mime: 'image/jpeg' }
    } catch {
      /* fall back to the SVG renderer */
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">` +
    `<g transform="translate(${W / 2} ${H / 2}) rotate(${q * 90}) translate(${-w / 2} ${-h / 2})">` +
    `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${data.toString('base64')}"/></g></svg>`
  try {
    return { data: new Resvg(svg, { background: '#ffffff' }).render().asPng(), mime: 'image/png' }
  } catch {
    return null
  }
}
