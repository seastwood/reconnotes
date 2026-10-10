/// <reference lib="dom.iterable" />
import { guardAddress, isPrivateHost } from './netGuard'
import { SITE_RECIPE_CARDS, recipeCard, recipeIn } from './recipe'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import * as Y from 'yjs'
import { WORKSPACE_DOC, noteToMarkdown, listFolders, videoInfo, createFolder, createNote, extractNote, getContent, newId, noteDocName, updateFolder, updateNote } from '@reconnotes/core'
import type { Ai } from './ai'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { initialTextStatus, queueAttachment } from './attachments'
import { markdownToNodes } from './importNotes'
import { reportProgress } from './jobs'
import { pdfSections } from './pdf'

/**
 * Web pages into notes
 * ====================
 *
 * Give it the address of a guide, a manual, an article: the server fetches
 * the page, keeps its content (not the site's menus, banners and footers),
 * and writes it as a note – headings, paragraphs, lists, tables, code,
 * quotes and links as they were, every picture downloaded into the note.
 *
 * A guide spread over many pages: "the pages it links to" follows the links
 * under the same address (the guide's own table of contents, in its order),
 * one note per page in a new folder, and links between those pages become
 * links between the notes.
 *
 * Pages that build themselves with JavaScript in the browser have little in
 * the page the server receives; the result says so.
 */

export interface WebImportOptions {
  url: string
  /** also the pages it links to under the same address */
  follow?: boolean
  /** how many pages at most (with follow) */
  maxPages?: number
  folderId?: string | null
  /** checking an earlier import for updates */
  update?: WebImportRecord
  /** a PDF uploaded from the device (an attachment) */
  pdfAttachmentId?: string
  /** a PDF: a note per chapter (in a folder, with a contents note) instead of one note */
  splitPdf?: boolean
  /** a recipe page: the rest of the article under its recipe card (default), or the card only */
  recipeArticle?: boolean
}

export interface WebImportResult {
  noteIds: string[]
  folderId: string | null
  pages: number
  pictures: number
  /** what didn't come across */
  notes: string[]
  /** notes written (checking for updates: the changed ones) */
  changed?: number
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 ReconNotes'
const MAX_HTML = 15 * 1024 * 1024
const MAX_PICTURE = 25 * 1024 * 1024
const MAX_PICTURES = 600
const PAGE_LIMIT = 300

/**
 * Fetch, up to `max` bytes. `allowPrivate`: may it reach addresses on your own network (only when
 * the page imported is on it) – checked on every redirect too.
 */
async function fetchWithLimit(url: string, accept: string, max: number, timeoutMs = 30_000, allowPrivate = false): Promise<{ data: Buffer; type: string; url: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    let res: Response
    for (let hops = 0; ; hops++) {
      await guardAddress(url, allowPrivate)
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en,*;q=0.5' }, redirect: 'manual', signal: ctl.signal })
      const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!to) break
      if (hops >= 8) throw new Error('too many redirects')
      void res.body?.cancel()
      url = new URL(to, url).href
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'error'} from ${new URL(url).host}`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > max) throw new Error(`too large (${Math.round(len / 1048576)} MB)`)
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length
      if (size > max) throw new Error(`too large (over ${Math.round(max / 1048576)} MB)`)
      chunks.push(Buffer.from(c))
    }
    return { data: Buffer.concat(chunks), type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), url }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${new URL(url).host} took too long to answer`)
    // "fetch failed" says nothing: the reason is underneath
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    const host = new URL(url).host
    const why: Record<string, string> = {
      ENOTFOUND: `the server can’t find ${host} (check the address, and that the server can reach the internet)`,
      EAI_AGAIN: `the server can’t look up ${host} right now (its DNS)`,
      ECONNREFUSED: `${host} refused the connection`,
      ECONNRESET: `${host} closed the connection`,
      ETIMEDOUT: `${host} didn’t answer`,
      CERT_HAS_EXPIRED: `${host}’s certificate has expired`,
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: `${host}’s certificate can’t be checked`,
      SELF_SIGNED_CERT_IN_CHAIN: `${host}’s certificate isn’t trusted`,
    }
    if (cause?.code && why[cause.code]) throw new Error(why[cause.code])
    if (cause?.message) throw new Error(`${host}: ${cause.message}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** The character set the page says it's in (else UTF-8). */
function decodeHtml(data: Buffer, type: string): string {
  const head = data.subarray(0, 4096).toString('latin1')
  const cs = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(cs.toLowerCase()).decode(data)
  } catch {
    return data.toString('utf8')
  }
}

// --- finding the content ---------------------------------------------------

type El = Element

/** Parts of a page that aren't its content. */
const NOISE_TAGS = 'script,style,noscript,template,nav,aside,footer,form,button,select,textarea,dialog,link,meta,object,embed,canvas'
const NOISE_NAME =
  /(^|[\s_-])(breadcrumbs?|pagination|pager|paginator|toc|table-of-contents|sidebar|side-bar|share|sharing|social|comments?|cookies?|consent|newsletter|subscribe|related|edit-?(this-)?page|feedback|was-this-helpful|skip-?link|advert\w*|ads?|banner|promo|popup|modal|navbar|nav-?bar|menu|search-?box|announcement)($|[\s_-])/i
const MAIN_SELECTORS = [
  'article',
  'main',
  '[role=main]',
  '.markdown-body',
  '.theme-doc-markdown',
  '.md-content',
  '.rst-content',
  '.document',
  '.docs-content',
  '.doc-content',
  '.documentation',
  '.post-content',
  '.entry-content',
  '.article-body',
  '.article-content',
  '#content',
  '.content',
  '#main',
]

const textLength = (el: El) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().length

/** A CSS length in points ("36pt", "48px", "2em"); 0 for anything else. */
function points(v: string): number {
  const m = /^(-?[\d.]+)(pt|px|em|rem)?$/.exec(v.trim())
  if (!m) return 0
  const n = parseFloat(m[1])
  return m[2] === 'px' ? n * 0.75 : m[2] === 'em' || m[2] === 'rem' ? n * 12 : m[2] === 'pt' ? n : 0
}

/**
 * How far each paragraph is indented (Google Docs, Word's HTML: by classes in
 * the page's stylesheet, or a style on it), noted on it as data-rn-indent –
 * before the stylesheets go with the rest of the noise.
 */
function markIndents(doc: Document) {
  const byClass = new Map<string, number>()
  for (const st of doc.querySelectorAll('style'))
    for (const m of (st.textContent ?? '').matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const left = /(?:^|;)\s*(?:margin|padding)-left\s*:\s*([^;]+)/gi
      let pt = 0
      for (const d of m[2].matchAll(left)) pt += points(d[1])
      if (pt) byClass.set(m[1], (byClass.get(m[1]) ?? 0) + pt)
    }
  for (const el of doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div')) {
    let pt = 0
    for (const c of (el.getAttribute('class') ?? '').split(/\s+/)) pt += byClass.get(c) ?? 0
    for (const d of (el.getAttribute('style') ?? '').matchAll(/(?:^|;)\s*(?:margin|padding)-left\s*:\s*([^;]+)/gi)) pt += points(d[1])
    if (pt > 0) el.setAttribute('data-rn-indent', String(Math.round(pt)))
  }
}

/** A Google Doc published to the web: its document, and its own title. */
function googleDoc(doc: Document): { main: El; title: string } | null {
  const main = doc.querySelector('#contents') as El | null
  if (!main || !doc.querySelector('#publish-banner, #banners, meta[content*="Google Docs"]')) return null
  const title = (doc.querySelector('#title')?.textContent ?? doc.querySelector('title')?.textContent?.replace(/\s+-\s+Google Docs\s*$/, '') ?? '').replace(/\s+/g, ' ').trim()
  return { main, title }
}

/** The element holding the page's content. */
function findMain(doc: Document): El {
  const body = doc.body ?? doc.documentElement
  const candidates: El[] = []
  for (const sel of MAIN_SELECTORS) for (const el of doc.querySelectorAll(sel)) candidates.push(el as El)
  if (!candidates.length) return body
  const total = textLength(body) || 1
  // the biggest; then something more specific inside it, if that holds most of it
  let best = candidates.reduce((a, b) => (textLength(b) > textLength(a) ? b : a))
  if (textLength(best) < 0.2 * total && textLength(best) < 500) return body
  for (;;) {
    const inner = candidates.find((c) => c !== best && best.contains(c) && textLength(c) >= 0.6 * textLength(best))
    if (!inner) break
    best = inner
  }
  return best
}

function removeNoise(main: El) {
  for (const el of [...main.querySelectorAll(NOISE_TAGS)]) {
    // a form around the whole content (some CMSs): keep what's in it
    if (el.tagName === 'FORM' && textLength(el as El) > 0.5 * textLength(main)) continue
    el.remove()
  }
  for (const el of [...main.querySelectorAll('[hidden], [aria-hidden="true"], [role=navigation], [role=banner], [role=contentinfo], [role=search], [role=dialog]')]) {
    // icons are often aria-hidden; pictures aren't
    if (el.tagName === 'IMG' || el.tagName === 'PICTURE' || el.querySelector('img')) continue
    el.remove()
  }
  for (const el of [...main.querySelectorAll('[class], [id]')]) {
    if (!el.isConnected) continue
    const name = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`
    if (!NOISE_NAME.test(name)) continue
    // only small things (a menu, a share bar) – never a big part of the content
    if (textLength(el as El) > 0.4 * textLength(main) && textLength(el as El) > 400) continue
    el.remove()
  }
  // the page's own header (site name, menu) – not a header inside the article
  for (const el of [...main.querySelectorAll('header')]) if (el.querySelector('nav, [role=navigation]') || /site|global|top/i.test(el.getAttribute('class') ?? '')) el.remove()
  // "¶" / "#" anchor links next to headings
  for (const a of [...main.querySelectorAll('a')]) {
    const t = (a.textContent ?? '').trim()
    if ((/^(#|¶|§|🔗)?$/.test(t) && (a.getAttribute('href') ?? '').startsWith('#') && !a.querySelector('img')) || /\b(anchor|hash-link|headerlink|heading-anchor|anchorjs-link)\b/.test(a.getAttribute('class') ?? '')) a.remove()
  }
}

// --- the page as Markdown --------------------------------------------------

interface Conv {
  base: URL
  /** a picture's address → its place in the note (a token markdownToNodes resolves) */
  picture(src: string): string | null
  /** a link's address → a note (when it's an imported page) or the absolute address */
  link(href: string): { note: string } | { url: string } | null
  /** an inline SVG drawing → a picture token */
  svg(markup: string): string | null
}

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'UL', 'CENTER', 'IFRAME', 'VIDEO', 'AUDIO', 'TBODY', 'THEAD', 'TR', 'CAPTION',
])

