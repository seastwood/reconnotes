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

interface Line {
  text: string
  size: number
  bold: boolean
  y: number
  x: number
  page: number
  /** the gap above it, in line heights */
  gap: number
}

export interface PdfSection {
  title: string
  html: string
  /** pages it's on (1-based) */
  pages: [number, number]
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The PDF's lines, page by page (headers, footers and page numbers left out). */
async function readLines(data: Buffer): Promise<{ lines: Line[]; title: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise
  const info = (await doc.getMetadata().catch(() => null))?.info as { Title?: string } | undefined
  const lines: Line[] = []
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
    page.cleanup()
  }
  // the same line at the top or bottom of most pages (a running header or footer), and page numbers
  const norm = (t: string) => t.replace(/\d+/g, '#').toLowerCase()
  const edge = new Map<string, Set<number>>()
  const byPage = new Map<number, Line[]>()
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l])
  for (const [p, ls] of byPage) for (const l of [...ls.slice(0, 2), ...ls.slice(-2)]) edge.set(norm(l.text), (edge.get(norm(l.text)) ?? new Set()).add(p))
  const repeated = new Set([...edge].filter(([, pages]) => pages.size >= Math.max(3, doc.numPages * 0.4)).map(([t]) => t))
  const kept = lines.filter((l) => {
    const ls = byPage.get(l.page)!
    const atEdge = ls.indexOf(l) < 2 || ls.indexOf(l) >= ls.length - 2
    if (atEdge && repeated.has(norm(l.text))) return false
    if (atEdge && /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text)) return false
    return true
  })
  return { lines: kept, title: info?.Title?.trim() ?? '', pages: doc.numPages }
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
  type Block = { kind: 'h'; level: number; text: string; page: number } | { kind: 'p' | 'li'; text: string; page: number }
  const blocks: Block[] = []
  const BULLET = /^([•◦▪●○■□–\-*]|\(?[a-z0-9]{1,3}[.)])\s+/i
  // how long a full line of body text usually is (a shorter one can end a paragraph)
  const bodyLens = lines.filter((l) => l.size === body).map((l) => l.text.length).sort((a, b) => a - b)
  const typical = bodyLens[Math.floor(bodyLens.length * 0.75)] ?? 80
  let prev: Line | null = null
  for (const l of lines) {
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
    if (bullet && (/^[•◦▪●○■□–\-*]$/.test(bullet[1]) || l.gap > 1.2)) {
      blocks.push({ kind: 'li', text: l.text.slice(bullet[0].length), page: l.page })
      continue
    }
    // a new paragraph: a rule starts its own (G302 …), and so does the line after
    // a short one that ends a sentence (the paragraph above ended there)
    const startsRule = /^[A-Z]{1,3}\d{2,4}\b/.test(l.text)
    const prevEnded = Boolean(before && /[.!?:]$/.test(before.text) && before.text.length < typical * 0.7)
    // carries on the paragraph above (close below it), else a new one
    if (last && last.kind !== 'h' && l.gap < 1.6 && l.page === last.page && !startsRule && !prevEnded) {
      last.text = /[\p{L}]-$/u.test(last.text) ? last.text.slice(0, -1) + l.text : `${last.text} ${l.text}`
    } else if (last && last.kind !== 'h' && l.page !== last.page && !/[.!?:]$/.test(last.text) && /^\p{Ll}/u.test(l.text) && !startsRule) {
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
        } else html += `<p>${esc(b.text)}</p>`
      }
      if (inList) html += '</ul>'
      if (p[0].kind !== 'h') html = `<h1>${esc(head)}</h1>${html}`
      return { title: head.slice(0, 120), html: `<html><head><title>${esc(head)}</title></head><body><main>${html}</main></body></html>`, pages: [p[0].page, p[p.length - 1].page] as [number, number] }
    })
  return { title: docTitle, sections, pages }
}
