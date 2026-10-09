/**
 * PDF manuals into sections
 * =========================
 *
 * A manual that's a PDF (a game manual, a datasheet) is read here, without
 * the AI: each line's text and its font size. Text bigger than the body is a
 * heading (the biggest sizes chapters, the next sections…); the headers and
 * footers repeated on every page and the page numbers are left out; lines are
 * joined back into paragraphs (and words hyphenated across lines into
 * words), bullets into lists. The result: the manual's sections, each as a
 * small HTML page, which the web import turns into notes like any guide.
 */

import path from 'node:path'
import { createRequire } from 'node:module'

interface Line {
  text: string
  size: number
  bold: boolean
  y: number
  x: number
  page: number
  /** the gap above it, in line heights */
  gap: number
  /** a figure (a picture of that part of the page) in place of text */
  figure?: { png: Buffer; alt: string }
}

export interface PdfSection {
  title: string
  html: string
  /** pages it's on (1-based) */
  pages: [number, number]
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A caption: "Figure 8-3 BUMPER coverage requirements", "Fig. 2.1 …", "Image 4". */
const CAPTION = /^(?:figure|fig\.|image|diagram|illustration)\s*[A-Z]?\d+(?:[-.–]\d+)*\b/i

/** pdfjs's matrix product (m1 then m2 applied): the transform of an image in page space. */
const mul = (m1: number[], m2: number[]) => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
]