/** What icon pictures are called (Font Awesome, Feather, Lucide, Bootstrap, Octicons, emoji…). */
const ICON = /(^|[\s_-])(icon|icons|fa|fas|far|fab|svg-inline--fa|feather|lucide|bi|octicon|emoji|avatar|gravatar|logo)([\s_-]|$)/i

/**
 * An SVG from the page as a picture of its own: it may lean on the page (a
 * shared sprite through <use>, xlink without its namespace) – put in what it
 * needs, or leave it out if it can't stand alone.
 */
function standaloneSvg(el: El): string | null {
  const svg = el.cloneNode(true) as El
  for (const use of [...svg.querySelectorAll('use')]) {
    const ref = (use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '').trim()
    // a shape defined elsewhere on the page: copied in, or nothing to draw
    const target = ref.startsWith('#') ? el.ownerDocument.getElementById(ref.slice(1)) : null
    if (!target) return null
    const g = el.ownerDocument.createElement('g')
    for (const c of [...target.childNodes]) g.appendChild(c.cloneNode(true))
    use.replaceWith(g)
  }
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  let markup = svg.outerHTML
  if (/xlink:/.test(markup) && !/xmlns:xlink=/.test(markup)) markup = markup.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"')
  // colours taken from the page's text: black, as on a light page
  markup = markup.replace(/currentColor/g, '#000')
  return /<(path|rect|circle|ellipse|line|polyline|polygon|text|image|g)\b/.test(markup) ? markup : null
}

/** Text that Markdown must read as text. */
/** A picture's address without its size (WordPress's photo-300x200.jpg, a CDN's ?w=600): the same picture at any size. */
export function samePicture(src: string): string {
  if (!/^https?:/i.test(src)) return src
  try {
    const u = new URL(src)
    for (const k of [...u.searchParams.keys()]) if (/^(w|h|width|height|resize|fit|quality|q|crop|ssl|strip|dpr|format|auto)$/i.test(k)) u.searchParams.delete(k)
    u.pathname = u.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.\w{3,4}$)/, '').replace(/-scaled(?=\.\w{3,4}$)/, '')
    return u.href
  } catch {
    return src
  }
}

