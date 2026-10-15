import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DOMParser } from 'linkedom'
import { readZip, type ZipEntry } from './zip'
import { pdfSections } from './pdf'
import { htmlToMarkdown } from './webImport'
import { log } from './log'

/**
 * Documents as notes
 * ==================
 *
 * Importing a Word, Excel, PowerPoint, OpenDocument, Pages, RTF, HTML, CSV,
 * PDF or plain-text file makes it a note you can edit – its headings, lists,
 * tables, links and pictures kept – rather than a file you can only open.
 *
 * Each document becomes a Markdown file (and its pictures, beside it) that the
 * Markdown import then reads like any other. The formats that are zips of XML
 * are read here directly; older and Apple formats (.doc, .xls, .ppt, .pages,
 * .numbers, .key, .wpd …) go through LibreOffice first when the server has it
 * (`soffice`), and otherwise a Pages/Numbers/Keynote file gives what its
 * built-in preview shows. Anything that still can't be read is kept as a file
 * note, as before.
 */

export interface DocFile {
  path: string
  data: Buffer
}

/** Read here, from the file itself. */
const OWN = /\.(docx|docm|dotx|odt|ott|pptx|ppsx|odp|xlsx|xlsm|ods|csv|tsv|rtf|html?|xhtml|pdf)$/i
/** LibreOffice turns these into one of the above (Writer/Calc/Impress). */
const VIA_OFFICE: Record<string, 'docx' | 'xlsx' | 'pptx'> = {
  doc: 'docx',
  dot: 'docx',
  wpd: 'docx',
  wps: 'docx',
  lwp: 'docx',
  abw: 'docx',
  hwp: 'docx',
  sxw: 'docx',
  fodt: 'docx',
  pages: 'docx',
  xls: 'xlsx',
  xlt: 'xlsx',
  numbers: 'xlsx',
  sxc: 'xlsx',
  fods: 'xlsx',
  wk1: 'xlsx',
  ppt: 'pptx',
  pps: 'pptx',
  key: 'pptx',
  sxi: 'pptx',
  fodp: 'pptx',
}
/** Plain text that reads best as code */
const CODE: Record<string, string> = {
  json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', conf: '', cfg: '', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', css: 'css', scss: 'scss', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua',
  r: 'r', m: '', ps1: 'powershell', bat: '', vb: 'vb', dart: 'dart', scala: 'scala', gradle: 'groovy', dockerfile: 'dockerfile', diff: 'diff', patch: 'diff',
}
/** Plain text that reads best as words */
const PROSE = /\.(text|log|rst|org|adoc|asciidoc|tex|nfo|srt|vtt)$/i

const extOf = (p: string) => /\.([^./]+)$/.exec(p)?.[1]?.toLowerCase() ?? ''

/** A file this import can turn into a note. */
export function isDocument(p: string, data?: Buffer): boolean {
  const ext = extOf(p)
  if (OWN.test(p) || ext in VIA_OFFICE || ext in CODE || PROSE.test(p)) return true
  return Boolean(data && !ext && looksLikeText(data))
}

/** Every document in an import made into Markdown (and its pictures); `skipped`: ones that couldn't be. */
export async function convertDocuments(files: DocFile[]): Promise<{ files: DocFile[]; converted: number; skipped: string[]; made: Set<string> }> {
  const MDX = /\.(md|markdown|mdown|txt)$/i
  // a Markdown export's own files (a PDF its note links to) stay attachments
  const mentioned = files
    .filter((f) => MDX.test(f.path))
    .map((f) => f.data.toString('utf8').toLowerCase())
    .join('\n')
  const isMentioned = (p: string) => {
    const name = path.posix.basename(p).toLowerCase()
    return mentioned.includes(name) || mentioned.includes(encodeURIComponent(name).toLowerCase())
  }
  const taken = new Set(files.map((f) => f.path.toLowerCase()))
  const out: DocFile[] = []
  let converted = 0
  const skipped: string[] = []
  const made = new Set<string>()
  for (const f of files) {
    if (MDX.test(f.path) || !isDocument(f.path, f.data) || isMentioned(f.path) || /^_(files|drawings)\//.test(f.path)) {
      out.push(f)
      continue
    }
    const dir = path.posix.dirname(f.path) === '.' ? '' : `${path.posix.dirname(f.path)}/`
    const base = path.posix.basename(f.path).replace(/\.[^.]+$/, '') || 'Untitled'
    let mdPath = `${dir}${base}.md`
    if (taken.has(mdPath.toLowerCase())) mdPath = `${dir}${base} (${extOf(f.path)}).md`
    taken.add(mdPath.toLowerCase())
    const slug = base.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'doc'
    const pictures = new Pictures(`${dir}${slug}-${converted + skipped.length + 1}_pictures/`, taken)
    try {
      const md = await toMarkdown(f, pictures)
      if (md === null) {
        skipped.push(path.posix.basename(f.path))
        out.push(f)
        continue
      }
      out.push({ path: mdPath, data: Buffer.from(md, 'utf8') }, ...pictures.files)
      made.add(mdPath)
      converted++
    } catch (e) {
      log.warn(`import: couldn't read ${f.path}: ${(e as Error).message}`)
      skipped.push(path.posix.basename(f.path))
      out.push(f)
    }
  }
  return { files: out, converted, skipped, made }
}