/** A box on a page, in PDF units (y up). */
interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** pdfjs draws on these (it needs a canvas for patterns and masks too). */
class CanvasFactory {
  constructor(private napi: typeof import('@napi-rs/canvas')) {}
  create(width: number, height: number) {
    const canvas = this.napi.createCanvas(Math.max(1, width), Math.max(1, height))
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(c: { canvas: { width: number; height: number } }, width: number, height: number) {
    c.canvas.width = width
    c.canvas.height = height
  }
  destroy(c: { canvas: { width: number; height: number } | null; context: unknown }) {
    if (c.canvas) (c.canvas.width = 0), (c.canvas.height = 0)
    c.canvas = null
    c.context = null
  }
}

/** The PDF's lines, page by page (headers, footers and page numbers left out) – and its figures, as pictures. */
async function readLines(data: Buffer): Promise<{ lines: Line[]; title: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // drawing the figures needs @napi-rs/canvas; without it, the text only
  const napi = await import('@napi-rs/canvas').catch(() => null)
  const require = createRequire(import.meta.url)
  const fonts = (() => {
    try {
      return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep
    } catch {
      return undefined
    }
  })()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    ...(fonts ? { standardFontDataUrl: fonts } : {}),
    ...(napi ? { CanvasFactory: class extends CanvasFactory { constructor() { super(napi!) } } } : {}),
  } as Parameters<typeof pdfjs.getDocument>[0]).promise
  const info = (await doc.getMetadata().catch(() => null))?.info as { Title?: string } | undefined
  const lines: Line[] = []
  /** each page's pictures (embedded images), for finding figures */
  const imageBoxes = new Map<number, Box[]>()
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const styles = content.styles as Record<string, { fontFamily?: string }>
    // items into lines: the same baseline (within a little)
    const rows: { y: number; x: number; size: number; bold: boolean; parts: { x: number; s: string }[] }[] = []
    for (const it of content.items as { str: string; transform: number[]; fontName: string; width: number }[]) {
      if (!it.str) continue
      const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10
      const x = it.transform[4]
      const y = it.transform[5]
      const bold = /bold|black|heavy|semibold/i.test(`${it.fontName} ${styles[it.fontName]?.fontFamily ?? ''}`)
      let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, size * 0.35))
      if (!row) rows.push((row = { y, x, size: 0, bold: true, parts: [] }))
      if (it.str.trim()) {
        row.size = Math.max(row.size, size)
        row.bold &&= bold
      }
      row.x = Math.min(row.x, x)
      row.parts.push({ x, s: it.str })
    }
    rows.sort((a, b) => b.y - a.y)
    let prevY: number | null = null
    let prevSize = 0
    for (const r of rows) {
      const text = r.parts
        .sort((a, b) => a.x - b.x)
        .map((q) => q.s)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      const gap = prevY === null ? 9 : (prevY - r.y) / Math.max(prevSize, r.size, 1)
      lines.push({ text, size: r.size, bold: r.bold, y: r.y, x: r.x, page: p, gap })
      prevY = r.y
      prevSize = r.size
    }
    // where its pictures are: each image's unit square through the transforms in force
    if (napi) {
      const ops = await page.getOperatorList().catch(() => null)
      const boxes: Box[] = []
      if (ops) {
        const O = pdfjs.OPS
        let ctm = [1, 0, 0, 1, 0, 0]
        const stack: number[][] = []
        ops.fnArray.forEach((fn, i) => {
          const args = ops.argsArray[i] as unknown[]
          if (fn === O.save) stack.push(ctm)
          else if (fn === O.restore) ctm = stack.pop() ?? ctm
          else if (fn === O.transform) ctm = mul(ctm, args as number[])
          else if (fn === O.paintFormXObjectBegin) {
            stack.push(ctm)
            if (Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0] as number[])
          } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
          else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
            const pts = [
              [0, 0],
              [1, 0],
              [0, 1],
              [1, 1],
            ].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]])
            boxes.push({ x0: Math.min(...pts.map((q) => q[0])), x1: Math.max(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), y1: Math.max(...pts.map((q) => q[1])) })
          }
        })
      }
      imageBoxes.set(p, boxes)
    }
    page.cleanup()
  }
  // the same line at the top or bottom of most pages (a running header or footer), and page numbers
  const norm = (t: string) => t.replace(/\d+/g, '#').toLowerCase()
  const edge = new Map<string, Set<number>>()
  const byPage = new Map<number, Line[]>()
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l])
  for (const [p, ls] of byPage) for (const l of [...ls.slice(0, 2), ...ls.slice(-2)]) edge.set(norm(l.text), (edge.get(norm(l.text)) ?? new Set()).add(p))
  const repeated = new Set([...edge].filter(([, pages]) => pages.size >= Math.max(3, doc.numPages * 0.4)).map(([t]) => t))
  let kept = lines.filter((l) => {
    const ls = byPage.get(l.page)!
    const atEdge = ls.indexOf(l) < 2 || ls.indexOf(l) >= ls.length - 2
    if (atEdge && repeated.has(norm(l.text))) return false
    if (atEdge && /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text)) return false
    return true
  })
  if (napi) kept = await withFigures(doc, kept, imageBoxes, napi)
  return { lines: kept, title: info?.Title?.trim() ?? '', pages: doc.numPages }
}

/**
 * The figures, as pictures where they are on the page: below (or above) each
 * "Figure …" caption, down to the next line of body text – drawings made of
 * lines and shapes as much as embedded pictures – and pictures without a
 * caption (not the logo on every page). The words inside a figure (its labels)
 * are in the picture, so they leave the text.
 */
