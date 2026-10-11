import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { readingOrderText } from '@reconnotes/core'
import type { Ai } from './ai'
import { colourBands, decodeImage, grayPng, imageSize } from './images'
import { log } from './log'

/**
 * Reading printed pages with Tesseract
 * ====================================
 *
 * In the iPhone and iPad app, photos of printed pages are read on the device by Apple's text
 * recognition. In a browser (Safari on a phone or a laptop) there's none, so the server reads them –
 * and a vision model, good at describing a picture, is poor at copying small print exactly. Where
 * Tesseract is installed (sudo apt install tesseract-ocr), it reads the print instead: every word with
 * where it is on the page, so the page is put in reading order the same way as the phone's reading
 * (down each column, a grid of ingredients cell by cell). The AI only sets out what it read.
 *
 * Tesseract misreads small fractions (½ as "Y2", ¼ as "%"): the lines with one are shown to the
 * vision model with the photo, to say which fraction is printed there – and its answer is taken only
 * if every other word on the line is unchanged.
 */

const LANG = () => process.env.RECON_TESSERACT_LANG || 'eng'

let found: Promise<boolean> | null = null
/** Is Tesseract installed (and not switched off with RECON_TESSERACT=off)? */
export function tesseractAvailable(): Promise<boolean> {
  if (process.env.RECON_TESSERACT === 'off') return Promise.resolve(false)
  found ??= new Promise((resolve) => execFile('tesseract', ['--version'], { timeout: 10_000 }, (err) => resolve(!err)))
  return found
}

interface Word {
  text: string
  conf: number
  x: number
  y: number
  w: number
  h: number
}
export interface PrintLine {
  text: string
  x: number
  y: number
  w: number
  h: number
  words: { x: number; y: number; w: number; h: number }[]
  conf: number
}

/**
 * Tesseract's TSV as lines of words (0–1 of the page), a line split where its words are far apart:
 * a grid's cells ("¼ oz | ¼ oz      1 Clove | 2 Cloves") read on one line are separate pieces, so
 * reading order can take them column by column.
 */
export function linesFromTsv(tsv: string): PrintLine[] {
  const rows = tsv.split('\n').slice(1).map((r) => r.split('\t'))
  const page = rows.find((r) => r[0] === '1')
  const W = Number(page?.[8]) || 1
  const H = Number(page?.[9]) || 1
  const groups = new Map<string, Word[]>()
  for (const r of rows) {
    if (r[0] !== '5' || r.length < 12) continue
    const text = r.slice(11).join('\t').trim()
    const conf = Number(r[10])
    // (nothing, or a picture read as a scrap of text)
    if (!text || conf < 20) continue
    const key = `${r[2]}-${r[3]}-${r[4]}`
    const list = groups.get(key) ?? []
    list.push({ text, conf, x: Number(r[6]), y: Number(r[7]), w: Number(r[8]), h: Number(r[9]) })
    groups.set(key, list)
  }
  const out: PrintLine[] = []
  for (const words of groups.values()) {
    words.sort((a, b) => a.x - b.x)
    const hs = words.map((w) => w.h).sort((a, b) => a - b)
    const lineH = hs[Math.floor(hs.length / 2)] || 10
    let piece: Word[] = []
    const flush = () => {
      if (!piece.length) return
      const x0 = Math.min(...piece.map((w) => w.x))
      const y0 = Math.min(...piece.map((w) => w.y))
      const x1 = Math.max(...piece.map((w) => w.x + w.w))
      const y1 = Math.max(...piece.map((w) => w.y + w.h))
      out.push({
        text: piece.map((w) => w.text).join(' '),
        x: x0 / W,
        y: y0 / H,
        w: (x1 - x0) / W,
        h: (y1 - y0) / H,
        words: piece.map((w) => ({ x: w.x / W, y: w.y / H, w: w.w / W, h: w.h / H })),
        conf: piece.reduce((s, w) => s + w.conf, 0) / piece.length,
      })
      piece = []
    }
    for (const w of words) {
      const last = piece[piece.length - 1]
      if (last && w.x - (last.x + last.w) > lineH * 1.8) flush()
      piece.push(w)
    }
    flush()
  }
  return out
}