function esc(s: string): string {
  return s.replace(/([\\`*_[\]<>|~!#])/g, '\\$1')
}

function fence(code: string): string {
  let ticks = '```'
  while (code.includes(ticks)) ticks += '`'
  return ticks
}

function bestSrc(img: El, base: URL): string | null {
  const attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'srcset', 'src']
  let pick: string | null = null
  // the largest from a srcset; else the first plain source
  const set = img.getAttribute('srcset') ?? img.getAttribute('data-srcset')
  if (set) {
    const parts = set
      .split(/,\s+(?=\S)/)
      .map((p) => p.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([u, d]) => ({ u, w: d ? parseFloat(d) || 1 : 1 }))
    if (parts.length) pick = parts.sort((a, b) => b.w - a.w)[0].u
  }
  for (const a of attrs) {
    if (pick) break
    const v = img.getAttribute(a)
    if (v && !a.includes('srcset') && !/^data:image\/(gif|png);base64,R0lGOD|^data:image\/svg\+xml.*%3Csvg%20xmlns.*%3E%3C\/svg%3E$/i.test(v)) pick = v
  }
  // a <picture>'s sources
  if (!pick && img.parentElement?.tagName === 'PICTURE') {
    const s = img.parentElement.querySelector('source[srcset]')?.getAttribute('srcset')
    if (s) pick = s.split(',')[0].trim().split(/\s+/)[0]
  }
  if (!pick) return null
  if (pick.startsWith('data:')) return pick
  try {
    return new URL(pick, base).href
  } catch {
    return null
  }
}

function pageToMarkdown(main: El, conv: Conv): string {
  const inline = (node: Node, inPre = false): string => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? ''
      return inPre ? t : esc(t.replace(/\s+/g, ' '))
    }
    if (node.nodeType !== 1) return ''
    const el = node as El
    const kids = () => [...el.childNodes].map((c) => inline(c, inPre)).join('')
    switch (el.tagName) {
      case 'BR':
        return '\\\n'
      case 'STRONG':
      case 'B': {
        const t = kids()
        return t.trim() ? wrap(t, '**') : t
      }
      case 'EM':
      case 'I':
      case 'CITE':
      case 'DFN': {
        const t = kids()
        return t.trim() ? wrap(t, '*') : t
      }
      case 'DEL':
      case 'S':
      case 'STRIKE': {
        const t = kids()
        return t.trim() ? wrap(t, '~~') : t
      }
      case 'CODE':
      case 'KBD':
      case 'SAMP':
      case 'TT': {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ')
        if (!t.trim()) return ''
        let ticks = '`'
        while (t.includes(ticks)) ticks += '`'
        return `${ticks}${t.startsWith('`') ? ' ' : ''}${t}${t.endsWith('`') ? ' ' : ''}${ticks}`
      }
      case 'A': {
        const t = kids()
        const href = el.getAttribute('href')
        const target = href ? conv.link(href) : null
        // a picture inside the link (a "card"): the picture, then the link on its text
        const pics = t.match(/\n\n!\[[^\]]*\]\([^)]*\)\n\n/g) ?? []
        const words = pics.reduce((x, p) => x.replace(p, ' '), t)
        const link = (label: string) => {
          // spaces outside the link, not underlined inside it
          const lead = /^\s*/.exec(label)![0]
          const trail = /\s*$/.exec(label)![0]
          const inner = label.trim()
          if (!target || !inner) return label
          if ('note' in target) return `${lead}[${inner.replace(/\]/g, '\\]')}](${target.note})${trail}`
          return `${lead}[${inner}](<${target.url.replace(/>/g, '%3E')}>)${trail}`
        }
        return pics.length ? `${pics.join('')}${link(words)}` : link(t)
      }
      case 'IMG':
        return image(el)
      case 'SVG':
      case 'svg':
        return svg(el)
      case 'PICTURE': {
        const img = el.querySelector('img')
        return img ? image(img as El) : ''
      }
      case 'SUP':
        return kids() ? `^${kids()}` : ''
      case 'INPUT':
        return ''
      default:
        return kids()
    }
  }
  const wrap = (t: string, m: string) => {
    // markers hug the words ("**bold** text", not "** bold **")
    const lead = /^\s*/.exec(t)![0]
    const trail = /\s*$/.exec(t)![0]
    return `${lead}${m}${t.trim()}${m}${trail}`
  }
  const image = (img: El) => {
    const w = parseFloat(img.getAttribute('width') ?? '0')
    const h = parseFloat(img.getAttribute('height') ?? '0')
    if ((w && w <= 2) || (h && h <= 2)) return '' // tracking pixels
    const alt = (img.getAttribute('alt') ?? '').replace(/[[\]\n]/g, ' ').trim()
    // icons (a calendar by the date, a clock by the reading time) aren't content
    if ((w && w <= 40 && (!h || h <= 40)) || (h && h <= 40 && !w) || ICON.test(img.getAttribute('class') ?? '')) return ''
    const src = bestSrc(img, conv.base)
    const token = src ? conv.picture(src) : null
    return token ? `\n\n![${alt}](${token})\n\n` : alt ? esc(alt) : ''
  }
  const svg = (el: El) => {
    // small icons aren't content; a diagram drawn in SVG is
    const w = parseFloat(el.getAttribute('width') ?? '0')
    const h = parseFloat(el.getAttribute('height') ?? '0')
    const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    const size = Math.max(w, h) || Math.max(vb[2] || 0, vb[3] || 0)
    if (!size || size < 64 || ICON.test(el.getAttribute('class') ?? '') || el.getAttribute('aria-hidden') === 'true') return ''
    const markup = standaloneSvg(el)
    const token = markup ? conv.svg(markup) : null
    return token ? `\n\n![](${token})\n\n` : ''
  }

    /** A line of a table of contents: a paragraph that's only a link to a place in the page. */
  const isContentsLine = (n: Node): boolean => {
    if (n.nodeType !== 1 || !/^(P|DIV)$/.test((n as El).tagName)) return false
    const links = (n as El).querySelectorAll('a')
    if (links.length !== 1 || !(links[0].getAttribute('href') ?? '').startsWith('#') || (n as El).querySelector('p, div, img, table')) return false
    const t = textLength(n as El)
    return t > 0 && t === textLength(links[0] as El)
  }
  const indentOf = (el: El) => Number(el.getAttribute('data-rn-indent') ?? 0)

  /** A run of mixed inline / block children as Markdown blocks. */
  const blocks = (parent: El, depth = 0): string[] => {
    const out: string[] = []
    let run = ''
    const flush = () => {
      for (const part of run.split(/\n\n+/)) {
        const p = part.replace(/^[ \t]+|[ \t]+$/gm, '').replace(/^(\\\n)+|(\\\n)+$/g, '').trim()
        if (p) out.push(/^!\[/.test(p) ? p : startSafe(p))
      }
      run = ''
    }
    const kids = [...parent.childNodes]
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k]
      // a table of contents (paragraphs that are each just a link to a heading): a list, nested as it was indented
      if (isContentsLine(c)) {
        const run: El[] = []
        let j = k
        for (; j < kids.length; j++) {
          const x = kids[j]
          if (isContentsLine(x)) run.push(x as El)
          else if (!(x.nodeType === 3 && !(x.textContent ?? '').trim()) && !(x.nodeType === 1 && (x as El).tagName === 'P' && !textLength(x as El) && !(x as El).querySelector('img'))) break
        }
        if (run.length >= 3) {
          flush()
          const levels = [...new Set(run.map(indentOf))].sort((a, b) => a - b)
          out.push(run.map((p) => `${'  '.repeat(levels.indexOf(indentOf(p)))}- ${inline(p).replace(/\s+/g, ' ').trim()}`).join('\n'))
          k = j - 1
          continue
        }
      }
      if (c.nodeType === 1 && (BLOCK.has((c as El).tagName) || (c as El).tagName === 'IMG' && !parent.closest('p, a, li, td, th'))) {
        flush()
        out.push(...block(c as El, depth))
      } else run += inline(c)
    }
    flush()
    return out.filter(Boolean)
  }

  const block = (el: El, depth: number): string[] => {
    const tag = el.tagName
    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const t = inline(el).replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim()
        return t ? [`${'#'.repeat(Number(tag[1]))} ${t}`] : []
      }
      case 'P':
        return blocks(el, depth)
      case 'HR':
        return ['---']
      case 'PRE': {
        const code = el.querySelector('code') ?? el
        // the language is on the code, the pre, or a wrapper or two around it (Sphinx, Docusaurus…)
        const cls = [code, el, el.parentElement, el.parentElement?.parentElement].map((x) => x?.getAttribute('class') ?? '').join(' ')
        const lang = /(?:language|lang|highlight-source|highlight)-([\w+#-]+)/.exec(cls)?.[1] ?? el.getAttribute('data-lang') ?? ''
        const text = (code.textContent ?? '').replace(/\n$/, '')
        const f = fence(text)
        return [`${f}${lang}\n${text}\n${f}`]
      }
      case 'BLOCKQUOTE': {
        const inner = blocks(el, depth).join('\n\n')
        return inner ? [inner.split('\n').map((l) => `> ${l}`).join('\n')] : []
      }
      case 'UL':
      case 'OL': {
        const items = [...el.children].filter((c) => c.tagName === 'LI') as El[]
        if (!items.length) return blocks(el, depth)
        const start = Number(el.getAttribute('start') ?? 1) || 1
        const lines = items.map((li, i) => {
          const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox], :scope > label > input[type=checkbox]')
          const marker = tag === 'OL' ? `${start + i}. ` : box ? `- [${box.hasAttribute('checked') ? 'x' : ' '}] ` : '- '
          const inner = blocks(li, depth + 1)
          const body = (inner.length ? inner : ['']).join('\n\n')
          const pad = ' '.repeat(marker.length)
          return marker + body.split('\n').map((l, j) => (j === 0 || !l ? l : pad + l)).join('\n')
        })
        // items with blocks inside: a loose list, else a tight one
        return [lines.join(lines.some((l) => l.includes('\n\n')) ? '\n\n' : '\n')]
      }
      case 'TABLE':
        return [table(el)]
      case 'FIGURE': {
        const cap = el.querySelector('figcaption')
        cap?.remove()
        const inner = blocks(el, depth)
        const c = cap ? inline(cap).replace(/\s+/g, ' ').trim() : ''
        return c ? [...inner, `*${c}*`] : inner
      }
      case 'DL': {
        const out: string[] = []
        for (const c of [...el.children]) {
          if (c.tagName === 'DT') {
            const t = inline(c).trim()
            if (t) out.push(`**${t}**`)
          } else if (c.tagName === 'DD') out.push(...blocks(c as El, depth))
          else out.push(...blocks(c as El, depth))
        }
        return out
      }
      case 'DETAILS': {
        const sum = el.querySelector(':scope > summary')
        sum?.remove()
        const t = sum ? inline(sum).trim() : ''
        return [...(t ? [`**${t}**`] : []), ...blocks(el, depth)]
      }
      case 'IFRAME':
      case 'VIDEO':
      case 'AUDIO': {
        const src = el.getAttribute('src') ?? el.querySelector('source')?.getAttribute('src')
        if (!src) return []
        let url: string
        try {
          url = new URL(src, conv.base).href
        } catch {
          return []
        }
        // a video (YouTube, Vimeo, a video file): one that plays in the note
        const title = (el.getAttribute('title') ?? '').trim()
        if (videoInfo(url)) return [videoToken(url, title)]
        const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/.exec(url)
        if (yt) url = `https://www.youtube.com/watch?v=${yt[1]}`
        const label = tag === 'AUDIO' ? 'Audio' : yt || tag === 'VIDEO' || /vimeo|video/.test(url) ? 'Video' : (el.getAttribute('title') ?? 'Embedded content')
        return [`${esc(label)}: [${esc(url)}](<${url}>)`]
      }
      case 'IMG': {
        const t = image(el).trim()
        return t ? [t] : []
      }
      default:
        return blocks(el, depth)
    }
  }

  const table = (t: El): string => {
    const rows = [...t.querySelectorAll('tr')].filter((r) => r.closest('table') === t) as El[]
    if (!rows.length) return blocks(t).join('\n\n')
    const cell = (c: El) => {
      // a cell is one line in Markdown: its blocks side by side, pictures kept
      const text = blocks(c)
        .join(' ')
        .replace(/\n+/g, ' ')
        .replace(/\\\s/g, ' ')
        .replace(/(?<!\\)\|/g, '\\|')
        .trim()
      return text || ' '
    }
    const grid = rows.map((r) => {
      const out: string[] = []
      for (const c of [...r.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH') as El[]) {
        out.push(cell(c))
        // spanning cells keep the columns lined up
        for (let i = 1; i < Math.min(20, Number(c.getAttribute('colspan') ?? 1)); i++) out.push(' ')
      }
      return out
    })
    const cols = Math.max(...grid.map((r) => r.length))
    if (!cols) return ''
    const line = (r: string[]) => `| ${[...r, ...Array(cols - r.length).fill(' ')].join(' | ')} |`
    const hasHeader = rows[0].querySelector('th') || rows[0].closest('thead')
    const header = hasHeader ? grid[0] : Array(cols).fill(' ')
    const body = hasHeader ? grid.slice(1) : grid
    const cap = t.querySelector('caption')
    return [cap ? `*${inline(cap).trim()}*\n\n` : '', line(header), `| ${Array(cols).fill('---').join(' | ')} |`, ...body.map(line)].join('\n').replace(/^\n+/, '')
  }

  return blocks(main).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * A video, written so that Markdown leaves it alone (no address it could
 * turn into a link): its own paragraph, made into a video block when the
 * note is written.
 */
const hex = (s: string) => Buffer.from(s).toString('hex')
function videoToken(url: string, title: string): string {
  return `⟦VIDEO:${hex(url)}:${hex(title)}⟧`
}
export function videoBlock(text: string): Y.XmlElement | null {
  const m = /^⟦VIDEO:([0-9a-f]*):([0-9a-f]*)⟧$/.exec(text)
  if (!m) return null
  const el = new Y.XmlElement('video')
  el.setAttribute('src', Buffer.from(m[1], 'hex').toString())
  el.setAttribute('title', Buffer.from(m[2], 'hex').toString())
  return el
}

/**
 * Rule numbers (G206, R104…) mentioned in the pages, linked to the page that
 * defines the rule (where it starts a line, a heading or a bold lead-in) –
 * like a manual's own cross-references. Only numbers some page defines.
 */
export function linkRules(markdowns: string[]): string[] {
  const defined = new Map<string, number>()
  markdowns.forEach((md, page) => {
    for (const m of md.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s+|\*\*|\*|>\s*)*([A-Z]{1,3}\d{2,4})\b/g)) if (!defined.has(m[1])) defined.set(m[1], page)
  })
  // rules come in families (G301, G302, G303…); a part number or two (RS775) isn't one
  const family = new Map<string, number>()
  for (const id of defined.keys()) {
    const prefix = /^[A-Z]+/.exec(id)![0]
    family.set(prefix, (family.get(prefix) ?? 0) + 1)
  }
  for (const id of [...defined.keys()]) if ((family.get(/^[A-Z]+/.exec(id)![0]) ?? 0) < 3) defined.delete(id)
  if (!defined.size) return markdowns
  return markdowns.map((md) => {
    let fenced = false
    return md
      .split('\n')
      .map((line) => {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
        if (fenced || /^#{1,6}\s/.test(line)) return line
        // not inside code, links, pictures or addresses
        return line
          .split(/(`[^`]*`|!?\[[^\]]*\]\([^)]*\)|<[^>]*>)/)
          .map((part, k) => {
            if (k % 2) return part
            return part.replace(/(^|[^\p{L}\p{N}\\-])([A-Z]{1,3}\d{2,4})\b/gu, (all, pre: string, id: string, at: number) => {
              const page = defined.get(id)
              if (page === undefined) return all
              // the rule's own definition (it starts the line): not a link to itself
              if (k === 0 && /^\s*(?:[-*]\s+|\*\*|\*|>\s*)*$/.test(part.slice(0, at + pre.length))) return all
              return `${pre}[${id}](rnrule-${page}-${id})`
            })
          })
          .join('')
      })
      .join('\n')
  })
}

/** A paragraph mustn't start like a list item or a numbered one. */
function startSafe(p: string): string {
  return p.replace(/^([-+])(\s)/, '\\$1$2').replace(/^(\d+)([.)])(\s)/, '$1\\$2$3').replace(/^(=+|-+)$/m, (m) => `\\${m}`)
}

// --- following a guide's pages ---------------------------------------------

/** A page's address without the part after # (and the trailing slash), to tell pages apart. */
function pageKey(u: URL): string {
  return `${u.origin}${u.pathname.replace(/\/(index\.html?)?$/i, '') || '/'}${u.search}`
}

/** The links on a page that are pages of the same guide (under the same address), in order. */
function guideLinks(doc: Document, pageUrl: URL, scope: URL): URL[] {
  const dir = scope.pathname.endsWith('/') ? scope.pathname : path.posix.dirname(scope.pathname) + '/'
  const out: URL[] = []
  for (const a of doc.querySelectorAll('a[href]')) {
    let u: URL
    try {
      u = new URL(a.getAttribute('href')!, pageUrl)
    } catch {
      continue
    }
    if (u.origin !== scope.origin || !(u.pathname + '/').startsWith(dir) && u.pathname !== scope.pathname) continue
    // pages, not files to download
    if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|gz|tar|mp4|mp3|webm|css|js|json|xml|txt|ico|woff2?)$/i.test(u.pathname)) continue
    u.hash = ''
    out.push(u)
  }
  return out
}

// --- the import -------------------------------------------------------------

interface Page {
  url: URL
  title: string
  html: string
  doc: Document
  /** a section of a PDF: the pages it's on */
  pdfPages?: [number, number]
}

function titleOf(doc: Document, main: El, url: URL): string {
  const h1 = main.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
  const t = doc.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim()
  // "Page – Site name": the page part
  const short = t?.split(/\s+[|–—·•»-]\s+/)[0]?.trim()
  return h1 || og || short || t || url.hostname + url.pathname
}

/**
 * The address a wrapped link goes to: Google's "Redirect Notice"
 * (google.com/url?q=…), Outlook's safe links, Facebook's l.php – a link
 * copied out of a Google Doc or an email is often one of these.
 */
export function unwrapLink(href: string): string {
  for (let i = 0; i < 3; i++) {
    let u: URL
    try {
      u = new URL(href)
    } catch {
      return href
    }
    const host = u.hostname.replace(/^www\./, '')
    const inner =
      (/^google\.[a-z.]+$/.test(host) && u.pathname === '/url' && (u.searchParams.get('q') || u.searchParams.get('url'))) ||
      (/safelinks\.protection\.outlook\.com$/.test(host) && u.searchParams.get('url')) ||
      (/^l\.(facebook|instagram)\.com$/.test(host) && u.searchParams.get('u'))
    if (!inner || !/^https?:\/\//i.test(inner)) return href
    href = inner
  }
  return href
}

export async function importWebPages(config: Config, store: Store, ai: Ai, sync: SyncEngine, opts: WebImportOptions): Promise<WebImportResult> {
  let start: URL
  try {
    // a PDF from this device has no address of its own
    start = opts.pdfAttachmentId ? new URL('https://pdf.reconnotes/upload') : new URL(unwrapLink(opts.url.trim()))
  } catch {
    throw new Error('That isn’t a web address – it should start with https://')
  }
  if (!/^https?:$/.test(start.protocol)) throw new Error('Only http:// and https:// addresses can be imported.')
  const maxPages = opts.follow ? Math.min(PAGE_LIMIT, Math.max(1, opts.maxPages ?? 50)) : 1
  const notes: string[] = []
  // a page on your own network may use addresses on it; one from the internet may not (netGuard.ts)
  const local = !opts.pdfAttachmentId && (await isPrivateHost(start.hostname))

  // 1. the pages (the first, then the guide's pages in the order they're linked)
  const pages: Page[] = []
  const seen = new Set<string>([pageKey(start)])
  const queue: URL[] = [start]
  let scope = start
  /** a PDF manual: the file (kept, and linked from the contents) */
  let pdf: { name: string; data: Buffer; attachmentId?: string } | null = null
  // a PDF from this device (uploaded as an attachment): its chapters as notes
  if (opts.pdfAttachmentId) {
    const att = store.getAttachment(opts.pdfAttachmentId)
    if (!att || !store.hasBlob(att.id)) throw new Error('The PDF hasn’t reached the server yet – try again in a moment.')
    const data = fs.readFileSync(store.blobPath(att.id))
    const split = await pdfPages(data, new URL(`https://pdf.reconnotes/${encodeURIComponent(att.name || 'Document.pdf')}`), Boolean(opts.splitPdf))
    pdf = { name: att.name || 'Document.pdf', data, attachmentId: att.id }
    pages.push(...split)
    queue.length = 0
  }
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!
    reportProgress(opts.follow ? `Reading page ${pages.length + 1} of up to ${Math.min(maxPages, pages.length + 1 + queue.length)}…` : 'Reading the page…')
    let got: { data: Buffer; type: string; url: string }
    try {
      got = await fetchWithLimit(url.href, 'text/html,application/xhtml+xml,*/*;q=0.8', MAX_HTML, 30_000, local)
    } catch (e) {
      if (!pages.length) throw new Error(`Couldn’t get the page: ${(e as Error).message}`)
      notes.push(`${url.href}: ${(e as Error).message}`)
      continue
    }
    const finalUrl = new URL(got.url)
    // a PDF (a manual as one file): its chapters as notes – or, without text in it, a note holding it
    if (got.type === 'application/pdf' || /\.pdf$/i.test(finalUrl.pathname)) {
      if (pages.length) continue
      const name = decodeURIComponent(path.posix.basename(finalUrl.pathname)) || 'Document.pdf'
      const split = await pdfPages(got.data, finalUrl, Boolean(opts.splitPdf)).catch(() => null)
      if (!split) return importFile(config, store, ai, sync, got.data, 'application/pdf', name, finalUrl, opts.folderId ?? null)
      pdf = { name, data: got.data }
      pages.push(...split)
      break
    }
    if (!/html|xml|^text\/plain$|^$/.test(got.type)) {
      if (!pages.length) throw new Error(`That address is a ${got.type} file, not a web page.`)
      continue
    }
    const html = decodeHtml(got.data, got.type)
    const { document } = parseHTML(html)
    if (!pages.length) scope = finalUrl // after redirects
    seen.add(pageKey(finalUrl))
    pages.push({ url: finalUrl, title: '', html, doc: document as unknown as Document })
    if (opts.follow)
      for (const u of guideLinks(document as unknown as Document, finalUrl, scope)) {
        const k = pageKey(u)
        if (seen.has(k)) continue
        seen.add(k)
        queue.push(u)
      }
    // a moment between pages: polite to the site
    if (opts.follow && queue.length) await new Promise((r) => setTimeout(r, 150))
  }
  if (opts.follow && queue.length) notes.push(`Stopped at ${maxPages} pages; ${queue.length} more weren’t imported.`)

  // 2. each page's content and title – and a recipe page's recipe, from the data it gives search engines (recipe.ts)
  const recipes = pages.map((p) =>
    p.pdfPages ? null : recipeIn([...p.doc.querySelectorAll('script[type="application/ld+json"]')].map((el) => el.textContent ?? '')),
  )
  const mains = pages.map((p, i) => {
    markIndents(p.doc)
    const gdoc = googleDoc(p.doc)
    const main = gdoc?.main ?? findMain(p.doc)
    // the site's own recipe card: the one made from the data replaces it
    if (recipes[i]) for (const el of [...main.querySelectorAll(SITE_RECIPE_CARDS)]) el.remove()
    removeNoise(main)
    p.title = recipes[i]?.name || gdoc?.title || titleOf(p.doc, main, p.url)
    return main
  })
  // checking for updates: the notes the pages went into before
  const prev = opts.update ?? null
  const meta = sync.noteMeta()
  const alive = (id: string | undefined) => Boolean(id && meta.get(id) && !meta.get(id)!.trashedAt)
  const ids = pages.map((p) => {
    const was = prev?.pages[pageKey(p.url)]?.noteId
    return alive(was) ? was! : newId()
  })
  const isNew = pages.map((p, i) => ids[i] !== prev?.pages[pageKey(p.url)]?.noteId)
  const byKey = new Map(pages.map((p, i) => [pageKey(p.url), i]))
  /** headings links point at (page#section): what to find when the link is followed */
  const finds: string[] = []

  // 3. pictures, downloaded once each
  const pictures = new Map<string, { id: string; name: string; mime: string; size: number } | null>()
  const tokens = new Map<string, string>() // token in the Markdown → picture address
  let failedPictures = 0
  /** tiny pictures (icons): left out without a trace */
  const icons = new Set<string>()
  const pictureToken = (src: string) => {
    // a picture that turned out to be an icon: as if it weren't there
    if (icons.has(src)) return null
    if (tokens.size >= MAX_PICTURES && ![...tokens.values()].includes(src)) return null
    const token = `rnpic-${tokens.size}`
    // the same picture at another size (photo-300x200.jpg, ?w=600): the same picture
    const key = samePicture(src)
    for (const [t, s] of tokens) if (s === src || samePicture(s) === key) return t
    tokens.set(token, src)
    return token
  }
  const svgs = new Map<string, Buffer>()
  const svgToken = (markup: string) => {
    if (markup.length > 2 * 1024 * 1024) return null
    // the same drawing (and on the second pass) is the same picture
    const key = `svg:${crypto.createHash('sha1').update(markup).digest('hex')}`
    const token = pictureToken(key)
    if (token) svgs.set(key, Buffer.from(markup))
    return token
  }

  // twice: first (on a copy) to find the pictures, then – once they're downloaded
  // and the icons among them known – for real
  const convert = (i: number, main: El) =>
    pageToMarkdown(main, {
      base: pages[i].url,
      picture: pictureToken,
      svg: svgToken,
      link: (href) => {
        if (/^(javascript|mailto|tel):/i.test(href) && !/^(mailto|tel):/i.test(href)) return null
        let u: URL
        try {
          u = new URL(href, pages[i].url)
        } catch {
          return null
        }
        if (/^(mailto|tel):$/.test(u.protocol)) return { url: u.href }
        const k = pageKey(u)
        const target = byKey.get(k)
        // a heading on that page (page#section, or #section on this one): open the note there
        const anchor = u.hash.slice(1) ? decodeURIComponent(u.hash.slice(1)) : ''
        const heading = target !== undefined && anchor ? pages[target].doc.getElementById(anchor)?.textContent?.replace(/[#¶§]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : ''
        if (target !== undefined && (target !== i || heading)) {
          if (!heading) return { note: `rnpage-${target}` }
          finds.push(heading)
          return { note: `rnpage-${target}~${finds.length - 1}` }
        }
        // a link within the same page to something that isn't a heading: just its text
        if (target === i) return null
        return /^https?:$/.test(u.protocol) ? { url: u.href } : null
      },
    })
  // a recipe page: its card first, then (unless left out) the rest of the article
  const withCard = (i: number, md: string) => {
    const r = recipes[i]
    if (!r) return md
    let photo: string | null = null
    try {
      photo = r.image ? pictureToken(new URL(r.image, pages[i].url).href) : null
    } catch {
      photo = null
    }
    const card = recipeCard(r, photo, esc)
    if (opts.recipeArticle === false) return card
    const article = md.replace(/^#\s[^\n]*\n+/, '').trim()
    return article ? `${card}\n\n## From the article\n\n${article}` : card
  }
  const first = pages.map((_, i) => withCard(i, convert(i, mains[i].cloneNode(true) as El)))
  // each page's content, comparable between imports (pictures by their address)
  const contentOf = (md: string) => md.replace(/rnpic-\d+/g, (t) => tokens.get(t) ?? t).replace(/rnpage-\d+(~\d+)?/g, 'page')
  const hashes = first.map((md) => crypto.createHash('sha1').update(contentOf(md)).digest('hex'))
  // what to write: every page, or – checking for updates – the new and the changed ones
  const write = pages.map((p, i) => !prev || isNew[i] || prev.pages[pageKey(p.url)]?.hash !== hashes[i])

  const wanted = new Set(first.filter((_, i) => write[i]).flatMap((md) => md.match(/rnpic-\d+/g) ?? []))
  /** a picture that's the same file as one before it: that one (shown once) */
  const sameAs = new Map<string, string>()
  const byHash = new Map<string, string>()
  let blocked = 0
  const total = wanted.size
  let done = 0
  for (const [token, src] of tokens) {
    if (!wanted.has(token)) continue
    done++
    if (done % 5 === 1 || done === total) reportProgress(`Downloading pictures: ${done} of ${total}…`)
    try {
      let data: Buffer
      let mime: string
      let name: string
      if (src.startsWith('svg:')) {
        data = svgs.get(src)!
        mime = 'image/svg+xml'
        name = 'drawing.svg'
      } else if (src.startsWith('data:')) {
        const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src)
        if (!m || !m[1].startsWith('image/')) throw new Error('not a picture')
        data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
        mime = m[1]
        name = `picture.${mime.split('/')[1].replace('svg+xml', 'svg')}`
      } else {
        const got = await fetchWithLimit(src, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5', MAX_PICTURE, 20_000, local)
        mime = got.type.startsWith('image/') ? got.type : mimeFromName(src) ?? ''
        if (!mime.startsWith('image/')) throw new Error('not a picture')
        data = got.data
        name = decodeURIComponent(path.posix.basename(new URL(got.url).pathname)) || 'picture'
        if (!/\.\w{2,5}$/.test(name)) name += `.${mime.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`
      }
      // really a picture (not an error page), and not an icon
      const dims = pictureSize(data, mime)
      if (!dims) throw new Error('not a picture')
      if (dims.w && dims.h && dims.w <= 40 && dims.h <= 40) {
        icons.add(src)
        pictures.set(src, null)
        continue
      }
      // the very same picture again (the site shows it twice): once
      const hash = crypto.createHash('sha1').update(data).digest('hex')
      const firstToken = byHash.get(hash)
      if (firstToken) {
        sameAs.set(token, firstToken)
        pictures.set(src, pictures.get(tokens.get(firstToken)!) ?? null)
        continue
      }
      byHash.set(hash, token)
      const a = { id: newId(), name: name.slice(0, 120), mime, size: data.length }
      store.putAttachment({ id: a.id, mime, name: a.name, size: a.size, created_at: Date.now() }, data, initialTextStatus(config, ai, mime, a.name))
      queueAttachment(config, store, ai, sync, a.id)
      pictures.set(src, a)
    } catch (e) {
      pictures.set(src, null)
      if (/on your own network/.test((e as Error).message)) blocked++
      else failedPictures++
    }
  }
  if (blocked) notes.push(`${blocked} picture${blocked === 1 ? ' was' : 's were'} left out: on your own network, which a page from the internet can’t make the server reach.`)
  if (failedPictures) notes.push(`${failedPictures} picture${failedPictures === 1 ? '' : 's'} couldn’t be downloaded (kept as links).`)

  // rule numbers ("see G206") linked to the page where the rule is written
  const markdowns = linkRules(pages.map((_, i) => withCard(i, convert(i, mains[i]))))

  // 4. the notes (in a folder of their own when there are several, with a contents note first)
  const when = new Date().toISOString().slice(0, 10)
  /** "Oct 9, 2026": for titles */
  const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const multi = pages.length > 1 || Boolean(prev?.follow)
  const folders = sync.getDoc(WORKSPACE_DOC) ? listFolders(sync.getDoc(WORKSPACE_DOC)!) : []
  let folderId = prev?.folderId && folders.some((f) => f.id === prev.folderId && !f.trashedAt) ? prev.folderId : null
  let contentsId = prev?.contentsNoteId && alive(prev.contentsNoteId) ? prev.contentsNoteId : null
  const contentsNew = multi && !contentsId
  if (contentsNew) contentsId = newId()
  await sync.change(WORKSPACE_DOC, (ws) => {
    if (multi && !folderId) {
      folderId = createFolder(ws, { name: (pdf ? pdf.name.replace(/\.pdf$/i, '') : pages[0].title).slice(0, 80), parentId: opts.folderId ?? null })
      // in the guide's order
      updateFolder(ws, folderId, { sort: 'manual' })
    }
    if (!multi && !prev) folderId = opts.folderId ?? null
    if (contentsNew) createNote(ws, { id: contentsId!, folderId, title: `${pdf ? pdf.name.replace(/\.pdf$/i, '') : pages[0].title} – Contents` })
    pages.forEach((p, i) => {
      if (!isNew[i]) return
      createNote(ws, { id: ids[i], folderId: folderId ?? prev?.folderId ?? opts.folderId ?? null, title: p.title })
      updateNote(ws, ids[i], { source: p.url.href })
    })
  })

  // the PDF itself, kept with the notes (its text is already in them: not read again by the AI)
  let pdfAtt: { id: string; name: string; mime: string; size: number } | null = null
  if (pdf) {
    const id = pdf.attachmentId ?? newId()
    if (!pdf.attachmentId) store.putAttachment({ id, mime: 'application/pdf', name: pdf.name, size: pdf.data.length, created_at: Date.now() }, pdf.data, 'skipped')
    pdfAtt = { id, name: pdf.name, mime: 'application/pdf', size: pdf.data.length }
  }
  const ctx = {
    attach: (href: string) => {
      if (href === 'rnpdf') return pdfAtt
      const src = tokens.get(href)
      const a = src ? pictures.get(src) : null
      return a ?? null
    },
    blockFor: videoBlock,
    noteFor: (target: string) => {
      const m = /^rn(?:page|rule)-(\d+)/.exec(target)
      return m ? (ids[Number(m[1])] ?? null) : null
    },
    findFor: (target: string) => {
      const rule = /^rnrule-\d+-(\w+)$/.exec(target)?.[1]
      if (rule) return rule
      const f = /^rnpage-\d+~(\d+)$/.exec(target)?.[1]
      return f !== undefined ? (finds[Number(f)] ?? null) : null
    },
  }
  const pageText = (i: number) => {
    const p = pages[i]
    // pictures that didn't come: icons left out, the others a link to where they are
    // each picture once (the same one again – another size, the same file – left out)
    const shown = new Set<string>()
    let md = markdowns[i].replace(/!\[([^\]]*)\]\((rnpic-\d+)\)/g, (m, alt: string, token: string) => {
      const canon = sameAs.get(token) ?? token
      if (shown.has(canon)) return ''
      shown.add(canon)
      if (canon !== token) return `![${alt}](${canon})`
      const src = tokens.get(token)
      if (!src || pictures.get(src)) return m
      if (icons.has(src) || src.startsWith('svg:') || src.startsWith('data:')) return ''
      return `[${alt || 'Picture'}](<${src}>)`
    })
    // the title first (as the page's own first heading, or added)
    if (!/^#\s/.test(md)) md = `# ${esc(p.title)}\n\n${md}`
    // where it came from, under the title (and when it last changed)
    const imported = prev?.pages[pageKey(p.url)]?.importedOn ?? when
    const change = changes.get(i)
    const where = p.pdfPages
      ? `${pdfSource(p.url, pdf?.name ?? 'the PDF')}, page${p.pdfPages[0] === p.pdfPages[1] ? ` ${p.pdfPages[0]}` : `s ${p.pdfPages[0]}–${p.pdfPages[1]}`}`
      : `[${esc(p.url.host + p.url.pathname.replace(/\/$/, ''))}](<${p.url.href}>)`
    const source = `*From ${where} · imported ${imported}${change ? ` · updated ${when}: ${change}` : ''}*`
    // a PDF that's one part: the file itself at the end of its note
    if (pdf && !multi) md += '\n\nThe original PDF:\n\n[original](rnpdf)'
    return md.replace(/^(#[^\n]*\n)/, `$1\n${source}\n`)
  }
  // what changed on a page since it was imported (paragraphs added and removed)
  const changes = new Map<number, string>()
  const updated: string[] = []
  const kept: string[] = []
  for (let i = 0; i < pages.length; i++) {
    if (!prev || isNew[i] || !write[i]) continue
    const before = new Set((store.getSetting<string>(`webPage:${ids[i]}`) ?? '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean))
    const after = contentOf(first[i]).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
    const added = after.filter((x) => !before.has(x)).length
    const removed = [...before].filter((x) => !after.includes(x)).length
    changes.set(i, [added && `${added} paragraph${added === 1 ? '' : 's'} new or changed`, removed && `${removed} removed`].filter(Boolean).join(', ') || 'small changes')
  }

  for (let i = 0; i < pages.length; i++) {
    if (!write[i]) continue
    reportProgress(pages.length > 1 ? `Writing note ${i + 1} of ${pages.length}…` : 'Writing the note…')
    const p = pages[i]
    const md = pageText(i)
    if (mains[i] && textLength(mains[i]) < 200 && /__next|__nuxt|id="root"|id="app"|ng-version|data-reactroot/.test(p.html))
      notes.push(`${p.url.href}: the page builds its content with JavaScript in the browser, so only part of it (or none) could be read.`)
    let target = ids[i]
    let newTitle = ''
    let yours = ''
    if (prev && !isNew[i]) {
      // changed on the site: the note follows – unless you've edited it, which then stays yours
      const rec = prev.pages[pageKey(p.url)]!
      const m = sync.noteMeta().get(ids[i])
      if (m && m.updatedAt > rec.at + 15_000) {
        target = newId()
        // named after your note (you may have renamed it): what it is – the site's version of it, and when
        newTitle = `${m.title || p.title} – latest from the site (${day})`
        yours = m.title || p.title
        await sync.change(WORKSPACE_DOC, (ws) => {
          createNote(ws, { id: target, folderId: m.folderId, title: newTitle })
          updateNote(ws, target, { source: p.url.href })
        })
        await sync.change(noteDocName(ids[i]), (doc) => {
          const frag = getContent(doc)
          const notice = markdownToNodes(`*⚠️ This page has changed on the site (${changes.get(i)}). You’ve edited this note, so it’s kept as it is – the new version: [${esc(newTitle)}](rnnew)*`, {
            attach: () => null,
            noteFor: (t) => (t === 'rnnew' ? target : null),
          })
          frag.insert(Math.min(1, frag.length), notice)
        })
        kept.push(p.title)
      } else {
        await sync.change(noteDocName(ids[i]), (doc) => {
          const frag = getContent(doc)
          frag.delete(0, frag.length)
        })
        updated.push(p.title)
      }
    }
    // the new version of a note you've edited: its title says so
    const text =
      target === ids[i]
        ? md
        : md
            .replace(/^# .*$/m, `# ${esc(newTitle)}`)
            .replace(/^(\*From [^\n]*\*)$/m, `$1\n\n*The site’s latest version of [${esc(yours)}](rnold). You’d edited that note, so it was kept as it was.*`)
    // links to this page's own headings stay in this note
    const here = target === ids[i] ? ctx : { ...ctx, noteFor: (t: string) => (t === 'rnold' ? ids[i] : ctx.noteFor(t) === ids[i] ? target : ctx.noteFor(t)) }
    await sync.change(noteDocName(target), (doc) => {
      const nodes = markdownToNodes(text, here)
      if (nodes.length) getContent(doc).insert(0, nodes)
    })
    const doc = sync.getDoc(noteDocName(target))
    if (doc) {
      const ex = extractNote(doc)
      await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, target, { title: ex.title, snippet: ex.snippet, tags: ex.tags, links: ex.links }))
    }
    // remembered: to tell what changed next time
    if (target === ids[i]) store.setSetting(`webPage:${ids[i]}`, contentOf(first[i]))
  }

  // the contents: every page, in order (written again when pages come or go – unless you've edited it)
  const contentsFresh = contentsNew || (prev && pages.some((_, i) => isNew[i]) && contentsId && (sync.noteMeta().get(contentsId)?.updatedAt ?? 0) <= (prev.contentsAt ?? 0) + 15_000)
  if (multi && contentsId && contentsFresh) {
    const guide = pdf ? pdf.name.replace(/\.pdf$/i, '') : pages[0].title
    const from = pdf ? `${pages.length} part${pages.length === 1 ? '' : 's'} of ${pdfSource(pages[0].url, pdf.name)}` : `${pages.length} page${pages.length === 1 ? '' : 's'} from [${esc(pages[0].url.host + pages[0].url.pathname.replace(/\/$/, ''))}](<${pages[0].url.href}>)`
    const md = `# ${esc(guide)} – Contents\n\n*${from}*\n\n${pages.map((p, i) => `${i + 1}. [${esc(p.title)}](rnpage-${i})${p.pdfPages ? ` – p. ${p.pdfPages[0]}` : ''}`).join('\n')}${pdf ? '\n\nThe original PDF:\n\n[original](rnpdf)' : ''}`
    await sync.change(noteDocName(contentsId), (doc) => {
      const frag = getContent(doc)
      frag.delete(0, frag.length)
      frag.insert(0, markdownToNodes(md, ctx))
    })
    const doc = sync.getDoc(noteDocName(contentsId))
    if (doc) {
      const ex = extractNote(doc)
      await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, contentsId!, { title: ex.title, snippet: ex.snippet, links: ex.links }))
    }
  }

  // remembered, to check for updates later
  const now = Date.now()
  const record: WebImportRecord = {
    id: prev?.id ?? newId(),
    url: prev?.url ?? start.href,
    follow: Boolean(opts.follow),
    ...(opts.splitPdf ? { splitPdf: true } : {}),
    maxPages,
    folderId: multi ? folderId : (prev?.folderId ?? opts.folderId ?? null),
    contentsNoteId: contentsId ?? undefined,
    contentsAt: contentsFresh ? now : prev?.contentsAt,
    at: now,
    pages: {
      // pages not found this time stay remembered (they may come back)
      ...(prev?.pages ?? {}),
      ...Object.fromEntries(
        pages.map((p, i) => {
          const was = prev?.pages[pageKey(p.url)]
          const keptOld = write[i] && kept.includes(p.title) && !isNew[i]
          return [pageKey(p.url), { noteId: ids[i], hash: keptOld ? (was?.hash ?? hashes[i]) : hashes[i], at: write[i] && !keptOld ? now : (was?.at ?? now), importedOn: was?.importedOn ?? when, title: p.title }]
        }),
      ),
    },
  }
  saveImport(store, record)
  if (prev) {
    const gone = Object.entries(prev.pages).filter(([k]) => !byKey.has(k)).map(([, v]) => v.title)
    if (updated.length) notes.unshift(`Updated: ${updated.join(', ')}.`)
    if (kept.length) notes.unshift(`Changed on the site, but you’d edited these – a new version was added next to each: ${kept.join(', ')}.`)
    const added = pages.filter((_, i) => isNew[i]).map((p) => p.title)
    if (added.length) notes.unshift(`New pages: ${added.join(', ')}.`)
    if (gone.length && opts.follow) notes.push(`No longer found on the site: ${gone.join(', ')} (their notes are kept).`)
    if (!updated.length && !kept.length && !added.length) notes.unshift('Everything is up to date.')
  }
  sync.reindexAll()
  const written = pages.map((_, i) => ids[i]).filter((_, i) => write[i])
  return {
    noteIds: contentsNew && contentsId ? [contentsId, ...ids] : ids,
    folderId: multi ? folderId : (opts.folderId ?? null),
    pages: pages.length,
    pictures: [...pictures.values()].filter(Boolean).length,
    notes,
    changed: written.length,
  }
}

// --- checking for updates ----------------------------------------------------

export interface WebImportRecord {
  id: string
  url: string
  follow: boolean
  maxPages: number
  /** a PDF split into a note per chapter */
  splitPdf?: boolean
  /** where its notes are (the guide's own folder, or the folder it was imported into) */
  folderId: string | null
  contentsNoteId?: string
  /** when the contents note was last written */
  contentsAt?: number
  at: number
  /** each page (by address): its note, its content's fingerprint, when it was written */
  pages: Record<string, { noteId: string; hash: string; at: number; importedOn: string; title: string }>
}

export function listImports(store: Store): WebImportRecord[] {
  return Object.values(store.getSetting<Record<string, WebImportRecord>>('webImports') ?? {})
}

function saveImport(store: Store, r: WebImportRecord) {
  store.setSetting('webImports', { ...(store.getSetting<Record<string, WebImportRecord>>('webImports') ?? {}), [r.id]: r })
}

/** The imports a note or folder came from (to check them for updates). */
export function importsFor(store: Store, sync: SyncEngine, where: { noteId?: string; folderId?: string }): WebImportRecord[] {
  const meta = sync.noteMeta()
  return listImports(store).filter((r) => {
    if (where.noteId) return Object.values(r.pages).some((p) => p.noteId === where.noteId) || r.contentsNoteId === where.noteId
    if (where.folderId) return r.folderId === where.folderId || Object.values(r.pages).some((p) => meta.get(p.noteId)?.folderId === where.folderId)
    return false
  })
}

/**
 * A note imported before imports were remembered (it has no record, maybe no
 * source): taken on from its "From <address> · imported <date>" line, so it
 * can be checked for updates like any other.
 */
export async function adoptImport(store: Store, sync: SyncEngine, noteId: string): Promise<WebImportRecord | null> {
  const m = sync.noteMeta().get(noteId)
  const doc = sync.getDoc(noteDocName(noteId))
  if (!m || !doc) return null
  const md = noteToMarkdown(doc).slice(0, 3000)
  const line = /From\W*\[[^\]]*\]\(<?(https?:\/\/[^)>\s]+)>?\)\W*·\s*imported\s+(\d{4}-\d\d-\d\d)/.exec(md)
  const href = m.source ?? line?.[1]
  if (!href) return null
  let url: URL
  try {
    url = new URL(unwrapLink(href))
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || url.host === 'pdf.reconnotes') return null
  const record: WebImportRecord = {
    id: newId(),
    url: url.href,
    follow: false,
    maxPages: 1,
    folderId: m.folderId ?? null,
    // when it was written isn't known: changed since, as far as updates go (so your edits are kept)
    at: 0,
    pages: { [pageKey(url)]: { noteId, hash: '', at: 0, importedOn: line?.[2] ?? '', title: m.title } },
  }
  saveImport(store, record)
  if (!m.source) await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, noteId, { source: url.href }))
  return record
}

/** Check an import for updates: fetch its pages again; write what changed. */
export async function refreshImport(config: Config, store: Store, ai: Ai, sync: SyncEngine, r: WebImportRecord): Promise<WebImportResult> {
  if (new URL(r.url).host === 'pdf.reconnotes') throw new Error('This PDF came from your device, so there’s nowhere to check for a newer version – import the new PDF instead.')
  return importWebPages(config, store, ai, sync, { url: r.url, follow: r.follow, maxPages: r.maxPages, folderId: r.folderId, splitPdf: r.splitPdf ?? Object.keys(r.pages).length > 1, update: r })
}

/**
 * A picture's width and height from its first bytes – or null when the data
 * isn't the picture it claims to be (an error page, a cut-off download).
 * 0×0 when it's fine but the size isn't in the header.
 */
export function pictureSize(data: Buffer, mime: string): { w: number; h: number } | null {
  if (data.length < 12) return null
  const b = data
  // PNG
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  // GIF
  if (b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  // JPEG: the frame header
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return { w: 0, h: 0 }
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
      i += 2 + b.readUInt16BE(i + 2)
    }
    return { w: 0, h: 0 }
  }
  // WebP
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
    if (kind === 'VP8L') return { w: 1 + (b.readUInt16LE(21) & 0x3fff), h: 1 + ((b.readUInt32LE(21) >> 14) & 0x3fff) }
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
    return { w: 0, h: 0 }
  }
  // AVIF / HEIC, BMP, ICO: fine, size unknown here
  if (b.toString('latin1', 4, 8) === 'ftyp' || b.toString('latin1', 0, 2) === 'BM' || b.readUInt32BE(0) === 0x00000100) return { w: 0, h: 0 }
  // SVG: real markup, and how big it says it is
  if (mime === 'image/svg+xml' || /^\s*(<\?xml|<svg|<!--)/.test(b.toString('utf8', 0, 200))) {
    const text = b.toString('utf8', 0, Math.min(b.length, 4096))
    const tag = /<svg\b[^>]*>/i.exec(text)?.[0]
    if (!tag) return null
    const num = (a: string) => parseFloat(new RegExp(`\\s${a}=["']([\\d.]+)(px)?["']`).exec(tag)?.[1] ?? '0')
    const vb = /viewBox=["']([^"']+)["']/.exec(tag)?.[1]?.split(/[\s,]+/).map(Number) ?? []
    return { w: num('width') || vb[2] || 0, h: num('height') || vb[3] || 0 }
  }
  return null
}

/** A PDF's sections as pages to import (each with an address of its own, by its title). */
async function pdfPages(data: Buffer, url: URL, split = false): Promise<Page[]> {
  const { sections, title } = await pdfSections(data)
  // one note (unless asked to split it): every chapter in it, a heading level down under the document's title
  if (!split && sections.length > 1) {
    const body = sections
      .map((sec) => (/<main>([\s\S]*)<\/main>/.exec(sec.html)?.[1] ?? '').replace(/<(\/?)h([1-6])>/g, (_m, close: string, n: string) => `<${close}h${Math.min(6, Number(n) + 1)}>`))
      .join('')
    const name = title || decodeURIComponent(url.pathname.split('/').pop() ?? '').replace(/\.pdf$/i, '') || 'Document'
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const html = `<html><head><title>${esc(name)}</title></head><body><main><h1>${esc(name)}</h1>${body}</main></body></html>`
    const { document } = parseHTML(html)
    // its table of contents: a list, each line going to its heading
    linkContents(document as unknown as Document)
    const linked = document.toString()
    return [{ url, title: '', html: linked, doc: document as unknown as Document, pdfPages: [sections[0].pages[0], sections[sections.length - 1].pages[1]] }]
  }
  const used = new Map<string, number>()
  return sections.map((sec) => {
    let slug = sec.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'part'
    const n = (used.get(slug) ?? 0) + 1
    used.set(slug, n)
    if (n > 1) slug += `-${n}`
    const u = new URL(url.href)
    u.hash = ''
    u.searchParams.set('rnsection', slug)
    const { document } = parseHTML(sec.html)
    return { url: u, title: '', html: sec.html, doc: document as unknown as Document, pdfPages: sec.pages }
  })
}

/** A table of contents line's leader dots ("……… 12"). */
const LEADERS = /(?:\.\s*){5,}|…{2,}/

/**
 * The entries of a PDF's table of contents, from its text – where the dots
 * and page numbers run into the next entry ("…… 12 2 FIRST Season Overview ……
 * 13 3 Game Sponsor Recognition"): number, title, page.
 */
export function contentsEntries(text: string): { num: string | null; title: string; page: number }[] {
  const t = text.replace(/…/g, '...').replace(/\s+/g, ' ')
  const out: { num: string | null; title: string; page: number }[] = []
  for (const m of t.matchAll(/(?:^|\s)(?:(\d{1,2}(?:\.\d{1,3}){0,4})\.?\s+)?(\p{L}[^.]*?(?:\.(?!\s*\.)[^.]*?)*?)\s*(?:\.\s*){3,}\s*(\d{1,4})(?=\s|$)/gu)) {
    const title = m[2].replace(/\s+/g, ' ').trim()
    if (title.length < 2 || title.length > 120) continue
    out.push({ num: m[1] ?? null, title, page: Number(m[3]) })
  }
  return out
}

/**
 * A PDF's table of contents (paragraphs of dot leaders and page numbers): a
 * list nested by its numbers (5, 5.1, 5.1.2), each line a link to its heading
 * further on – which the page's links turn into links within the note.
 */
export function linkContents(doc: Document): void {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').trim()
  const paras = [...doc.querySelectorAll('p')]
  const done = new Set<Element>()
  let k = 0
  for (const first of paras) {
    if (done.has(first) || !LEADERS.test(first.textContent ?? '')) continue
    // the run: paragraphs with leaders, and the short bits between them ("5.1", "FIELD…")
    const run: Element[] = []
    for (let el: Element | null = first; el && el.tagName === 'P'; el = el.nextElementSibling) {
      const txt = el.textContent ?? ''
      const nextHas = LEADERS.test(el.nextElementSibling?.textContent ?? '')
      if (!LEADERS.test(txt) && !(txt.length < 80 && nextHas)) break
      run.push(el)
    }
    run.forEach((el) => done.add(el))
    const entries = contentsEntries(run.map((el) => el.textContent ?? '').join(' '))
    if (entries.length < 3) continue
    // each entry's heading: by its number ("5.2 …"), else its title – after the contents
    const headings = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => run[run.length - 1].compareDocumentPosition(h) & 4)
    const items = entries.map((e) => {
      const want = norm(e.num ? `${e.num} ${e.title}` : e.title)
      const h =
        headings.find((x) => norm(x.textContent ?? '') === want) ??
        (e.num ? headings.find((x) => norm(x.textContent ?? '').startsWith(`${e.num} `)) : undefined) ??
        headings.find((x) => norm(x.textContent ?? '').replace(/^[\d.]+\s+/, '') === norm(e.title))
      if (h && !h.getAttribute('id')) h.setAttribute('id', `rn-contents-${++k}`)
      return { depth: e.num ? e.num.split('.').length - 1 : 0, label: e.num ? `${e.num} ${e.title}` : e.title, id: h?.getAttribute('id') ?? null }
    })
    // nested lists, by depth
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    let html = ''
    let depth = -1
    for (const it of items) {
      const d = Math.min(it.depth, depth + 1)
      if (d > depth) html += '<ul>'.repeat(d - depth)
      else html += '</li>' + '</ul></li>'.repeat(depth - d)
      html += `<li>${it.id ? `<a href="#${it.id}">${esc(it.label)}</a>` : esc(it.label)}`
      depth = d
    }
    html += '</li>' + '</ul></li>'.repeat(depth) + '</ul>'
    const holder = doc.createElement('div')
    holder.innerHTML = html
    run[0].replaceWith(...holder.childNodes)
    for (const el of run.slice(1)) el.remove()
  }
}