async function withFigures(
  doc: { numPages: number; getPage(n: number): Promise<{ view: number[]; getViewport(o: { scale: number }): { width: number; height: number; convertToViewportRectangle(r: number[]): number[] }; render(o: object): { promise: Promise<void> }; cleanup(): void }> },
  lines: Line[],
  imageBoxes: Map<number, Box[]>,
  napi: typeof import('@napi-rs/canvas'),
): Promise<Line[]> {
  // the body text: its size, and the left edges paragraphs start at
  const chars = new Map<number, number>()
  for (const l of lines) chars.set(l.size, (chars.get(l.size) ?? 0) + l.text.length)
  const body = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10
  const bodyLines = lines.filter((l) => Math.abs(l.size - body) < 0.6)
  const xs = new Map<number, number>()
  for (const l of bodyLines) xs.set(Math.round(l.x), (xs.get(Math.round(l.x)) ?? 0) + 1)
  const margins = [...xs].filter(([, n]) => n >= Math.max(2, bodyLines.length * 0.03)).map(([x]) => x)
  if (!margins.length) return lines
  const left = Math.min(...margins)
  const isBody = (l: Line) => Math.abs(l.size - body) < 0.6 && margins.some((m) => Math.abs(l.x - m) < 4) && !CAPTION.test(l.text)
  // the same picture in the same place on many pages: a logo
  const seen = new Map<string, number>()
  for (const boxes of imageBoxes.values()) for (const b of boxes) {
    const k = [b.x0, b.y0, b.x1, b.y1].map(Math.round).join(',')
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const out: Line[] = []
  const byPage = new Map<number, Line[]>()
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l])
  for (const p of [...new Set(lines.map((l) => l.page)), ...imageBoxes.keys()].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)) {
    const ls = byPage.get(p) ?? []
    const page = await doc.getPage(p)
    const [, , width] = page.view
    const lowest = ls.length ? Math.min(...ls.map((l) => l.y)) - 6 : page.view[1] + 36
    const pics = (imageBoxes.get(p) ?? []).filter(
      (b) => b.x1 - b.x0 >= 50 && b.y1 - b.y0 >= 30 && (seen.get([b.x0, b.y0, b.x1, b.y1].map(Math.round).join(',')) ?? 0) < 3,
    )
    // a line a figure ends at: body text, a heading, another caption
    const stops = (l: Line) => isBody(l) || l.size > body * 1.1 || CAPTION.test(l.text)
    /** each figure: where it may be, best first (the first with something drawn in it is used) */
    const wanted: { alt: string; boxes: Box[] }[] = []
    const used = new Set<Box>()
    ls.forEach((c, i) => {
      if (!CAPTION.test(c.text) || c.text.length > 160) return
      const options: Box[] = []
      // a picture right above or below the caption: that's it
      const near = pics.filter((b) => !used.has(b) && ((b.y0 >= c.y - 2 && b.y0 - (c.y + c.size) < 40) || (b.y1 <= c.y + c.size && c.y - b.y1 < 40)))
      if (near.length) {
        near.forEach((b) => used.add(b))
        options.push({ x0: Math.min(...near.map((b) => b.x0)) - 2, x1: Math.max(...near.map((b) => b.x1)) + 2, y0: Math.min(...near.map((b) => b.y0)) - 2, y1: Math.max(...near.map((b) => b.y1)) + 2 })
      }
      // a drawing: below the caption down to the next line of text, or above it up to the line before
      const next = ls.slice(i + 1).find(stops)
      const prev = ls.slice(0, i).reverse().find(stops)
      const below = { x0: left - 6, x1: width - left + 6, y1: c.y - c.size * 0.35, y0: next ? next.y + next.size * 0.95 : lowest }
      const above = { x0: left - 6, x1: width - left + 6, y1: prev ? prev.y - prev.size * 0.3 : page.view[3] - 36, y0: c.y + c.size * 1.05 }
      for (const o of [below, above]) if (o.y1 - o.y0 >= 30) options.push(o)
      if (options.length) wanted.push({ alt: c.text, boxes: options })
    })
    // pictures with no caption
    for (const b of pics) if (!used.has(b)) wanted.push({ alt: 'Picture', boxes: [{ x0: b.x0 - 2, x1: b.x1 + 2, y0: b.y0 - 2, y1: b.y1 + 2 }] })
    if (!wanted.length) {
      out.push(...ls)
      page.cleanup()
      continue
    }
    // the page, drawn at twice its size; each figure cut out of it
    const scale = 2
    const viewport = page.getViewport({ scale })
    const canvas = napi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    try {
      await page.render({ canvasContext: ctx, viewport }).promise
    } catch {
      out.push(...ls)
      page.cleanup()
      continue
    }
    const regions: (Box & { alt: string })[] = []
    const figures: Line[] = []
    for (const w of wanted) {
      for (const r of w.boxes) {
        const [ax, ay, bx, by] = viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1])
        const sx = Math.max(0, Math.floor(Math.min(ax, bx)))
        const sy = Math.max(0, Math.floor(Math.min(ay, by)))
        const sw = Math.min(canvas.width - sx, Math.ceil(Math.abs(bx - ax)))
        const sh = Math.min(canvas.height - sy, Math.ceil(Math.abs(by - ay)))
        if (sw < 20 || sh < 20) continue
        // something drawn there (not a blank strip of page)?
        const px = ctx.getImageData(sx, sy, sw, sh).data
        let ink = 0
        let n = 0
        for (let k = 0; k < px.length; k += 4 * 7) {
          n++
          if (px[k] < 235 || px[k + 1] < 235 || px[k + 2] < 235) ink++
        }
        if (ink / n < 0.02) continue
        const cut = napi.createCanvas(sw, sh)
        cut.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
        regions.push({ ...r, alt: w.alt })
        figures.push({ text: '', size: body, bold: false, y: r.y1, x: r.x0, page: p, gap: 9, figure: { png: cut.toBuffer('image/png'), alt: w.alt } })
        break
      }
    }
    page.cleanup()
    // the page's lines without the figures' labels, and the figures, top to bottom
    const inFigure = (l: Line) => regions.some((r) => l.y < r.y1 && l.y > r.y0 && l.x >= r.x0 - 2 && l.x <= r.x1)
    out.push(...[...ls.filter((l) => !inFigure(l)), ...figures].sort((a, b) => b.y - a.y))
  }
  return out
}