/** The photo, enlarged for Tesseract (small print reads far better at twice the size), as a PNG file. */
function enlarged(data: Buffer, mime: string, file: string): boolean {
  const size = imageSize(data)
  if (!size) return false
  const k = Math.min(2, 4200 / Math.max(size.width, size.height))
  if (k <= 1.05) return fs.writeFileSync(file, data), true
  const w = Math.round(size.width * k)
  const h = Math.round(size.height * k)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">` +
    `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${data.toString('base64')}"/></svg>`
  try {
    fs.writeFileSync(file, new Resvg(svg, { background: '#ffffff' }).render().asPng())
    return true
  } catch {
    return false
  }
}

/** Tesseract's reading of a photo: its lines with where they are, or null (not installed, failed). */
export async function tesseractLines(data: Buffer, mime: string): Promise<PrintLine[] | null> {
  if (!(await tesseractAvailable()) || !/^image\/(png|jpeg|jpg|webp|gif|bmp|tiff)$/.test(mime)) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-ocr-'))
  const file = path.join(dir, 'page.png')
  try {
    if (!enlarged(data, mime, file)) return null
    const [tsv, banners] = await Promise.all([runTesseract(file, 3), bannerLines(data, mime, dir).catch(() => [])])
    return withBanners(linesFromTsv(tsv), banners)
  } catch (e) {
    log.warn(`tesseract couldn't read a photo: ${(e as Error).message}`)
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const runTesseract = (file: string, psm: number) =>
  new Promise<string>((resolve, reject) =>
    execFile('tesseract', [file, 'stdout', '-l', LANG(), '--psm', String(psm), '--dpi', '300', 'tsv'], { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  )

/**
 * The light writing on bands of colour (a card's step titles, "1 PREP" on green; its times bar), read
 * one band at a time: the band's colour made white and its writing black, which Tesseract reads
 * easily – on the photo as it is, it mostly passes over them. Lines in 0–1 of the page.
 */
export async function bannerLines(data: Buffer, mime: string, dir: string): Promise<PrintLine[]> {
  const img = decodeImage(data, mime, 2400)
  if (!img) return []
  const { width: W, height: H, rgba } = img
  const colour = (x: number, y: number) => {
    const i = (y * W + x) * 4
    const mx = Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
    return mx - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) >= 45 && mx >= 60
  }
  const writing = (x: number, y: number) => {
    const i = (y * W + x) * 4
    const mn = Math.min(rgba[i], rgba[i + 1], rgba[i + 2])
    return mn >= 150 && Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - mn < 60
  }
  const rowColour = (y: number, x0: number, x1: number) => {
    let n = 0
    for (let x = x0; x < x1; x += 2) if (colour(x, y)) n++
    return n / Math.max(1, (x1 - x0) / 2)
  }
  // each band's full height (its writing's rows are less coloured than its plain ones), split where
  // the colour stops right the way down – banners side by side, one over each column of a card
  const pieces: { x: number; y: number; w: number; h: number }[] = []
  for (const b of colourBands(img).slice(0, 24)) {
    let y0 = b.y
    let y1 = b.y + b.h
    while (y0 > 0 && b.y - y0 < b.h * 2 && rowColour(y0 - 1, b.x, b.x + b.w) >= 0.4) y0--
    while (y1 < H && y1 - b.y - b.h < b.h * 2 && rowColour(y1, b.x, b.x + b.w) >= 0.4) y1++
    let start = -1
    let blank = 0
    for (let x = b.x; x <= b.x + b.w; x++) {
      let n = 0
      if (x < b.x + b.w) for (let y = y0; y < y1; y++) if (colour(x, y)) n++
      const coloured = x < b.x + b.w && n >= (y1 - y0) * 0.15
      if (coloured) {
        if (start < 0) start = x
        blank = 0
      } else if (start >= 0 && (++blank >= 6 || x === b.x + b.w)) {
        const end = x - blank + 1
        const piece = { x: start, y: y0, w: end - start, h: y1 - y0 }
        const overlap = (q: typeof piece) => Math.max(0, Math.min(q.x + q.w, piece.x + piece.w) - Math.max(q.x, piece.x)) * Math.max(0, Math.min(q.y + q.h, piece.y + piece.h) - Math.max(q.y, piece.y))
        // (and not one already found)
        if (piece.w >= piece.h * 2 && !pieces.some((q) => overlap(q) >= piece.w * piece.h * 0.5)) pieces.push(piece)
        start = -1
        blank = 0
      }
    }
  }
  if (!pieces.length) return []
  // all of them in one picture, one under another (one run of Tesseract): the colour white, the
  // writing black, each enlarged to be at least ~70 px tall
  const pad = 20
  const placed = pieces.map((p) => ({ ...p, z: Math.min(3, Math.max(1, Math.ceil(70 / p.h))), top: 0 }))
  const cw = Math.max(...placed.map((p) => p.w * p.z)) + pad * 2
  let chh = pad
  for (const p of placed) {
    p.top = chh
    chh += p.h * p.z + pad * 2
  }
  const gray = new Uint8Array(cw * chh).fill(255)
  for (const p of placed)
    for (let y = p.y; y < p.y + p.h; y++) {
      if (rowColour(y, p.x, p.x + p.w) < 0.4) continue
      // only what's between the colour's ends on this row: not the page round the band, its edges
      let a = p.x
      let b = p.x + p.w - 1
      while (a < b && !colour(a, y)) a++
      while (b > a && !colour(b, y)) b--
      for (let x = a + 3; x < b - 3; x++) {
        if (!writing(x, y)) continue
        for (let dy = 0; dy < p.z; dy++) {
          const row = (p.top + (y - p.y) * p.z + dy) * cw + pad
          gray.fill(0, row + (x - p.x) * p.z, row + (x - p.x + 1) * p.z)
        }
      }
    }
  const file = path.join(dir, 'banners.png')
  fs.writeFileSync(file, grayPng(cw, chh, gray))
  const out: PrintLine[] = []
  for (const l of linesFromTsv(await runTesseract(file, 6))) {
    const cy = (l.y + l.h / 2) * chh
    const p = placed.find((q) => cy >= q.top && cy < q.top + q.h * q.z)
    // a banner's edge read as a bar or a letter
    const text = l.text.replace(/^(?:[^\p{L}\p{N}]+|[a-z])\s+(?=[\p{Lu}\p{N}])/u, '').replace(/\s+[^\p{L}\p{N}]+$/u, '').replace(/^(\d+\s.*\p{L})\s+[\d&]$/u, '$1').trim()
    const letters = text.replace(/[^\p{L}]/gu, '').length
    // (a band in a photo of food reads as scraps)
    if (!p || l.conf < 50 || letters < 3 || letters < text.replace(/\s/g, '').length * 0.5) continue
    const toX = (v: number) => (p.x + (v * cw - pad) / p.z) / W
    const toY = (v: number) => (p.y + (v * chh - p.top) / p.z) / H
    out.push({
      text,
      conf: l.conf,
      x: toX(l.x),
      y: toY(l.y),
      w: (l.w * cw) / p.z / W,
      h: (l.h * chh) / p.z / H,
      words: l.words.map((w) => ({ x: toX(w.x), y: toY(w.y), w: (w.w * cw) / p.z / W, h: (w.h * chh) / p.z / H })),
    })
  }
  return out
}

/** Tesseract's lines with the banners' writing put in: a banner's reading replaces anything read inside it. */
export function withBanners(lines: PrintLine[], banners: PrintLine[]): PrintLine[] {
  const inside = (l: PrintLine, b: PrintLine) => {
    const cx = l.x + l.w / 2
    const cy = l.y + l.h / 2
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y - b.h * 0.3 && cy <= b.y + b.h * 1.2
  }
  const letters = (t: string) => t.toLowerCase().replace(/[^\p{L}]/gu, '')
  // read the same both ways: the page's reading (it had the whole line to go on: "4 COOK VEGGIES",
  // where the banner alone read "“COOK VEGGIES")
  const kept = banners.filter((b) => !lines.some((l) => inside(l, b) && letters(l.text) === letters(b.text)))
  return [...lines.filter((l) => !kept.some((b) => inside(l, b))), ...kept]
}

/** A word Tesseract may have made of a small fraction: "%", "¥%", "Y2", "Ye", "Vz"… */
const SUSPECT = /(?:^|[\s|(])(?:[%¥][%¥\w]?|\d+[%¥]|[YV][a-z0-9%]?|\d?%)(?=[\s|)]|-inch|$|oz\b|cups?\b)/i
/** …on a line with amounts (a unit, "of the onion", a column bar), where it would be a fraction. */
const AMOUNTS = /\b(?:oz|cups?|tbsp|tsp|lbs?|g|ml|inch|cloves?|of the|of a)\b|-inch|\|/i
export const suspectLine = (line: string) => SUSPECT.test(line) && AMOUNTS.test(line)

/** "Y2" and its like are always ½ (the fraction's own shapes); the others need a look at the photo. */
export const plainFractions = (line: string) => line.replace(/(^|[\s|(])(?:Y2|Yz|V2|Vz|Y½)(?=[\s|)]|-inch|$)/g, '$1½')

/**
 * Tesseract's usual slips on a recipe card: "10z" for 1oz, "ltsp" for 1 tsp, "\|" for a bar – and, on
 * a card with a column for each number of people, the bar between the columns read as a slash
 * ("1/1", "1/2" for 1 | 1, 1 | 2: a cell with nothing else in it).
 */
export function tidyPrint(text: string): string {
  const columns = /\d\s*-?\s*(?:person|people|servings?)\s*\|/i.test(text)
  return text
    .split('\n')
    .map((l) => {
      let t = l
        .replace(/\\\|/g, '|')
        // "10z", "200z", "1o0z", "20 0z": oz
        .replace(/(\d)[oO]?0z\b/g, '$1 oz')
        .replace(/(\d)\s+[0O]z\b/g, '$1 oz')
        // "1O MIN": 10
        .replace(/(\d)O\b/g, '$10')
        .replace(/\b(\d+)(oz|tsp|tbsp|cups?)\b/gi, '$1 $2')
        .replace(/(^|[\s|(])l\s?(tsp|tbsp|cups?|oz)\b/gi, '$11 $2')
      if (columns) {
        t = t.replace(/^\s*(\d+)\s*\/\s*(\d+)\s*$/, '$1 | $2')
        // the bar read as a 1 ("111", "214", "2 | 14"): the second amount is the same or twice the first
        const same = (a: string, b: string) => b === a || Number(b) === Number(a) * 2
        t = t.replace(/^\s*(\d)1(\d)\s*$/, (m, a: string, b: string) => (same(a, b) ? `${a} | ${b}` : m))
        t = t.replace(/^\s*(\d)\s*\|\s*1(\d)\s*$/, (m, a: string, b: string) => (same(a, b) ? `${a} | ${b}` : m))
      }
      return t
    })
    .join('\n')
}

/** Two strings' edit distance (how many letters differ). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}
/** A line without the words Tesseract may have made of a small fraction ("VY," "Ve" "Y%" "Ys" "%"). */
const withoutFractionScraps = (t: string) =>
  t
    .split(/\s+/)
    .map((w) => w.replace(/^[(]?(?:[YV][a-z0-9%]?|[%¥]+|\d?[%¥])[,.;)]?(?=$|-)/i, ''))
    .join(' ')
const lettersOf = (t: string) => t.toLowerCase().replace(/[^\p{L}]/gu, '')
/** Nothing but an amount: numbers, fractions, units and bars ("1 | 2", "½ oz | 1 oz", "3 TBSP | 6 TBSP"). */
const AMOUNT_ONLY = /^[\d½¼¾⅓⅔⅛\s|.,/]*(?:(?:oz|cups?|tbsp|tsp|lbs?|g|ml|cloves?|cans?|pieces?|units?|pkgs?|slices?)\b[\d½¼¾⅓⅔⅛\s|.,/]*)*$/i
const isAmount = (t: string) => AMOUNT_ONLY.test(t.trim()) && /[\d½¼¾⅓⅔⅛]/.test(t)

/**
 * Bits of icons and pictures read as letters ("titi", "eR", "#", "(", a chili read as "pf"), and the
 * marks in front of lines (bullets read as « ¢ * +, the little circled icons as © @): out.
 */
export function withoutScraps(lines: PrintLine[]): PrintLine[] {
  const SHORT_WORDS = /^(?:a|an|as|at|be|by|do|go|if|in|is|it|me|my|no|of|on|or|so|to|up|us|we)$/i
  return lines
    .map((l) => {
      let t = l.text
        // a little icon (©, @, ®) at the start: gone; a bullet read as something else: a bullet
        .replace(/^(?:[©®@]\s*)+/, '')
        .replace(/^(?:\[=\]|[«»*¢+•]|-(?=\s))\s+/, '• ')
        // ("& 6 FINISH & SERVE": a mark before a step's number)
        .replace(/^&\s+(?=\d)/, '')
        // an icon's scrap at the end ("Jalapeno pf")
        .replace(/\s+([a-z]{1,2})$/, (m, w: string) => (SHORT_WORDS.test(w) || l.text.split(/\s+/).length > 4 ? m : ''))
        .trim()
      // a box's edges read as bars ("|  BUST OUT  |")
      if (/^\|[^|]+\|?$|^[^|]+\|$/.test(t)) t = t.replace(/^\|\s*|\s*\|$/g, '')
      return { ...l, text: t }
    })
    .filter((l) => {
      const t = l.text
      if (!/[\p{L}\p{N}]/u.test(t)) return false
      // one letter or figure on its own: an icon's scrap, a page number
      if (/^[\p{L}\p{N}]$/u.test(t)) return false
      // read with little confidence, no number and no real word in it
      if (l.conf < 60 && !/\d/.test(t) && !/\p{L}{5,}/u.test(t)) return false
      return true
    })
}

/**
 * Close-ups for the vision model: each doubtful line (a fraction Tesseract can't read, a grid amount
 * read with little confidence) cut out of the photo and enlarged, all in one picture, one under
 * another, with what Tesseract read; and where a grid's ingredient has no amount read above it
 * (when the others in its row do), the place it would be. What it says is taken only if the words are
 * Tesseract's (give or take a slip) – or, for an amount, if it's only an amount.
 */
export async function closeUps(ai: Ai, data: Buffer, mime: string, lines: PrintLine[]): Promise<PrintLine[]> {
  if (!ai.canImages) return lines
  const grid = lines.some((l) => /\d\s*-?\s*(?:person|people|servings?)\s*\|/i.test(l.text))
  const doubtful = (l: PrintLine) => suspectLine(l.text) || (grid && /\d/.test(l.text) && l.text.length <= 24 && (l.conf < 75 || /^\d{3}$|\|\s*1\d\b|\d[0oO]z\b/.test(l.text)))
  type Ask = { box: { x: number; y: number; w: number; h: number }; read: string; line?: PrintLine }
  const asks: Ask[] = lines.filter(doubtful).map((l) => ({ box: l, read: l.text, line: l }))
  if (grid) {
    const above = (n: PrintLine) =>
      lines.find((a) => a !== n && Math.abs(a.x + a.w / 2 - (n.x + n.w / 2)) < Math.max(a.w, n.w) / 2 && a.y + a.h <= n.y + n.h * 0.3 && a.y + a.h >= n.y - n.h * 2.2)
    const names = lines.filter((l) => /^\p{L}[\p{L}\s'’&-]{2,28}$/u.test(l.text))
    for (const n of names) {
      if (above(n)) continue
      // others in its row, with an amount above them
      const sib = names.map((m) => (m !== n && Math.abs(m.y - n.y) < n.h * 0.6 ? above(m) : undefined)).find((a) => a && isAmount(a.text))
      if (!sib) continue
      const w = sib.w * 1.4
      asks.push({ box: { x: n.x + n.w / 2 - w / 2, y: sib.y, w, h: sib.h }, read: '' })
    }
  }
  if (!asks.length) return lines
  const img = decodeImage(data, mime, 4000)
  if (!img) return lines
  const W = img.width
  const H = img.height
  const strips = asks.slice(0, 30).map((a) => {
    const padY = a.box.h * 0.5
    const padX = a.box.h * 0.8
    const x0 = Math.max(0, Math.floor((a.box.x - padX) * W))
    const y0 = Math.max(0, Math.floor((a.box.y - padY) * H))
    const x1 = Math.min(W - 1, Math.ceil((a.box.x + a.box.w + padX) * W))
    const y1 = Math.min(H - 1, Math.ceil((a.box.y + a.box.h + padY) * H))
    return { ...a, x0, y0, w: x1 - x0, h: y1 - y0 }
  })
  const out = [...lines]
  let taken = 0
  let lastReply = ''
  // a few at a time: a small vision model loses count of many strips
  for (let start = 0; start < strips.length; start += 6) {
    const batch = strips.slice(start, start + 6)
    // each enlarged to about 64 px tall (no wider than 1500), 40 px of white between
    const gap = 40
    const sized = batch.map((b) => ({ ...b, z: Math.min(64 / b.h, 1500 / b.w) }))
    const cw = Math.ceil(Math.max(...sized.map((b) => b.w * b.z))) + gap
    const tops: number[] = []
    let chh = gap
    for (const b of sized) {
      tops.push(chh)
      chh += Math.ceil(b.h * b.z) + gap
    }
    const gray = new Uint8Array(cw * chh).fill(255)
    sized.forEach((b, k) => {
      const tw = Math.ceil(b.w * b.z)
      const th = Math.ceil(b.h * b.z)
      for (let j = 0; j < th; j++)
        for (let i = 0; i < tw; i++) {
          const sx = Math.min(W - 2, b.x0 + i / b.z)
          const sy = Math.min(H - 2, b.y0 + j / b.z)
          const fx = sx - Math.floor(sx)
          const fy = sy - Math.floor(sy)
          const v = (x: number, y: number) => {
            const q = (y * W + x) * 4
            return img.rgba[q] * 0.3 + img.rgba[q + 1] * 0.59 + img.rgba[q + 2] * 0.11
          }
          const x = Math.floor(sx)
          const y = Math.floor(sy)
          gray[(tops[k] + j) * cw + gap / 2 + i] = v(x, y) * (1 - fx) * (1 - fy) + v(x + 1, y) * fx * (1 - fy) + v(x, y + 1) * (1 - fx) * fy + v(x + 1, y + 1) * fx * fy
        }
    })
    const prompt = `This picture is ${batch.length} strips cut from a photo of a printed page, one under another, top to bottom. Each strip is one line of print – some only an amount, like "1 | 2" or "½ oz | 1 oz". OCR read them as:
${batch.map((b, k) => `${k + 1}: ${b.read || '(nothing)'}`).join('\n')}

Write what each strip actually says, exactly as printed: small fractions as ½ ¼ ¾ ⅓ ⅔ ⅛, the bar between two amounts as |.${grid ? ' On this page the amounts are given for two numbers of people, two amounts with a bar between them ("1 | 2", "¼ oz | ½ oz").' : ''} Change nothing else. Reply with JSON only: {"1": "…", "2": "…"}`
    let fixed: Record<string, unknown> = {}
    try {
      const reply = await ai.lookAtPhoto(grayPng(cw, chh, gray), 'image/png', prompt)
      lastReply = reply
      const json = /\{[\s\S]*\}/.exec(reply.replace(/<think>[\s\S]*?<\/think>/g, ''))?.[0]
      fixed = json ? (JSON.parse(json) as Record<string, unknown>) : {}
    } catch (e) {
      log.warn(`close-ups of the print couldn't be read: ${(e as Error).message}`)
      continue
    }
    batch.forEach((b, k) => {
      const f = fixed[String(k + 1)]
      if (typeof f !== 'string' || !f.trim()) return
      const t = f.trim()
      // the words compared without what was doubtful (a fraction misread as "VY," "Ye" "%" is letters too)
      const was = lettersOf(withoutFractionScraps(b.read))
      const now = lettersOf(withoutFractionScraps(t))
      const ok =
        was.length >= 3
          ? distance(now, was) <= Math.max(2, Math.round(was.length * 0.15))
          : // an amount for an amount – on a page with two columns of them, both ("7" for "1 | 1", "½" for "1 | 2": no)
            isAmount(t) && (!grid || /\|/.test(t))
      if (!ok) return
      if (t !== b.read) taken++
      if (b.line) {
        const i = out.indexOf(b.line)
        if (i >= 0) out[i] = { ...b.line, text: t }
      } else out.push({ text: t, conf: 80, x: b.box.x, y: b.box.y, w: b.box.w, h: b.box.h, words: [{ ...b.box }] })
    })
  }
  log.info(`close-ups of the print: ${taken} of ${strips.length} doubtful lines put right by the vision model`)
  if (!taken && lastReply) log.info(`close-ups: the vision model's last reply was ${JSON.stringify(lastReply.slice(0, 400))}`)
  return out
}

/**
 * A photo of a printed page read by Tesseract, in reading order, its doubtful bits looked at close up:
 * the text and how sure Tesseract was (0–100). null: Tesseract isn't installed, or found next to nothing.
 */
export async function readPrintedPhoto(ai: Ai, data: Buffer, mime: string): Promise<{ text: string; confidence: number; agent: string } | null> {
  const read = await tesseractLines(data, mime)
  if (!read || read.reduce((n, l) => n + l.text.replace(/[^\p{L}]/gu, '').length, 0) < 30) return null
  const lines = await closeUps(ai, data, mime, withoutScraps(read))
  const text = tidyPrint(readingOrderText(lines)).split('\n').map(plainFractions).join('\n')
  const confidence = read.reduce((s, l) => s + l.conf * l.text.length, 0) / Math.max(1, read.reduce((s, l) => s + l.text.length, 0))
  return { text, confidence, agent: 'Tesseract (on the server)' }
}
