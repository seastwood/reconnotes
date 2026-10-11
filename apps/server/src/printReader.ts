import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { readingOrderText } from '@reconnotes/core'
import type { Ai } from './ai'
import { imageSize } from './images'
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
    const tsv = await new Promise<string>((resolve, reject) =>
      execFile('tesseract', [file, 'stdout', '-l', LANG(), '--psm', '3', '--dpi', '300', 'tsv'], { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    )
    return linesFromTsv(tsv)
  } catch (e) {
    log.warn(`tesseract couldn't read a photo: ${(e as Error).message}`)
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
        .replace(/\b(\d)0z\b/g, '$1 oz')
        .replace(/\b(\d+)(oz|tsp|tbsp)\b/gi, '$1 $2')
        .replace(/(^|[\s|(])l\s?(tsp|tbsp|cups?|oz)\b/gi, '$11 $2')
      if (columns) t = t.replace(/^\s*(\d+)\s*\/\s*(\d+)\s*$/, '$1 | $2')
      return t
    })
    .join('\n')
}

const words = (t: string) => (t.toLowerCase().match(/\p{L}{3,}/gu) ?? []).join(' ')

/**
 * The lines with a doubtful fraction, put right by the vision model looking at the photo – each
 * taken only if its words are all as Tesseract read them (just a fraction or number changed).
 */
async function fixFractions(ai: Ai, data: Buffer, mime: string, lines: string[]): Promise<string[]> {
  const doubtful = lines.map((l, i) => ({ l, i })).filter(({ l }) => suspectLine(l)).slice(0, 40)
  if (!doubtful.length || !ai.canImages) return lines
  const prompt = `These lines were read from this photo by OCR. In each, a small fraction (½ ¼ ¾ ⅓ ⅔ ⅛) or number may have been misread as %, ¥, Y, Ye, V2 or similar. Look at the photo and give each line back exactly as printed – change only a misread fraction or number, nothing else. Reply with JSON only: {"1": "…", "2": "…"}.

${doubtful.map(({ l }, k) => `${k + 1}: ${l}`).join('\n')}`
  try {
    const reply = await ai.lookAtPhoto(data, mime, prompt)
    const json = /\{[\s\S]*\}/.exec(reply.replace(/<think>[\s\S]*?<\/think>/g, ''))?.[0]
    const fixed = json ? (JSON.parse(json) as Record<string, unknown>) : {}
    const out = [...lines]
    doubtful.forEach(({ l, i }, k) => {
      const f = fixed[String(k + 1)]
      if (typeof f === 'string' && f.trim() && words(f) === words(l)) out[i] = f.trim()
    })
    return out
  } catch {
    return lines
  }
}

/**
 * A photo of a printed page read by Tesseract, in reading order, its fractions checked: the text and
 * how sure Tesseract was (0–100). null: Tesseract isn't installed, or found next to nothing.
 */
export async function readPrintedPhoto(ai: Ai, data: Buffer, mime: string): Promise<{ text: string; confidence: number; agent: string } | null> {
  const lines = await tesseractLines(data, mime)
  if (!lines || lines.reduce((n, l) => n + l.text.replace(/[^\p{L}]/gu, '').length, 0) < 30) return null
  const text = tidyPrint(readingOrderText(lines))
  const fixed = (await fixFractions(ai, data, mime, text.split('\n').map(plainFractions))).join('\n')
  const confidence = lines.reduce((s, l) => s + l.conf * l.text.length, 0) / Math.max(1, lines.reduce((s, l) => s + l.text.length, 0))
  return { text: fixed, confidence, agent: 'Tesseract (on the server)' }
}
