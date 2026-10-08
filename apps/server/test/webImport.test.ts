import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, getContent, listFolders, listNotes, noteDocName, noteToMarkdown, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { importWebPages, importsFor, refreshImport } from '../src/webImport'

let app: App
let dir: string
let site: http.Server
let base: string
const hits: string[] = []

import zlib from 'node:zlib'

/** A plain PNG of this size. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 120)])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PNG = png(120, 80)
const ICON_PNG = png(16, 16)

const layout = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} | Robot Docs</title></head>
<body>
  <header class="site-header"><nav><a href="/">Home</a> <a href="/blog">Blog</a></nav></header>
  <div class="layout">
    <aside class="sidebar"><nav>
      <a href="/guide/">Overview</a>
      <a href="/guide/wiring">Wiring</a>
      <a href="/guide/software">Software</a>
      <a href="https://elsewhere.example/x">Elsewhere</a>
    </nav></aside>
    <main><article>${body}</article>
      <div class="pagination"><a href="/guide/wiring">Next →</a></div>
    </main>
  </div>
  <footer>© Robot Docs · <a href="/privacy">Privacy</a></footer>
  <script>console.log('x')</script>
</body></html>`

const PAGES: Record<string, string> = {
  '/guide/': layout(
    'Overview',
    `<h1>Robot guide <a class="hash-link" href="#robot-guide">#</a></h1>
     <p>Build the <strong>drive base</strong> first, then <em>test</em> it. See <a href="/guide/wiring#power">the wiring page</a> or <a href="https://docs.wpilib.org/">WPILib</a>.</p>
     <figure><img src="/img/robot.png" width="400" alt="The robot"><figcaption>Our 2026 robot</figcaption></figure>
     <img srcset="/img/small.png 400w, /img/big.png 1200w" src="/img/small.png" width="300" alt="Chassis">
     <h2>Parts</h2>
     <ul><li>Motors<ul><li>NEO <code>x4</code></li><li>Falcon</li></ul></li><li>Battery</li></ul>
     <ol start="3"><li>Step three</li><li>Step four</li></ol>
     <table><thead><tr><th>Part</th><th>Qty</th></tr></thead><tbody><tr><td>Wheel</td><td>4</td></tr><tr><td>Bumper | frame</td><td>2</td></tr></tbody></table>
     <pre><code class="language-java">drive.arcade(speed, turn);
// done</code></pre>
     <blockquote><p>Measure twice.</p></blockquote>
     <details><summary>Troubleshooting</summary><p>Check the breaker.</p></details>
     <svg width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="red"/></svg>
     <p>Prices: 5 * 3 = 15, and _underscores_ stay [as typed].</p>
     <img src="/img/pixel.gif" width="1" height="1">
     <iframe src="https://www.youtube.com/embed/abc123_x-Y" title="How to wire it"></iframe>
     <video src="/clips/demo.mp4" controls></video>
     <iframe src="https://maps.example.com/embed?x=1" title="Map"></iframe>`,
  ),
  '/guide/wiring': layout('Wiring', `<h1>Wiring</h1><h2 id="power">Power</h2><p>Back to the <a href="/guide/">overview</a>.</p>`),
  '/guide/software': layout('Software', `<h1>Software</h1><p>Deploy with Gradle.</p>`),
  // a blog post: a linked card picture, icons by the date and reading time
  '/post': `<html><head><title>Post</title></head><body>
    <svg style="display:none"><symbol id="i-cal" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></symbol></svg>
    <article>
      <a href="https://blog.example/posts/docker/"><figure><img src="/img/hero.png" alt="Hero"></figure></a>
      <h1><a href="https://blog.example/posts/docker/"> Reducing storage for Docker </a></h1>
      <ul class="meta">
        <li><svg class="icon"><use href="#i-cal"></use></svg> 2021-10-01</li>
        <li><img src="/img/clock.svg" class="icon icon-clock" alt=""> 2 minutes</li>
        <li><img src="/img/tiny.png" alt=""> tagged</li>
      </ul>
      <p>Docker containers have layers.</p>
      <img src="/img/broken.png" alt="Diagram">
      <svg width="300" height="120" viewBox="0 0 300 120"><use xlink:href="#i-cal"></use><text x="10" y="20" fill="currentColor">Layers</text></svg>
    </article></body></html>`,
  // the shapes of two common documentation sites
  '/sphinx': `<html><head><title>Wiring — FRC docs</title></head><body class="wy-body-for-nav">
    <nav class="wy-nav-side"><div class="wy-menu"><a href="/a">Zero to Robot</a><a href="/b">Hardware</a></div></nav>
    <section class="wy-nav-content-wrap"><div class="wy-nav-content"><div class="rst-content">
      <div role="navigation" aria-label="breadcrumbs"><a href="/">Home</a> » Wiring</div>
      <div class="document" role="main" itemprop="articleBody"><section id="wiring">
        <h1>Robot wiring<a class="headerlink" href="#wiring" title="Permalink">¶</a></h1>
        <p>Connect the <a class="reference internal" href="/pdp"><span class="std">PDP</span></a> first.</p>
        <div class="admonition warning"><p class="admonition-title">Warning</p><p>Disconnect the battery.</p></div>
        <div class="highlight-python notranslate"><div class="highlight"><pre><span></span><span class="n">x</span> <span class="o">=</span> <span class="mi">1</span>
</pre></div></div>
      </section></div>
      <footer><div class="rst-footer-buttons"><a href="/next">Next</a></div><p>© Copyright 2026</p></footer>
    </div></div></section></body></html>`,
  '/docusaurus': `<html><head><title>Getting started | REV docs</title></head><body><div id="__docusaurus">
    <nav class="navbar"><a href="/">REV</a><a href="/blog">Blog</a></nav>
    <div class="main-wrapper"><aside class="theme-doc-sidebar-container"><a href="/x">Intro</a></aside>
    <main class="docMainContainer"><div class="row"><div class="col">
      <nav class="theme-doc-breadcrumbs"><a href="/">Docs</a></nav>
      <div class="tocCollapsible theme-doc-toc-mobile"><button>On this page</button></div>
      <article><div class="theme-doc-markdown markdown"><header><h1>Getting started</h1></header>
        <p>Plug in the <strong>SPARK MAX</strong>.</p>
        <h2 id="setup">Setup<a href="#setup" class="hash-link" aria-label="Direct link to Setup">​</a></h2>
        <div class="language-bash codeBlockContainer"><pre class="prism-code language-bash"><code><span class="token-line">npm install</span></code></pre></div>
      </div><footer class="theme-doc-footer"><a href="/edit">Edit this page</a></footer></article>
      <nav class="pagination-nav"><a href="/next">Next</a></nav>
    </div><div class="col col--3"><div class="tableOfContents">On this page Setup</div></div></div></main></div>
    <footer class="footer">Copyright REV</footer></div></body></html>`,
}

beforeAll(async () => {
  site = http.createServer((req, res) => {
    hits.push(req.url!)
    const p = PAGES[req.url!.split('?')[0]]
    if (p) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(p)
    if (req.url === '/img/tiny.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(ICON_PNG)
    if (req.url === '/img/broken.png') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Not found</html>')
    if (req.url!.startsWith('/img/') && !req.url!.includes('missing')) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG)
    res.writeHead(404).end('no')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-web-'))
  app = createApp(loadConfig({ RECON_TOKEN: 'test-token-0123456789abcdef', RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
})

afterAll(async () => {
  await app.close()
  site.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const md = (id: string) => noteToMarkdown(app.sync.getDoc(noteDocName(id))!)

describe('importing a web page', () => {
  it('keeps the content as it was – without the site’s menus, footer and scripts – with its pictures downloaded', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/guide/` })
    expect(r.pages).toBe(1)
    const text = md(r.noteIds[0])
    const xml = getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()
    // the title, and where it came from
    expect(text).toMatch(/^# Robot guide\n/)
    expect(text).toContain(`${base.replace('http://', '')}/guide`)
    // the content
    expect(text).toContain('Build the **drive base** first, then *test* it.')
    expect(xml).toMatch(/<link [^>]*href="https:\/\/docs\.wpilib\.org\/"[^>]*>WPILib/)
    expect(text).toMatch(/## Parts/)
    expect(text).toMatch(/- Motors\n\s+- NEO `x4`\n\s+- Falcon\n- Battery/)
    expect(text).toMatch(/3\. Step three\n4\. Step four/)
    expect(xml).toContain('<tableheader><paragraph>Part</paragraph></tableheader>')
    expect(xml).toContain('Bumper | frame')
    expect(text).toContain('```java\ndrive.arcade(speed, turn);\n// done\n```')
    expect(text).toContain('> Measure twice.')
    expect(text).toContain('**Troubleshooting**')
    expect(text).toContain('Check the breaker.')
    expect(text).toContain('Prices: 5 * 3 = 15, and _underscores_ stay [as typed].')
    expect(text).toContain('*Our 2026 robot*')
    // videos that play in the note
    expect(xml).toContain('<video src="https://www.youtube.com/embed/abc123_x-Y" title="How to wire it"></video>')
    expect(xml).toContain(`<video src="${base}/clips/demo.mp4" title=""></video>`)
    // other embedded things: a link
    expect(xml).toMatch(/Map: <link [^>]*href="https:\/\/maps\.example\.com\/embed\?x=1"/)
    // not the site around it
    for (const s of ['Blog', 'Privacy', '© Robot Docs', 'Next →', 'console.log', 'Elsewhere', '#robot-guide']) expect(text).not.toContain(s)
    // pictures: the figure, the largest of the srcset, the SVG drawing – not the tracking pixel
    expect((xml.match(/<image /g) ?? []).length).toBe(3)
    expect(hits).toContain('/img/big.png')
    expect(hits).not.toContain('/img/pixel.gif')
    expect(r.pictures).toBe(3)
    expect(xml).toContain('alt="The robot"')
  })

  it('follows the guide’s pages: one note each, in order, in a folder, linked to each other', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/guide/`, follow: true, maxPages: 10 })
    expect(r.pages).toBe(3)
    const ws = app.sync.getDoc(WORKSPACE_DOC)!
    const folder = listFolders(ws).find((f) => f.id === r.folderId)!
    expect(folder.name).toBe('Robot guide')
    const titles = listNotes(ws).filter((n) => n.folderId === r.folderId).map((n) => n.title)
    // a contents note first, then the pages in the guide's order
    expect(titles).toEqual(['Robot guide – Contents', 'Robot guide', 'Wiring', 'Software'])
    const [contents, ...pageIds] = r.noteIds
    const toc = getContent(app.sync.getDoc(noteDocName(contents))!).toString()
    for (const id of pageIds) expect(toc).toMatch(new RegExp(`<notelink [^>]*noteId="${id}"`))
    // links between the pages are links between the notes,
    // keeping the page's own words, and opening at the heading they point to (wiring#power)
    const first = getContent(app.sync.getDoc(noteDocName(pageIds[0]))!).toString()
    expect(first).toMatch(new RegExp(`<notelink find="Power" label="the wiring page" noteId="${pageIds[1]}"`))
    expect(getContent(app.sync.getDoc(noteDocName(pageIds[1]))!).toString()).toMatch(new RegExp(`<notelink [^>]*noteId="${pageIds[0]}"`))
    // each page remembers where it came from
    expect(listNotes(ws).find((n) => n.id === pageIds[2])?.source).toBe(`${base}/guide/software`)
    // not pages outside the guide
    expect(hits).not.toContain('/blog')
    expect(hits).not.toContain('/privacy')
  })

  it('leaves icons out, keeps a linked picture whole, and links a picture that wasn’t one', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/post` })
    const text = md(r.noteIds[0])
    const xml = getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()
    // the card: its picture, no stray "](…)"
    expect(xml).toContain('alt="Hero"')
    expect(text).not.toMatch(/^\]\(/m)
    expect(text).not.toContain('\n](')
    expect(text).toMatch(/^# Reducing storage for Docker\n/)
    // the date and reading time, without their icons
    expect(text).toMatch(/- 2021-10-01\n- 2 minutes\n- tagged/)
    expect(hits).not.toContain('/img/clock.svg')
    // the error page served as a picture: a link, not a broken picture
    expect(xml).toMatch(/<link [^>]*href="[^"]*\/img\/broken\.png"[^>]*>Diagram/)
    // the hero and the SVG drawing (its shared shape copied in): 2 pictures
    expect((xml.match(/<image /g) ?? []).length).toBe(2)
    expect(r.pictures).toBe(2)
  })

  it('finds the content on Sphinx / Read the Docs and Docusaurus sites', async () => {
    const a = md((await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/sphinx` })).noteIds[0])
    expect(a).toMatch(/^# Robot wiring\n/)
    expect(a).toContain('Connect the [PDP](')
    expect(a).toContain('Disconnect the battery.')
    expect(a).toContain('```python\nx = 1\n```')
    for (const s of ['Zero to Robot', 'Home', '¶', 'Copyright', 'Next']) expect(a).not.toContain(s)
    const b = md((await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/docusaurus` })).noteIds[0])
    expect(b).toMatch(/^# Getting started\n/)
    expect(b).toContain('Plug in the **SPARK MAX**.')
    expect(b).toMatch(/## Setup\n/)
    expect(b).toContain('```bash\nnpm install\n```')
    for (const s of ['Blog', 'Intro', 'On this page', 'Edit this page', 'Next', 'Copyright REV', 'Docs']) expect(b).not.toContain(s)
  })

  it('checks for updates: changed pages follow the site, edited ones are kept, new pages are added', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/guide/`, follow: true, maxPages: 10 })
    const [, intro, wiring, software] = r.noteIds
    const record = importsFor(app.store, app.sync, { noteId: wiring })[0]
    expect(record).toBeTruthy()
    // nothing changed
    let check = await refreshImport(app.config, app.store, app.ai, app.sync, record)
    expect(check.notes[0]).toBe('Everything is up to date.')
    expect(check.changed).toBe(0)
    // the site changes two pages and adds one; you've edited one of the changed ones
    const saved = { ...PAGES }
    PAGES['/guide/wiring'] = PAGES['/guide/wiring'].replace('Back to the', 'Use 10 AWG wire. Back to the')
    PAGES['/guide/software'] = PAGES['/guide/software'].replace('Deploy with Gradle.', 'Deploy with Gradle 9.')
    PAGES['/guide/'] = PAGES['/guide/'].replace('<a href="/guide/software">Software</a>', '<a href="/guide/software">Software</a><a href="/guide/vision">Vision</a>')
    PAGES['/guide/vision'] = PAGES['/guide/software'].replace(/Software/g, 'Vision')
    await new Promise((r) => setTimeout(r, 30))
    await app.sync.change(WORKSPACE_DOC, (d) => updateNote(d, software, { updatedAt: Date.now() + 60_000 }))
    try {
      check = await refreshImport(app.config, app.store, app.ai, app.sync, importsFor(app.store, app.sync, { folderId: r.folderId! })[0])
    } finally {
      Object.assign(PAGES, saved)
      delete PAGES['/guide/vision']
    }
    // wiring (unedited) updated in place, saying what changed
    const w = md(wiring)
    expect(w).toContain('Use 10 AWG wire.')
    expect(w).toMatch(/updated \d{4}-\d{2}-\d{2}: 1 paragraph new or changed, 1 removed/)
    // software (edited) kept as it was, pointing to a new version next to it
    expect(md(software)).not.toContain('Gradle 9')
    expect(md(software)).toContain('This page has changed on the site')
    const ws = app.sync.getDoc(WORKSPACE_DOC)!
    const newer = listNotes(ws).find((n) => n.title.startsWith('Software (updated'))!
    expect(md(newer.id)).toContain('Deploy with Gradle 9.')
    // the new page: added to the folder, and to the contents
    const vision = listNotes(ws).find((n) => n.title === 'Vision' && n.folderId === r.folderId)
    expect(vision).toBeTruthy()
    expect(check.notes.join('\n')).toMatch(/New pages: Vision/)
    expect(check.notes.join('\n')).toMatch(/Updated: Wiring/)
    expect(intro).toBeTruthy()
  })

  it('says what went wrong with a bad address', async () => {
    await expect(importWebPages(app.config, app.store, app.ai, app.sync, { url: 'not a url' })).rejects.toThrow(/web address/)
    await expect(importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/nothing-here` })).rejects.toThrow(/404/)
  })
})

import { linkRules } from '../src/webImport'

describe('rule numbers in an imported manual', () => {
  it('links each mention to the page that defines the rule – not the definition itself, code, links or part numbers', () => {
    const pages = [
      '# Fouls\n\n**G301** Robots may not damage the field.\n\nG302 Robots may not extend more than 48 cm.\n\n- G303 No pinning.',
      '# Scoring\n\nA coral is 5 points. See G302 and G301, and `G303` in code, and [G301](<https://x/g301>).\n\n- RS775 motor\n\nThe RS775 is allowed.',
    ]
    const [fouls, scoring] = linkRules(pages)
    expect(fouls).toBe(pages[0]) // definitions stay as they are
    expect(scoring).toContain('See [G302](rnrule-0-G302) and [G301](rnrule-0-G301)')
    expect(scoring).toContain('`G303` in code')
    expect(scoring).toContain('[G301](<https://x/g301>)')
    expect(scoring).toContain('The RS775 is allowed.') // one part number isn't a family of rules
  })
})

import { manualPdf } from './pdfHelper'

describe('a PDF manual from a link', () => {
  it('split, becomes a folder: a note per chapter, a contents note with the PDF, rules linked across chapters', async () => {
    PAGES['/manual.pdf'] = '' // served below as a PDF
    const pdfServer = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(manualPdf()))
    await new Promise<void>((r) => pdfServer.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(pdfServer.address() as AddressInfo).port}/2026GameManual.pdf`
      const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url, splitPdf: true })
      const ws = app.sync.getDoc(WORKSPACE_DOC)!
      expect(listFolders(ws).find((f) => f.id === r.folderId)?.name).toBe('2026GameManual')
      const titles = listNotes(ws).filter((n) => n.folderId === r.folderId).map((n) => n.title)
      expect(titles).toEqual(['2026GameManual – Contents', '1 Introduction', '6 Game Rules', '9 Robot Rules'])
      const [contents, , rules] = r.noteIds
      expect(md(contents)).toMatch(/2\. \[\[6 Game Rules\]\] – p\. 2/)
      expect(getContent(app.sync.getDoc(noteDocName(contents))!).toString()).toMatch(/<file [^>]*name="2026GameManual\.pdf"/)
      const g = md(rules)
      expect(g).toMatch(/^# 6 Game Rules\n/)
      expect(g).toMatch(/From \*\[\*2026GameManual\.pdf\*\]\([^)]*2026GameManual\.pdf\)\*, pages 2–3/)
      expect(g).toContain('## 6.1 Fouls')
      expect(g).toContain('G301 Robots may not damage the field.')
      // "See G302" links to the rule (on the same note, at G302)
      expect(getContent(app.sync.getDoc(noteDocName(rules))!).toString()).toMatch(/<notelink find="G302" label="G302" noteId="/)
    } finally {
      pdfServer.close()
      delete PAGES['/manual.pdf']
    }
  })

  it('by default, becomes one note: every chapter in it, the PDF at the end', async () => {
    const pdfServer = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(manualPdf()))
    await new Promise<void>((r) => pdfServer.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(pdfServer.address() as AddressInfo).port}/OneNoteManual.pdf`
      const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url, folderId: null })
      expect(r.noteIds).toHaveLength(1)
      const m = md(r.noteIds[0])
      expect(m).toMatch(/^# /)
      expect(m).toContain('## 6 Game Rules')
      expect(m).toContain('### 6.1 Fouls')
      expect(m).toContain('## 9 Robot Rules')
      expect(m).toMatch(/pages 1–4/)
      expect(getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()).toMatch(/<file [^>]*name="OneNoteManual\.pdf"/)
    } finally {
      pdfServer.close()
    }
  })
})