/** The manual's sections: split at its biggest headings (or by pages, if it has none). */
export async function pdfSections(data: Buffer): Promise<{ title: string; sections: PdfSection[]; pages: number }> {
  const { lines, title: metaTitle, pages } = await readLines(data)
  if (!lines.length) throw new Error('No text in this PDF (it may be scanned pictures of pages) – it was kept as a file instead.')
  // the body's size: the one most of the text is in
  const chars = new Map<number, number>()
  for (const l of lines) chars.set(l.size, (chars.get(l.size) ?? 0) + l.text.length)
  const body = [...chars].sort((a, b) => b[1] - a[1])[0][0]
  // headings: bigger than the body (or bold on a line of its own), short, not a sentence
  const isHeading = (l: Line) => l.text.length <= 140 && !/[.,;:]$/.test(l.text) && /\p{L}/u.test(l.text) && (l.size >= body * 1.12 || (l.bold && l.gap > 1.4 && l.size >= body && l.text.length <= 90))
  const headSizes = [...new Set(lines.filter(isHeading).map((l) => l.size))].sort((a, b) => b - a)
  const level = (l: Line) => Math.min(3, headSizes.indexOf(l.size) + 1) || 3

  // blocks: headings, list items and paragraphs
  type Block = { kind: 'h'; level: number; text: string; page: number } | { kind: 'p' | 'li'; text: string; page: number } | { kind: 'img'; png: Buffer; alt: string; page: number }
  const blocks: Block[] = []
  const BULLET = /^([•◦▪●○■□–\-*]|\(?[a-z0-9]{1,3}[.)])\s+/i
  // how long a full line of body text usually is (a shorter one can end a paragraph)
  const bodyLens = lines.filter((l) => l.size === body && !l.figure).map((l) => l.text.length).sort((a, b) => a - b)
  const typical = bodyLens[Math.floor(bodyLens.length * 0.75)] ?? 80
  let prev: Line | null = null
  for (const l of lines) {
    if (l.figure) {
      blocks.push({ kind: 'img', png: l.figure.png, alt: l.figure.alt, page: l.page })
      prev = null
      continue
    }
    const last = blocks[blocks.length - 1]
    const before = prev
    prev = l
    if (isHeading(l)) {
      // a heading over two lines
      if (last?.kind === 'h' && l.gap < 1.6 && level(l) === last.level) last.text += ` ${l.text}`
      else blocks.push({ kind: 'h', level: level(l), text: l.text, page: l.page })
      continue
    }
    const bullet = BULLET.exec(l.text)
    // a rule's number ("R12.", "G301.") isn't a list marker: it's what the rule is called
    if (bullet && !/^[a-z]{1,3}\d{1,4}[.)]$/i.test(bullet[1]) && (/^[•◦▪●○■□–\-*]$/.test(bullet[1]) || l.gap > 1.2)) {
      blocks.push({ kind: 'li', text: l.text.slice(bullet[0].length), page: l.page })
      continue
    }
    // a new paragraph: a rule starts its own (G302 …), and so does the line after
    // a short one that ends a sentence (the paragraph above ended there)
    const startsRule = /^[A-Z]{1,3}\d{2,4}\b/.test(l.text)
    const prevEnded = Boolean(before && /[.!?:]$/.test(before.text) && before.text.length < typical * 0.7)
    // carries on the paragraph above (close below it), else a new one
    if (last && (last.kind === 'p' || last.kind === 'li') && l.gap < 1.6 && l.page === last.page && !startsRule && !prevEnded) {
      last.text = /[\p{L}]-$/u.test(last.text) ? last.text.slice(0, -1) + l.text : `${last.text} ${l.text}`
    } else if (last && (last.kind === 'p' || last.kind === 'li') && l.page !== last.page && !/[.!?:]$/.test(last.text) && /^\p{Ll}/u.test(l.text) && !startsRule) {
      // a sentence that runs on to the next page
      last.text = `${last.text} ${l.text}`
    } else blocks.push({ kind: 'p', text: l.text, page: l.page })
  }

  // the sections: at the biggest headings that split it into several parts
  const splitLevel = [1, 2, 3].find((lv) => blocks.filter((b) => b.kind === 'h' && b.level === lv).length >= 2)
  const parts: Block[][] = []
  if (splitLevel) {
    for (const b of blocks) {
      if (b.kind === 'h' && b.level <= splitLevel) parts.push([b])
      else if (parts.length) parts[parts.length - 1].push(b)
      else parts.push([b])
    }
  } else {
    // no headings to go by: about ten pages a part
    for (const b of blocks) {
      const n = Math.floor((b.page - 1) / 10)
      ;(parts[n] ??= []).push(b)
    }
  }
  const docTitle = metaTitle || (blocks.find((b) => b.kind === 'h')?.text ?? 'PDF')
  const sections: PdfSection[] = parts
    .filter((p) => p && p.length)
    .map((p, i) => {
      const head = p[0].kind === 'h' ? p[0].text : splitLevel ? (i === 0 ? docTitle : `Part ${i + 1}`) : `Pages ${p[0].page}–${p[p.length - 1].page}`
      let html = ''
      let inList = false
      for (const [j, b] of p.entries()) {
        if (b.kind !== 'li' && inList) (html += '</ul>'), (inList = false)
        if (b.kind === 'h') html += `<h${j === 0 ? 1 : Math.min(6, b.level - (splitLevel ?? 1) + 1 + 0)}>${esc(b.text)}</h${j === 0 ? 1 : Math.min(6, b.level - (splitLevel ?? 1) + 1 + 0)}>`
        else if (b.kind === 'li') {
          if (!inList) (html += '<ul>'), (inList = true)
          html += `<li>${esc(b.text)}</li>`
        } else if (b.kind === 'img') html += `<p><img src="data:image/png;base64,${b.png.toString('base64')}" alt="${esc(b.alt).replace(/"/g, '&quot;')}"></p>`
        else html += `<p>${esc(b.text)}</p>`
      }
      if (inList) html += '</ul>'
      if (p[0].kind !== 'h') html = `<h1>${esc(head)}</h1>${html}`
      return { title: head.slice(0, 120), html: `<html><head><title>${esc(head)}</title></head><body><main>${html}</main></body></html>`, pages: [p[0].page, p[p.length - 1].page] as [number, number] }
    })
  return { title: docTitle, sections, pages }
}
