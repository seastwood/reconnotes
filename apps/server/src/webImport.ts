/// <reference lib="dom.iterable" />
import crypto from 'node:crypto'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import * as Y from 'yjs'
import { WORKSPACE_DOC, videoInfo, createFolder, createNote, extractNote, getContent, newId, noteDocName, updateFolder, updateNote } from '@reconnotes/core'
import type { Ai } from './ai'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { initialTextStatus, queueAttachment } from './attachments'
import { markdownToNodes } from './importNotes'
import { reportProgress } from './jobs'

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
}

export interface WebImportResult {
  noteIds: string[]
  folderId: string | null
  pages: number
  pictures: number
  /** what didn't come across */
  notes: string[]
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 ReconNotes'
const MAX_HTML = 15 * 1024 * 1024
const MAX_PICTURE = 25 * 1024 * 1024
const MAX_PICTURES = 600
const PAGE_LIMIT = 300

async function fetchWithLimit(url: string, accept: string, max: number, timeoutMs = 30_000): Promise<{ data: Buffer; type: string; url: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en,*;q=0.5' }, redirect: 'follow', signal: ctl.signal })
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
    return { data: Buffer.concat(chunks), type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), url: res.url || url }
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
    for (const c of [...parent.childNodes]) {
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
}

function titleOf(doc: Document, main: El, url: URL): string {
  const h1 = main.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
  const t = doc.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim()
  // "Page – Site name": the page part
  const short = t?.split(/\s+[|–—·•»-]\s+/)[0]?.trim()
  return h1 || og || short || t || url.hostname + url.pathname
}

export async function importWebPages(config: Config, store: Store, ai: Ai, sync: SyncEngine, opts: WebImportOptions): Promise<WebImportResult> {
  let start: URL
  try {
    start = new URL(opts.url.trim())
  } catch {
    throw new Error('That isn’t a web address – it should start with https://')
  }
  if (!/^https?:$/.test(start.protocol)) throw new Error('Only http:// and https:// addresses can be imported.')
  const maxPages = opts.follow ? Math.min(PAGE_LIMIT, Math.max(1, opts.maxPages ?? 50)) : 1
  const notes: string[] = []

  // 1. the pages (the first, then the guide's pages in the order they're linked)
  const pages: Page[] = []
  const seen = new Set<string>([pageKey(start)])
  const queue: URL[] = [start]
  let scope = start
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!
    reportProgress(opts.follow ? `Reading page ${pages.length + 1} of up to ${Math.min(maxPages, pages.length + 1 + queue.length)}…` : 'Reading the page…')
    let got: { data: Buffer; type: string; url: string }
    try {
      got = await fetchWithLimit(url.href, 'text/html,application/xhtml+xml,*/*;q=0.8', MAX_HTML)
    } catch (e) {
      if (!pages.length) throw new Error(`Couldn’t get the page: ${(e as Error).message}`)
      notes.push(`${url.href}: ${(e as Error).message}`)
      continue
    }
    const finalUrl = new URL(got.url)
    // a PDF (a manual as one file): a note holding it
    if (got.type === 'application/pdf' || /\.pdf$/i.test(finalUrl.pathname)) {
      if (pages.length) continue
      return importFile(config, store, ai, sync, got.data, 'application/pdf', decodeURIComponent(path.posix.basename(finalUrl.pathname)) || 'Document.pdf', finalUrl, opts.folderId ?? null)
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

  // 2. each page's content and title
  const mains = pages.map((p) => {
    const main = findMain(p.doc)
    removeNoise(main)
    p.title = titleOf(p.doc, main, p.url)
    return main
  })
  const ids = pages.map(() => newId())
  const byKey = new Map(pages.map((p, i) => [pageKey(p.url), i]))
  /** headings links point at (page#section): what to find when the link is followed */
  const finds: string[] = []

  // 3. the notes (in a folder of their own when there are several)
  let folderId = opts.folderId ?? null
  await sync.change(WORKSPACE_DOC, (ws) => {
    if (pages.length > 1) {
      folderId = createFolder(ws, { name: pages[0].title.slice(0, 80), parentId: opts.folderId ?? null })
      // in the guide's order
      updateFolder(ws, folderId, { sort: 'manual' })
    }
    pages.forEach((p, i) => createNote(ws, { id: ids[i], folderId, title: p.title }))
  })

  // 4. pictures, downloaded once each
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
    for (const [t, s] of tokens) if (s === src) return t
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
  pages.forEach((_, i) => convert(i, mains[i].cloneNode(true) as El))

  const total = tokens.size
  let done = 0
  for (const [, src] of tokens) {
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
        const got = await fetchWithLimit(src, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5', MAX_PICTURE, 20_000)
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
      const a = { id: newId(), name: name.slice(0, 120), mime, size: data.length }
      store.putAttachment({ id: a.id, mime, name: a.name, size: a.size, created_at: Date.now() }, data, initialTextStatus(config, ai, mime, a.name))
      queueAttachment(config, store, ai, sync, a.id)
      pictures.set(src, a)
    } catch {
      pictures.set(src, null)
      failedPictures++
    }
  }
  if (failedPictures) notes.push(`${failedPictures} picture${failedPictures === 1 ? '' : 's'} couldn’t be downloaded (kept as links).`)

  // rule numbers ("see G206") linked to the page where the rule is written
  const markdowns = linkRules(pages.map((_, i) => convert(i, mains[i])))

  // 5. write the notes
  const when = new Date().toISOString().slice(0, 10)
  for (let i = 0; i < pages.length; i++) {
    reportProgress(pages.length > 1 ? `Writing note ${i + 1} of ${pages.length}…` : 'Writing the note…')
    const p = pages[i]
    // pictures that didn't come: icons left out, the others a link to where they are
    let md = markdowns[i].replace(/!\[([^\]]*)\]\((rnpic-\d+)\)/g, (m, alt: string, token: string) => {
      const src = tokens.get(token)
      if (!src || pictures.get(src)) return m
      if (icons.has(src) || src.startsWith('svg:') || src.startsWith('data:')) return ''
      return `[${alt || 'Picture'}](<${src}>)`
    })
    // the title first (as the page's own first heading, or added)
    if (!/^#\s/.test(md)) md = `# ${esc(p.title)}\n\n${md}`
    // where it came from, under the title
    const source = `*From [${esc(p.url.host + p.url.pathname.replace(/\/$/, ''))}](<${p.url.href}>) · imported ${when}*`
    md = md.replace(/^(#[^\n]*\n)/, `$1\n${source}\n`)
    if (mains[i] && textLength(mains[i]) < 200 && /__next|__nuxt|id="root"|id="app"|ng-version|data-reactroot/.test(p.html))
      notes.push(`${p.url.href}: the page builds its content with JavaScript in the browser, so only part of it (or none) could be read.`)
    await sync.change(noteDocName(ids[i]), (doc) => {
      const nodes = markdownToNodes(md, {
        attach: (href) => {
          const src = tokens.get(href)
          const a = src ? pictures.get(src) : null
          return a ?? null
        },
        blockFor: videoBlock,
        noteFor: (target) => {
          const m = /^rn(?:page|rule)-(\d+)/.exec(target)
          return m ? (ids[Number(m[1])] ?? null) : null
        },
        findFor: (target) => {
          const rule = /^rnrule-\d+-(\w+)$/.exec(target)?.[1]
          if (rule) return rule
          const f = /^rnpage-\d+~(\d+)$/.exec(target)?.[1]
          return f !== undefined ? (finds[Number(f)] ?? null) : null
        },
      })
      // a picture that couldn't be downloaded: a link to it instead
      if (nodes.length) getContent(doc).insert(0, nodes)
    })
    const doc = sync.getDoc(noteDocName(ids[i]))
    if (doc) {
      const ex = extractNote(doc)
      await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, ids[i], { title: ex.title, snippet: ex.snippet, tags: ex.tags, links: ex.links }))
    }
  }
  sync.reindexAll()
  return { noteIds: ids, folderId: pages.length > 1 ? folderId : (opts.folderId ?? null), pages: pages.length, pictures: [...pictures.values()].filter(Boolean).length, notes }
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
