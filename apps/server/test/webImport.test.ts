import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, getContent, listFolders, listNotes, noteDocName, noteToMarkdown } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { importWebPages } from '../src/webImport'

let app: App
let dir: string
let site: http.Server
let base: string
const hits: string[] = []

// a 1×1 PNG (shown 400 wide, so not a tracking pixel)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

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
     <iframe src="https://www.youtube.com/embed/abc123"></iframe>`,
  ),
  '/guide/wiring': layout('Wiring', `<h1>Wiring</h1><h2 id="power">Power</h2><p>Back to the <a href="/guide/">overview</a>.</p>`),
  '/guide/software': layout('Software', `<h1>Software</h1><p>Deploy with Gradle.</p>`),
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
    expect(text).toContain('https://www.youtube.com/watch?v=abc123')
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
    expect(titles).toEqual(['Robot guide', 'Wiring', 'Software'])
    // links between the pages are links between the notes
    const first = getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()
    expect(first).toContain(`<notelink noteId="${r.noteIds[1]}"`)
    expect(getContent(app.sync.getDoc(noteDocName(r.noteIds[1]))!).toString()).toContain(`<notelink noteId="${r.noteIds[0]}"`)
    // not pages outside the guide
    expect(hits).not.toContain('/blog')
    expect(hits).not.toContain('/privacy')
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

  it('says what went wrong with a bad address', async () => {
    await expect(importWebPages(app.config, app.store, app.ai, app.sync, { url: 'not a url' })).rejects.toThrow(/web address/)
    await expect(importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/nothing-here` })).rejects.toThrow(/404/)
  })
})