/** "the PDF at …" for a source line: a link to it, unless it came from this device. */
function pdfSource(url: URL, name: string): string {
  if (url.host === 'pdf.reconnotes') return esc(name)
  const u = new URL(url.href)
  u.searchParams.delete('rnsection')
  return `[${esc(name)}](<${u.href}>)`
}

function mimeFromName(u: string): string | null {
  const ext = /\.(\w+)(?:$|[?#])/.exec(u)?.[1]?.toLowerCase()
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' }
  return ext ? (map[ext] ?? null) : null
}

/** A manual that's a PDF: a note holding the file (read for search like any PDF). */
async function importFile(config: Config, store: Store, ai: Ai, sync: SyncEngine, data: Buffer, mime: string, name: string, url: URL, folderId: string | null): Promise<WebImportResult> {
  const a = { id: newId(), name, mime, size: data.length }
  store.putAttachment({ id: a.id, mime, name, size: a.size, created_at: Date.now() }, data, initialTextStatus(config, ai, mime, name))
  queueAttachment(config, store, ai, sync, a.id)
  const id = newId()
  await sync.change(WORKSPACE_DOC, (ws) => {
    createNote(ws, { id, folderId, title: name })
    updateNote(ws, id, { file: { name, mime, size: a.size } })
  })
  await sync.change(noteDocName(id), (doc) => {
    getContent(doc).insert(0, markdownToNodes(`${esc(name)}\n\n*From [${esc(url.host + url.pathname)}](<${url.href}>)*\n\n[${esc(name)}](att)`, { attach: (h) => (h === 'att' ? a : null), noteFor: () => null }))
  })
  sync.reindexAll()
  return { noteIds: [id], folderId, pages: 1, pictures: 0, notes: [] }
}