/** The pictures of one document, kept beside its Markdown. */
class Pictures {
  files: DocFile[] = []
  private names = new Map<string, string>()
  constructor(
    private dir: string,
    private taken: Set<string>,
  ) {}
  /** a picture's place, for the Markdown (null: not a picture a note can show) */
  add(name: string, data: Buffer): string | null {
    let ext = extOf(name)
    if (ext === 'jpeg') ext = 'jpg'
    if (!['png', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic'].includes(ext)) {
      const sniff = sniffImage(data)
      if (!sniff) return null // .emf / .wmf drawings: nothing can show them
      ext = sniff
    }
    const key = `${name}:${data.length}`
    if (this.names.has(key)) return this.names.get(key)!
    let n = this.files.length + 1
    let p = `${this.dir}picture-${n}.${ext}`
    while (this.taken.has(p.toLowerCase())) p = `${this.dir}picture-${++n}.${ext}`
    this.taken.add(p.toLowerCase())
    this.files.push({ path: p, data })
    // relative to the Markdown file beside it
    const rel = path.posix.basename(this.dir) + '/' + path.posix.basename(p)
    this.names.set(key, rel)
    return rel
  }
  /** a data: URI's picture */
  addDataUri(uri: string): string | null {
    const m = /^data:image\/([a-z+.-]+);base64,(.*)$/is.exec(uri)
    if (!m) return null
    return this.add(`inline.${m[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, Buffer.from(m[2], 'base64'))
  }
}

function sniffImage(d: Buffer): string | null {
  if (d.length < 12) return null
  if (d[0] === 0x89 && d[1] === 0x50) return 'png'
  if (d[0] === 0xff && d[1] === 0xd8) return 'jpg'
  if (d.toString('ascii', 0, 3) === 'GIF') return 'gif'
  if (d.toString('ascii', 0, 4) === 'RIFF' && d.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

function looksLikeText(d: Buffer): boolean {
  const head = d.subarray(0, 8192)
  if (!head.length || head.includes(0)) return false
  const s = head.toString('utf8')
  const bad = (s.match(/�/g) ?? []).length
  return bad < 3
}

async function toMarkdown(f: DocFile, pictures: Pictures): Promise<string | null> {
  const ext = extOf(f.path)
  const name = path.posix.basename(f.path)
  const html = (h: string) => htmlToMarkdown(h, (src) => (src.startsWith('data:') ? pictures.addDataUri(src) : null))
  switch (ext) {
    case 'docx':
    case 'docm':
    case 'dotx':
      return html(docxHtml(f.data, pictures))
    case 'odt':
    case 'ott':
      return html(odtHtml(f.data, pictures))
    case 'pptx':
    case 'ppsx':
      return html(pptxHtml(f.data, pictures))
    case 'odp':
      return html(odpHtml(f.data, pictures))
    case 'xlsx':
    case 'xlsm':
      return tablesMarkdown(xlsxSheets(f.data))
    case 'ods':
      return tablesMarkdown(odsSheets(f.data))
    case 'csv':
    case 'tsv':
      return tablesMarkdown([{ name: '', rows: parseCsv(text(f.data), ext === 'tsv' ? '\t' : undefined) }])
    case 'html':
    case 'htm':
    case 'xhtml':
      return html(text(f.data))
    case 'pdf':
      return pdfMarkdown(f.data, html)
    case 'rtf': {
      const via = await viaOffice(f.data, name, 'docx')
      return via ? html(docxHtml(via, pictures)) : html(rtfHtml(text(f.data, 'latin1')))
    }
  }
  if (ext in VIA_OFFICE) {
    const to = VIA_OFFICE[ext]
    const via = await viaOffice(f.data, name, to)
    if (via) return to === 'docx' ? html(docxHtml(via, pictures)) : to === 'xlsx' ? tablesMarkdown(xlsxSheets(via)) : html(pptxHtml(via, pictures))
    if (ext === 'pages' || ext === 'numbers' || ext === 'key') return applePreview(f.data, name, pictures, html)
    return null
  }
  // plain text
  const t = text(f.data)
  if (ext in CODE) {
    let fence = '```'
    while (t.includes(fence)) fence += '`'
    return `${fence}${CODE[ext]}\n${t.replace(/\n$/, '')}\n${fence}\n`
  }
  return escapeText(t)
}

const text = (d: Buffer, enc: BufferEncoding = 'utf8') => d.toString(enc).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
const escapeText = (t: string) => t.replace(/([*_`#>[\]\\|~])/g, '\\$1')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// --- LibreOffice -----------------------------------------------------------------

let office: Promise<string | null> | null = null
/** where LibreOffice is (null: not installed) */
function sofficePath(): Promise<string | null> {
  office ??= (async () => {
    if (process.env.RECON_SOFFICE === 'off') return null
    const found = [process.env.RECON_SOFFICE, '/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/homebrew/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].find(
      (p) => p && fs.existsSync(p),
    )
    return found ?? null
  })()
  return office
}
let queue: Promise<unknown> = Promise.resolve()

/** The file converted by LibreOffice (one at a time; null if it isn't there or can't). */
export async function viaOffice(data: Buffer, name: string, to: 'docx' | 'xlsx' | 'pptx'): Promise<Buffer | null> {
  const bin = await sofficePath()
  if (!bin) return null
  const run = queue.then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-office-'))
    try {
      const src = path.join(dir, `in.${extOf(name) || 'bin'}`)
      fs.writeFileSync(src, data)
      await new Promise<void>((resolve, reject) =>
        execFile(
          bin,
          [`-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--headless', '--norestore', '--convert-to', to, '--outdir', path.join(dir, 'out'), src],
          { timeout: 180_000 },
          (err) => (err ? reject(err) : resolve()),
        ),
      )
      const out = path.join(dir, 'out', `in.${to}`)
      return fs.existsSync(out) ? fs.readFileSync(out) : null
    } catch (e) {
      log.warn(`import: LibreOffice couldn't convert ${name}: ${(e as Error).message.split('\n')[0]}`)
      return null
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  queue = run.catch(() => {})
  return run
}

/** Pages / Numbers / Keynote without LibreOffice: what the file's own preview shows. */
async function applePreview(data: Buffer, name: string, pictures: Pictures, html: (h: string) => string): Promise<string | null> {
  let entries: ZipEntry[]
  try {
    entries = readZip(data)
  } catch {
    return null
  }
  const pdf = entries.find((e) => /(^|\/)(QuickLook\/)?Preview\.pdf$/i.test(e.name))
  if (pdf) return pdfMarkdown(pdf.data(), html)
  const jpg = entries.find((e) => /(^|\/)(preview\.jpg|QuickLook\/Thumbnail\.jpg)$/i.test(e.name))
  const pic = jpg ? pictures.add('preview.jpg', jpg.data()) : null
  if (!pic) return null
  return `![](${pic})\n\nOnly the first page's preview could be read from ${escapeText(name)}. For all of its text, export it as Word, Excel or PowerPoint (File › Export To) and import that – or install LibreOffice on your ReconNotes server.\n`
}

// --- XML helpers -----------------------------------------------------------------

type X = Element
function xml(s: string): Document {
  return new DOMParser().parseFromString(s, 'text/xml') as unknown as Document
}
const kids = (el: X) => [...el.children] as X[]
const all = (el: X | Document, tag: string) => [...el.getElementsByTagName(tag)] as X[]
const first = (el: X | Document, tag: string) => (el.getElementsByTagName(tag)[0] as X | undefined) ?? null
const attr = (el: X | null, name: string) => el?.getAttribute(name) ?? null
const on = (el: X | null) => Boolean(el) && !/^(0|false|off|none)$/i.test(attr(el, 'w:val') ?? 'true')

function zipOf(data: Buffer) {
  const entries = readZip(data)
  const byName = new Map(entries.map((e) => [e.name, e]))
  return {
    text: (n: string) => byName.get(n)?.data().toString('utf8') ?? null,
    data: (n: string) => byName.get(n)?.data() ?? null,
    names: () => entries.map((e) => e.name),
  }
}
type Zip = ReturnType<typeof zipOf>

/** a package's relationships: id → target (resolved from `from`'s folder) and whether it's outside */
function rels(zip: Zip, part: string): Map<string, { target: string; external: boolean; type: string }> {
  const dir = path.posix.dirname(part)
  const relsPath = `${dir}/_rels/${path.posix.basename(part)}.rels`
  const out = new Map<string, { target: string; external: boolean; type: string }>()
  const s = zip.text(relsPath)
  if (!s) return out
  for (const r of all(xml(s), 'Relationship')) {
    const external = attr(r, 'TargetMode') === 'External'
    const t = attr(r, 'Target') ?? ''
    out.set(attr(r, 'Id') ?? '', { target: external ? t : path.posix.normalize(t.startsWith('/') ? t.slice(1) : `${dir}/${t}`), external, type: attr(r, 'Type') ?? '' })
  }
  return out
}

/** Nested lists from paragraphs that say their level and kind. */
class ListBuilder {
  private stack: string[] = []
  html = ''
  item(level: number, tag: 'ul' | 'ol', content: string) {
    level = Math.max(0, Math.min(level, 8))
    while (this.stack.length > level + 1) this.html += `</li></${this.stack.pop()}>`
    if (this.stack.length === level + 1 && this.stack[level] !== tag) this.html += `</li></${this.stack.pop()}>`
    if (this.stack.length === level + 1) this.html += `</li><li>${content}`
    else {
      while (this.stack.length < level + 1) {
        this.html += `<${tag}><li>`
        this.stack.push(tag)
      }
      this.html += content
    }
  }
  close() {
    while (this.stack.length) this.html += `</li></${this.stack.pop()}>`
    const h = this.html
    this.html = ''
    return h
  }
}

function tableHtml(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (!width) return ''
  const cells = (r: string[], tag: string) => Array.from({ length: width }, (_, i) => `<${tag}>${r[i] ?? ''}</${tag}>`).join('')
  return `<table><thead><tr>${cells(rows[0], 'th')}</tr></thead><tbody>${rows
    .slice(1)
    .map((r) => `<tr>${cells(r, 'td')}</tr>`)
    .join('')}</tbody></table>`
}

// --- Word (.docx) -----------------------------------------------------------------

export function docxHtml(data: Buffer, pictures: Pictures): string {
  const zip = zipOf(data)
  const main = zip.names().find((n) => /^word\/document\d*\.xml$/.test(n)) ?? 'word/document.xml'
  const doc = xml(zip.text(main) ?? '')
  const relMap = rels(zip, main)
  // style names (Heading 1, Title, Quote…) and list kinds
  const styles = new Map<string, { name: string; numId?: string; ilvl?: number; basedOn?: string }>()
  const st = zip.text('word/styles.xml')
  if (st)
    for (const s of all(xml(st), 'w:style')) {
      const num = first(s, 'w:numPr')
      styles.set(attr(s, 'w:styleId') ?? '', {
        name: (attr(first(s, 'w:name'), 'w:val') ?? '').toLowerCase(),
        numId: attr(first(num ?? s, 'w:numId'), 'w:val') ?? undefined,
        ilvl: num ? Number(attr(first(num, 'w:ilvl'), 'w:val') ?? 0) : undefined,
        basedOn: attr(first(s, 'w:basedOn'), 'w:val') ?? undefined,
      })
    }
  const styleName = (id: string | null) => {
    let s = id ? styles.get(id) : undefined
    for (let i = 0; s && i < 5; i++) {
      if (/^(heading|title|subtitle|quote|intense quote)\b/.test(s.name)) return s.name
      s = s.basedOn ? styles.get(s.basedOn) : undefined
    }
    return (id ? styles.get(id)?.name : '') ?? ''
  }
  const kinds = new Map<string, Map<number, 'ul' | 'ol'>>()
  const nb = zip.text('word/numbering.xml')
  if (nb) {
    const d = xml(nb)
    const abstract = new Map<string, Map<number, 'ul' | 'ol'>>()
    for (const a of all(d, 'w:abstractNum')) {
      const levels = new Map<number, 'ul' | 'ol'>()
      for (const l of all(a, 'w:lvl')) levels.set(Number(attr(l, 'w:ilvl') ?? 0), /bullet|none/.test(attr(first(l, 'w:numFmt'), 'w:val') ?? 'bullet') ? 'ul' : 'ol')
      abstract.set(attr(a, 'w:abstractNumId') ?? '', levels)
    }
    for (const n of all(d, 'w:num')) kinds.set(attr(n, 'w:numId') ?? '', abstract.get(attr(first(n, 'w:abstractNumId'), 'w:val') ?? '') ?? new Map())
  }

  const picture = (el: X) => {
    const blip = first(el, 'a:blip') ?? first(el, 'v:imagedata')
    const id = attr(blip, 'r:embed') ?? attr(blip, 'r:id')
    const r = id ? relMap.get(id) : undefined
    const d = r && !r.external ? zip.data(r.target) : null
    const src = d ? pictures.add(r!.target, d) : null
    const alt = attr(first(el, 'wp:docPr'), 'descr') ?? ''
    return src ? `<img src="${esc(src)}" alt="${esc(alt)}">` : ''
  }
  const runs = (el: X): string => {
    let out = ''
    for (const c of kids(el)) {
      switch (c.tagName) {
        case 'w:r': {
          const pr = first(c, 'w:rPr')
          let t = ''
          for (const k of kids(c)) {
            if (k.tagName === 'w:t') t += esc(k.textContent ?? '')
            else if (k.tagName === 'w:tab' || k.tagName === 'w:ptab') t += ' '
            else if (k.tagName === 'w:br' || k.tagName === 'w:cr') t += attr(k, 'w:type') === 'page' ? '' : '<br>'
            else if (k.tagName === 'w:noBreakHyphen') t += '-'
            else if (k.tagName === 'w:sym') t += esc(String.fromCodePoint(parseInt(attr(k, 'w:char') ?? '20', 16) & 0xffff))
            else if (k.tagName === 'w:drawing' || k.tagName === 'w:pict' || k.tagName === 'w:object') t += picture(k)
          }
          if (!t) break
          if (pr) {
            if (on(first(pr, 'w:b'))) t = `<b>${t}</b>`
            if (on(first(pr, 'w:i'))) t = `<i>${t}</i>`
            if (on(first(pr, 'w:strike')) || on(first(pr, 'w:dstrike'))) t = `<s>${t}</s>`
            if (attr(first(pr, 'w:vertAlign'), 'w:val') === 'superscript') t = `<sup>${t}</sup>`
          }
          out += t
          break
        }
        case 'w:hyperlink': {
          const r = relMap.get(attr(c, 'r:id') ?? '')
          const inner = runs(c)
          out += r?.external && /^(https?:|mailto:)/i.test(r.target) ? `<a href="${esc(r.target)}">${inner}</a>` : inner
          break
        }
        case 'w:del':
        case 'w:moveFrom':
        case 'w:rPr':
        case 'w:pPr':
          break
        default:
          // insertions, fields, smart tags, content controls: what's inside
          if (c.children.length) out += runs(c.tagName === 'w:sdt' ? (first(c, 'w:sdtContent') ?? c) : c)
      }
    }
    return out
  }

  const list = new ListBuilder()
  let html = ''
  const block = (el: X) => {
    for (const c of kids(el)) {
      if (c.tagName === 'w:p') {
        const pr = first(c, 'w:pPr')
        const style = attr(first(pr ?? c, 'w:pStyle'), 'w:val')
        const name = styleName(style)
        const content = runs(c).trim()
        const numPr = pr ? first(pr, 'w:numPr') : null
        const numId = attr(first(numPr ?? c, 'w:numId'), 'w:val') ?? (style ? styles.get(style)?.numId : undefined) ?? null
        if (numId && numId !== '0' && content && !/^(heading|title)/.test(name)) {
          const level = Number(attr(first(numPr ?? c, 'w:ilvl'), 'w:val') ?? (style ? styles.get(style)?.ilvl : 0) ?? 0)
          list.item(level, kinds.get(numId)?.get(level) ?? 'ul', content)
          continue
        }
        html += list.close()
        if (!content) continue
        const h = /^heading (\d)/.exec(name)
        if (h) html += `<h${Math.min(6, Number(h[1]))}>${content}</h${Math.min(6, Number(h[1]))}>`
        else if (name === 'title') html += `<h1>${content}</h1>`
        else if (name === 'subtitle') html += `<h2>${content}</h2>`
        else if (/quote/.test(name)) html += `<blockquote><p>${content}</p></blockquote>`
        else html += `<p>${content}</p>`
      } else if (c.tagName === 'w:tbl') {
        html += list.close()
        const rows = kids(c)
          .filter((r) => r.tagName === 'w:tr')
          .map((r) =>
            kids(r)
              .filter((tc) => tc.tagName === 'w:tc')
              .flatMap((tc) => {
                const cell = all(tc, 'w:p')
                  .map((p) => runs(p).trim())
                  .filter(Boolean)
                  .join('<br>')
                const span = Number(attr(first(tc, 'w:gridSpan'), 'w:val') ?? 1)
                return [cell, ...Array.from({ length: Math.max(0, Math.min(span, 20) - 1) }, () => '')]
              }),
          )
        html += tableHtml(rows)
      } else if (c.tagName === 'w:sdt') block(first(c, 'w:sdtContent') ?? c)
      else if (c.tagName === 'w:customXml' || c.tagName === 'w:ins') block(c)
    }
  }
  const body = first(doc, 'w:body')
  if (body) block(body)
  return html + list.close()
}

// --- OpenDocument text (.odt) -----------------------------------------------------

function odfStyles(zip: Zip, doc: Document) {
  const text = new Map<string, { b?: boolean; i?: boolean; s?: boolean }>()
  const lists = new Map<string, 'ul' | 'ol'>()
  const paraParent = new Map<string, string>()
  const read = (d: Document | null) => {
    if (!d) return
    for (const s of all(d, 'style:style')) {
      const n = attr(s, 'style:name') ?? ''
      const tp = first(s, 'style:text-properties')
      if (tp)
        text.set(n, {
          b: /bold|[6-9]00/.test(attr(tp, 'fo:font-weight') ?? ''),
          i: /italic|oblique/.test(attr(tp, 'fo:font-style') ?? ''),
          s: (attr(tp, 'style:text-line-through-style') ?? 'none') !== 'none',
        })
      const parent = attr(s, 'style:parent-style-name')
      if (parent) paraParent.set(n, parent)
    }
    for (const l of all(d, 'text:list-style')) {
      const firstLevel = kids(l)[0]
      lists.set(attr(l, 'style:name') ?? '', firstLevel?.tagName === 'text:list-level-style-number' ? 'ol' : 'ul')
    }
  }
  read(doc)
  const st = zip.text('styles.xml')
  read(st ? xml(st) : null)
  return { text, lists, paraParent }
}

function odfInline(el: X, styles: ReturnType<typeof odfStyles>, picture: (el: X) => string): string {
  let out = ''
  for (const n of [...el.childNodes] as unknown as (X & { nodeType: number; textContent: string })[]) {
    if (n.nodeType === 3) {
      out += esc(n.textContent ?? '')
      continue
    }
    if (n.nodeType !== 1) continue
    switch (n.tagName) {
      case 'text:s':
        out += ' '.repeat(Math.min(Number(attr(n, 'text:c') ?? 1), 8))
        break
      case 'text:tab':
        out += ' '
        break
      case 'text:line-break':
        out += '<br>'
        break
      case 'text:span': {
        let t = odfInline(n, styles, picture)
        const s = styles.text.get(attr(n, 'text:style-name') ?? '')
        if (t && s?.b) t = `<b>${t}</b>`
        if (t && s?.i) t = `<i>${t}</i>`
        if (t && s?.s) t = `<s>${t}</s>`
        out += t
        break
      }
      case 'text:a': {
        const href = attr(n, 'xlink:href') ?? ''
        const t = odfInline(n, styles, picture)
        out += /^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href)}">${t}</a>` : t
        break
      }
      case 'draw:frame':
        out += picture(n)
        break
      case 'text:note':
      case 'office:annotation':
      case 'text:bookmark':
      case 'text:soft-page-break':
        break
      default:
        out += odfInline(n, styles, picture)
    }
  }
  return out
}

function odtHtml(data: Buffer, pictures: Pictures): string {
  const zip = zipOf(data)
  const doc = xml(zip.text('content.xml') ?? '')
  const styles = odfStyles(zip, doc)
  const picture = (frame: X) => {
    const img = first(frame, 'draw:image')
    const href = attr(img, 'xlink:href') ?? ''
    const d = href ? zip.data(href.replace(/^\.\//, '')) : null
    const src = d ? pictures.add(href, d) : null
    return src ? `<img src="${esc(src)}" alt="">` : ''
  }
  const inline = (el: X) => odfInline(el, styles, picture).trim()
  const isTitle = (p: X) => /^title$/i.test(attr(p, 'text:style-name') ?? '') || /^title$/i.test(styles.paraParent.get(attr(p, 'text:style-name') ?? '') ?? '')
  const listHtml = (l: X, kind?: 'ul' | 'ol'): string => {
    const tag = kind ?? styles.lists.get(attr(l, 'text:style-name') ?? '') ?? 'ul'
    const items = kids(l)
      .filter((i) => i.tagName === 'text:list-item' || i.tagName === 'text:list-header')
      .map((i) => `<li>${kids(i).map((c) => (c.tagName === 'text:list' ? listHtml(c, tag) : c.tagName === 'text:p' || c.tagName === 'text:h' ? inline(c) : '')).join('<br>')}</li>`)
    return `<${tag}>${items.join('')}</${tag}>`
  }
  const block = (el: X): string =>
    kids(el)
      .map((c) => {
        switch (c.tagName) {
          case 'text:h': {
            const lv = Math.min(6, Number(attr(c, 'text:outline-level') ?? 1))
            const t = inline(c)
            return t ? `<h${lv}>${t}</h${lv}>` : ''
          }
          case 'text:p': {
            const t = inline(c)
            return t ? (isTitle(c) ? `<h1>${t}</h1>` : `<p>${t}</p>`) : ''
          }
          case 'text:list':
            return listHtml(c)
          case 'table:table':
            return tableHtml(
              all(c, 'table:table-row').map((r) =>
                kids(r)
                  .filter((tc) => tc.tagName === 'table:table-cell' || tc.tagName === 'table:covered-table-cell')
                  .map((tc) => all(tc, 'text:p').map(inline).filter(Boolean).join('<br>')),
              ),
            )
          case 'text:section':
          case 'text:index-body':
            return block(c)
          default:
            return ''
        }
      })
      .join('')
  const body = first(doc, 'office:text')
  return body ? block(body) : ''
}

// --- Slides (.pptx, .odp) ---------------------------------------------------------

function pptxHtml(data: Buffer, pictures: Pictures): string {
  const zip = zipOf(data)
  const pres = xml(zip.text('ppt/presentation.xml') ?? '')
  const presRels = rels(zip, 'ppt/presentation.xml')
  let slides = all(pres, 'p:sldId')
    .map((s) => presRels.get(attr(s, 'r:id') ?? '')?.target)
    .filter((t): t is string => Boolean(t))
  if (!slides.length) slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]))
  const paraText = (p: X) =>
    kids(p)
      .map((r) => {
        if (r.tagName === 'a:br') return '<br>'
        if (r.tagName !== 'a:r' && r.tagName !== 'a:fld') return ''
        let t = esc(first(r, 'a:t')?.textContent ?? '')
        const pr = first(r, 'a:rPr')
        if (t && attr(pr, 'b') === '1') t = `<b>${t}</b>`
        if (t && attr(pr, 'i') === '1') t = `<i>${t}</i>`
        return t
      })
      .join('')
      .trim()
  let html = ''
  slides.forEach((part, i) => {
    const s = zip.text(part)
    if (!s) return
    const d = xml(s)
    const slideRels = rels(zip, part)
    let title = ''
    let body = ''
    const list = new ListBuilder()
    const walk = (el: X) => {
      for (const c of kids(el)) {
        if (c.tagName === 'p:sp') {
          const ph = first(c, 'p:ph')
          const paras = all(c, 'a:p')
          const words = paras.map(paraText).filter(Boolean)
          if (!title && ((ph && /title/i.test(attr(ph, 'type') ?? '')) || (!body && words.length === 1 && words[0].length <= 100))) {
            title = words.join(' ')
            continue
          }
          // a placeholder for the slide's points is bulleted unless it says not; a text box only if it says so
          const points = Boolean(ph) && /^(body|obj|)$/.test(attr(ph, 'type') ?? '')
          for (const p of paras) {
            const t = paraText(p)
            if (!t) continue
            const pPr = first(p, 'a:pPr')
            const numbered = Boolean(first(pPr ?? p, 'a:buAutoNum'))
            const bullet = numbered || Boolean(first(pPr ?? p, 'a:buChar')) || (points && !first(pPr ?? p, 'a:buNone'))
            if (!bullet) body += list.close() + `<p>${t}</p>`
            else list.item(Number(attr(pPr, 'lvl') ?? 0), numbered ? 'ol' : 'ul', t)
          }
          body += list.close()
        } else if (c.tagName === 'p:pic') {
          const id = attr(first(c, 'a:blip'), 'r:embed')
          const r = id ? slideRels.get(id) : undefined
          const dd = r && !r.external ? zip.data(r.target) : null
          const src = dd ? pictures.add(r!.target, dd) : null
          if (src) body += list.close() + `<p><img src="${esc(src)}" alt=""></p>`
        } else if (c.tagName === 'p:graphicFrame' && first(c, 'a:tbl')) {
          body += list.close() + tableHtml(all(c, 'a:tr').map((r) => all(r, 'a:tc').map((tc) => all(tc, 'a:p').map(paraText).filter(Boolean).join('<br>'))))
        } else if (c.tagName === 'p:grpSp') walk(c)
      }
    }
    const tree = first(d, 'p:spTree')
    if (tree) walk(tree)
    body += list.close()
    // the speaker's notes
    const notes = [...slideRels.values()].find((r) => /notesSlide$/.test(r.type))
    const ns = notes ? zip.text(notes.target) : null
    if (ns) {
      const nd = xml(ns)
      const words = all(nd, 'p:sp')
        .filter((sp) => attr(first(sp, 'p:ph'), 'type') === 'body')
        .flatMap((sp) => all(sp, 'a:p').map(paraText))
        .filter(Boolean)
      if (words.length) body += `<blockquote>${words.map((w) => `<p>${w}</p>`).join('')}</blockquote>`
    }
    html += `<h2>${title || `Slide ${i + 1}`}</h2>${body}`
  })
  return html
}

function odpHtml(data: Buffer, pictures: Pictures): string {
  const zip = zipOf(data)
  const doc = xml(zip.text('content.xml') ?? '')
  const styles = odfStyles(zip, doc)
  const picture = (frame: X) => {
    const href = attr(first(frame, 'draw:image'), 'xlink:href') ?? ''
    const d = href ? zip.data(href.replace(/^\.\//, '')) : null
    const src = d ? pictures.add(href, d) : null
    return src ? `<img src="${esc(src)}" alt="">` : ''
  }
  let html = ''
  all(doc, 'draw:page').forEach((page, i) => {
    let title = ''
    let body = ''
    for (const frame of kids(page).filter((f) => f.tagName === 'draw:frame')) {
      const cls = attr(frame, 'presentation:class') ?? ''
      const words = all(frame, 'text:p')
        .map((p) => odfInline(p, styles, () => '').trim())
        .filter(Boolean)
      if (!title && (cls === 'title' || (!cls && !body && words.length === 1 && words[0].length <= 100 && !first(frame, 'text:list')))) {
        title = words.join(' ')
        continue
      }
      if (first(frame, 'draw:image') && !first(frame, 'draw:text-box')) {
        body += picture(frame)
        continue
      }
      for (const box of all(frame, 'draw:text-box'))
        for (const c of kids(box)) {
          if (c.tagName === 'text:p') {
            const t = odfInline(c, styles, picture).trim()
            if (t) body += `<p>${t}</p>`
          } else if (c.tagName === 'text:list') {
            const items = all(c, 'text:p')
              .map((p) => odfInline(p, styles, picture).trim())
              .filter(Boolean)
            if (items.length) body += `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`
          }
        }
    }
    const name = attr(page, 'draw:name') ?? ''
    html += `<h2>${title || (/^(page|slide)\s*\d+$/i.test(name) || !name ? `Slide ${i + 1}` : esc(name))}</h2>${body}`
  })
  return html
}

// --- Spreadsheets -----------------------------------------------------------------

interface Sheet {
  name: string
  rows: string[][]
}
const MAX_ROWS = 1000
const MAX_COLS = 40

function xlsxSheets(data: Buffer): Sheet[] {
  const zip = zipOf(data)
  const book = xml(zip.text('xl/workbook.xml') ?? '')
  const bookRels = rels(zip, 'xl/workbook.xml')
  const shared = (() => {
    const s = zip.text('xl/sharedStrings.xml')
    if (!s) return [] as string[]
    return all(xml(s), 'si').map((si) => {
      const rs = all(si, 'r')
      return (rs.length ? rs.map((r) => first(r, 't')?.textContent ?? '') : [first(si, 't')?.textContent ?? '']).join('')
    })
  })()
  // which cells are dates (by their number format)
  const dateStyles = new Set<number>()
  const timeStyles = new Set<number>()
  const st = zip.text('xl/styles.xml')
  if (st) {
    const d = xml(st)
    const custom = new Map(all(d, 'numFmt').map((f) => [Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '']))
    const xfs = first(d, 'cellXfs')
    ;(xfs ? kids(xfs).filter((x) => x.tagName === 'xf') : []).forEach((xf, i) => {
      const id = Number(attr(xf, 'numFmtId') ?? 0)
      const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
      const isDate = (id >= 14 && id <= 17) || id === 22 || (id >= 45 && id <= 47) || /[dy]/i.test(code) || (/m/i.test(code) && !/[#0]/.test(code))
      if (isDate || (id >= 18 && id <= 21)) dateStyles.add(i)
      if (id === 22 || (id >= 18 && id <= 21) || (id >= 45 && id <= 47) || /h/i.test(code)) timeStyles.add(i)
    })
  }
  const value = (c: X): string => {
    const t = attr(c, 't')
    const v = first(c, 'v')?.textContent ?? ''
    if (t === 's') return shared[Number(v)] ?? ''
    if (t === 'inlineStr') return all(c, 't').map((x) => x.textContent ?? '').join('')
    if (t === 'b') return v === '1' ? 'TRUE' : 'FALSE'
    if (t === 'str' || t === 'e') return v
    if (v === '') return ''
    const n = Number(v)
    const style = Number(attr(c, 's') ?? -1)
    if (dateStyles.has(style) && Number.isFinite(n)) {
      const date = new Date(Math.round((n - 25569) * 86400000))
      const iso = date.toISOString()
      if (n < 1) return iso.slice(11, 16)
      return timeStyles.has(style) && n % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10)
    }
    return Number.isFinite(n) && !Number.isInteger(n) ? String(Number(n.toPrecision(12))) : v
  }
  const col = (ref: string) => {
    const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
    let n = 0
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n - 1
  }
  return all(book, 'sheet').map((sh) => {
    const target = bookRels.get(attr(sh, 'r:id') ?? '')?.target
    const s = target ? zip.text(target) : null
    const rows: string[][] = []
    if (s)
      for (const r of all(xml(s), 'row')) {
        if (rows.length > MAX_ROWS) break
        const row: string[] = []
        kids(r)
          .filter((c) => c.tagName === 'c')
          .forEach((c, i) => {
            const at = attr(c, 'r') ? col(attr(c, 'r')!) : i
            if (at < MAX_COLS) row[at] = value(c)
          })
        rows.push(Array.from(row, (x) => x ?? ''))
      }
    return { name: attr(sh, 'name') ?? '', rows }
  })
}

function odsSheets(data: Buffer): Sheet[] {
  const zip = zipOf(data)
  const doc = xml(zip.text('content.xml') ?? '')
  return all(doc, 'table:table').map((t) => {
    const rows: string[][] = []
    for (const r of all(t, 'table:table-row')) {
      const cells: string[] = []
      for (const c of kids(r)) {
        if (c.tagName !== 'table:table-cell' && c.tagName !== 'table:covered-table-cell') continue
        const v =
          attr(c, 'office:date-value')?.replace('T', ' ').replace(/ 00:00:00$/, '') ??
          (all(c, 'text:p')
            .map((p) => p.textContent ?? '')
            .join(' ') ||
            '')
        const times = Math.min(Number(attr(c, 'table:number-columns-repeated') ?? 1), MAX_COLS)
        for (let i = 0; i < times && cells.length < MAX_COLS; i++) cells.push(v)
      }
      const times = Math.min(Number(attr(r, 'table:number-rows-repeated') ?? 1), MAX_ROWS)
      // (a sheet's last row is repeated to the bottom – a million empty rows)
      if (cells.some(Boolean)) for (let i = 0; i < times && rows.length <= MAX_ROWS; i++) rows.push(cells)
      else rows.push(cells)
      if (rows.length > MAX_ROWS) break
    }
    return { name: attr(t, 'table:name') ?? '', rows }
  })
}

export function parseCsv(s: string, delimiter?: string): string[][] {
  const firstLine = s.slice(0, s.indexOf('\n') >>> 0)
  const d = delimiter ?? ([',', ';', '\t'].map((c) => [c, firstLine.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0] || ',')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === d) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length > MAX_ROWS) break
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

/** Sheets as Markdown tables (empty rows and columns left out; very big ones cut short, and said so). */
export function tablesMarkdown(sheets: Sheet[]): string {
  const cell = (s: string) => escapeText(s.trim()).replace(/\n+/g, '<br>') || ' '
  const parts: string[] = []
  const named = sheets.filter((s) => s.rows.some((r) => r.some((c) => c.trim()))).length > 1
  for (const s of sheets) {
    let rows = s.rows.filter((r) => r.some((c) => c.trim()))
    if (!rows.length) continue
    const cut = rows.length > MAX_ROWS
    rows = rows.slice(0, MAX_ROWS)
    const width = Math.max(...rows.map((r) => r.length))
    const used = Array.from({ length: width }, (_, i) => rows.some((r) => (r[i] ?? '').trim()))
    rows = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '').filter((_, i) => used[i]))
    if (named && s.name) parts.push(`## ${escapeText(s.name)}`)
    const [head, ...rest] = rows
    parts.push(
      [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rest.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') +
        (cut ? `\n\n*The first ${MAX_ROWS} rows – the file has more.*` : ''),
    )
  }
  return parts.join('\n\n') + '\n'
}

// --- PDF, RTF ---------------------------------------------------------------------

async function pdfMarkdown(data: Buffer, html: (h: string) => string): Promise<string> {
  const { title, sections } = await pdfSections(data)
  const parts = sections.map((s, i) => (s.title && !(i === 0 && s.title === title) ? `<h2>${esc(s.title)}</h2>` : '') + s.html)
  return html(parts.join(''))
}

/** RTF's words (bold and italic kept), when LibreOffice isn't there to read it properly. */
export function rtfHtml(rtf: string): string {
  const SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|header[lrf]?|footer[lrf]?|themedata|datastore|latentstyles|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|mmathPr|filetbl|revtbl|object|fldinst|footnote|private)$/
  const cp1252: Record<number, string> = { 0x80: '€', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x85: '…', 0x99: '™' }
  type State = { b: boolean; i: boolean; skip: boolean; uc: number }
  const stack: State[] = []
  let s: State = { b: false, i: false, skip: false, uc: 1 }
  const paras: string[] = []
  let cur = ''
  let skipChars = 0
  const put = (t: string) => {
    if (s.skip) return
    if (skipChars > 0) {
      skipChars--
      return
    }
    let x = esc(t)
    if (s.b) x = `<b>${x}</b>`
    if (s.i) x = `<i>${x}</i>`
    cur += x
  }
  const end = () => {
    paras.push(cur.replace(/<\/b><b>|<\/i><i>/g, '').trim())
    cur = ''
  }
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i]
    if (ch === '{') {
      stack.push({ ...s })
      if (rtf.startsWith('{\\*', i)) s.skip = true
    } else if (ch === '}') {
      s = stack.pop() ?? s
      skipChars = 0
    }
    else if (ch === '\\') {
      const m = /^\\(?:([a-z]{1,32})(-?\d{1,10})? ?|'([0-9a-fA-F]{2})|(.))/s.exec(rtf.slice(i, i + 48))
      if (!m) continue
      i += m[0].length - 1
      if (m[3]) {
        const code = parseInt(m[3], 16)
        put(cp1252[code] ?? String.fromCharCode(code))
        continue
      }
      if (m[4]) {
        if (m[4] === '\n' || m[4] === '\r') end()
        else if (m[4] === '~') put(' ')
        else if (m[4] === '_') put('-')
        else if ('\\{}'.includes(m[4])) put(m[4])
        continue
      }
      const word = m[1]
      const n = m[2] === undefined ? null : Number(m[2])
      if (SKIP.test(word)) s.skip = true
      else if (word === 'par' || word === 'sect') !s.skip && end()
      else if (word === 'line') put('\n')
      else if (word === 'tab') put(' ')
      else if (word === 'b') s.b = n !== 0
      else if (word === 'i') s.i = n !== 0
      else if (word === 'plain') s.b = s.i = false
      else if (word === 'uc') s.uc = n ?? 1
      else if (word === 'u' && n !== null) {
        if (s.skip) continue
        put(String.fromCharCode(n < 0 ? n + 65536 : n))
        skipChars = s.uc
      } else if (word === 'emdash') put('—')
      else if (word === 'endash') put('–')
      else if (word === 'bullet') put('•')
      else if (word === 'lquote') put('‘')
      else if (word === 'rquote') put('’')
      else if (word === 'ldblquote') put('“')
      else if (word === 'rdblquote') put('”')
      else if (word === 'cell') put(' | ')
      else if (word === 'row') !s.skip && end()
    } else if (ch !== '\n' && ch !== '\r') put(ch)
  }
  end()
  return paras
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
