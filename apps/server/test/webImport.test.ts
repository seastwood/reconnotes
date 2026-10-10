import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, listFolders, listNotes, noteDocName, noteToMarkdown, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { adoptImport, contentsEntries, importWebPages, importsFor, refreshImport } from '../src/webImport'
import { markdownToNodes } from '../src/importNotes'

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
/** a picture of its own for each address (different pictures aren't the same file) – but /img/same-*: one picture */
const pngFor = (p: string) => (p.startsWith('/img/pin-') ? png(100, 250) : p.startsWith('/img/same-') ? PNG : png(100 + ([...p].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7) % 300), 80))

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

/** A Google Doc as "Publish to the web" makes it: the contents linked to headings, indented by its stylesheet. */
const GDOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Trials Manual - Cookie Chaos - Google Docs</title></head><body>
<div id="banners"><div id="publish-banner">Published using Google Docs <a href="https://support.google.com/docs">Learn more</a></div></div>
<div id="title" class="title">Trials Manual - Cookie Chaos</div>
<div id="contents"><style type="text/css">.c2{margin-left:0;padding-top:0}.c5{margin-left:18pt;padding-top:0}.c6{margin-left:36pt}.c7{color:#1155cc;text-decoration:underline}.c9{font-weight:700}.c11{margin-left:36pt;text-indent:-18pt}</style>
<div><p class="c2"><span><a class="c7" href="#h.intro">1 INTRODUCTION</a></span></p>
<p class="c5 c8"><span><a class="c7" href="#h.hist">1.1 PROGRAM HISTORY</a></span></p>
<p class="c5"><span><a class="c7" href="#h.goals">1.2 GOALS</a></span></p>
<p class="c2"><span><a class="c7" href="#h.arena">3 ARENA</a></span></p>
<p class="c5"><span><a class="c7" href="#h.zones">3.2 ZONES &amp; MARKINGS</a></span></p>
<p class="c6"><span><a class="c7" href="#h.center">3.2.1 CENTER LINE</a></span></p>
<p class="c6"><span><a class="c7" href="#h.bakery">3.2.2 BAKERY</a></span></p>
<h1 id="h.intro"><span>1 INTRODUCTION</span></h1><p class="c2"><span>Welcome.</span></p>
<h2 id="h.hist"><span>1.1 PROGRAM HISTORY</span></h2><p class="c2"><span>Since 2010.</span></p>
<h2 id="h.goals"><span>1.2 GOALS</span></h2><p class="c11"><span>Have fun, see </span><span><a class="c7" href="#h.bakery">the bakery</a></span><span>.</span></p>
<h1 id="h.arena"><span>3 ARENA</span></h1>
<h2 id="h.zones"><span>3.2 ZONES &amp; MARKINGS</span></h2>
<h3 id="h.center"><span>3.2.1 CENTER LINE</span></h3><p class="c2"><span>The middle.</span></p>
<h3 id="h.bakery"><span>3.2.2 BAKERY</span></h3><p class="c2"><span>Where cookies go.</span></p>
</div></div>
<div id="footer">Updated automatically every 5 minutes</div>
</body></html>`

const PAGES: Record<string, string> = {
  '/document/d/e/2PACX-x/pub': GDOC,
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

// a recipe page (as WordPress recipe plugins write them): the recipe for search engines, the site's own card, its leftovers
const RECIPE_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebPage', name: 'The Best Chili Recipe {EASY} - Spend Less' },
    {
      '@type': 'Recipe',
      name: 'The Best Chili Recipe',
      description: 'A big pot of ground beef chili loaded with beef and beans.',
      image: ['/img/chili-photo.png', '/img/chili-photo-300x200.png'],
      recipeYield: ['8', '8 servings'],
      prepTime: 'PT20M',
      cookTime: 'PT45M',
      totalTime: 'PT1H5M',
      recipeIngredient: ['2 pounds lean ground beef', '2&#189; tablespoons chili powder divided, or to taste', '1 (19 ounce) can red kidney beans drained and rinsed', '&nbsp;', ' ', 'salt and black pepper to taste'],
      recipeInstructions: [
        { '@type': 'HowToStep', text: 'Combine ground beef and 1 ½ tablespoons chili powder.' },
        { '@type': 'HowToStep', text: 'In a large pot, brown ground beef, onion, jalapeno, and garlic. Drain any fat.' },
        { '@type': 'HowToStep', text: 'Add in remaining ingredients and bring to a boil. Simmer uncovered for 45 to 60 minutes.' },
      ],
      nutrition: { '@type': 'NutritionInformation', calories: '395 kcal', proteinContent: '29 g' },
      recipeCuisine: ['American', 'Tex Mex'],
      recipeCategory: 'Main Course',
    },
  ],
}
PAGES['/recipe/chili'] = `<!doctype html><html><head><title>The Best Chili Recipe {EASY} - Spend Less</title>
<script type="application/ld+json">${JSON.stringify(RECIPE_LD)}</script></head><body><article>
<h1>The Best Chili Recipe {EASY}</h1>
<div class="share-bar">PinFacebookTweetEmail</div>
<p>The Best Chili Recipe is one that is loaded with beef and beans and absolutely full of flavor.</p>
<p><img src="/img/chili-photo-600x400.png" alt="Chili in a pot"></p>
<h2>To Thicken Chili</h2><p>Simmer it uncovered, which lets the chili thicken naturally without cornstarch.</p>
<p><img src="/img/same-a.png" alt="Bowl"></p><p><img src="/img/same-b.png" alt="Bowl again"></p>
<div class="wprm-recipe-container"><h2>The Best Chili Recipe</h2><ul><li>2 pounds lean ground beef (the site's own card)</li></ul></div>
<p><img src="/img/pin-title.png" alt="The Best Chili pin"></p>
<h2>Can You Freeze Chili?</h2><p>Yes – it freezes and reheats beautifully.</p>
<h2>More Chili Recipes You’ll Love</h2><ul><li><a href="/x">Texas Chili</a></li><li><a href="/y">White Chili</a></li></ul>
<h2>Is Chili Healthy</h2><p>Lean beef, tomatoes and beans: lots of fiber and protein.</p>
<p>Categories: <a href="/c">Ground Beef</a>, <a href="/d">Soups</a></p>
<h3>About the author</h3><p>Holly writes easy comfort food.</p><p><img src="/img/ebook-cover.png" alt="Free eBook"></p><p>Subscribe to receive weekly recipes!</p>
</article></body></html>`

beforeAll(async () => {
  site = http.createServer((req, res) => {
    hits.push(req.url!)
    const p = PAGES[req.url!.split('?')[0]]
    if (p) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(p)
    if (req.url === '/img/tiny.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(ICON_PNG)
    if (req.url === '/img/broken.png') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Not found</html>')
    if (req.url!.startsWith('/img/') && !req.url!.includes('missing')) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(pngFor(req.url!.split('?')[0]))
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

describe('a recipe page', () => {
  it('becomes a recipe card from the recipe the page gives search engines – then the article, its pictures once each', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/recipe/chili` })
    const text = md(r.noteIds[0])
    const xml = getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()
    expect(text).toMatch(/^# The Best Chili Recipe\n/)
    expect(text).toContain('**Servings:** 8 servings · **Prep:** 20 min · **Cook:** 45 min · **Total:** 1 hr 5 min · #recipe')
    // every ingredient, as it was (a checklist), every step, numbered
    expect(text).toContain('## Ingredients')
    expect(text).toMatch(/- \[ \] 2 pounds lean ground beef\n- \[ \] 2½ tablespoons chili powder divided, or to taste\n- \[ \] 1 \(19 ounce\) can red kidney beans drained and rinsed\n- \[ \] salt and black pepper to taste/)
    expect(text).toMatch(/## Steps\n\n1\. Combine ground beef and 1 ½ tablespoons chili powder\.\n2\. In a large pot/)
    expect(text).toContain('Calories: 395 kcal · Protein: 29 g')
    // then the article: its tips kept, the site's own card and share bar not
    expect(text).toContain('## From the article')
    expect(text).toContain('Simmer it uncovered')
    expect(text).not.toContain("the site's own card")
    expect(text).not.toContain('PinFacebook')
    // no blank ingredient
    expect(text).not.toMatch(/- \[ \]\s*\n/)
    // the article's own sections stay; the site's leftovers at its end, its "more recipes" list and its pin graphic don't
    expect(text).toContain('Can You Freeze Chili?')
    expect(text).toContain('Is Chili Healthy')
    for (const gone of ['More Chili Recipes', 'Texas Chili', 'Categories:', 'About the author', 'Holly writes', 'Subscribe', 'Free eBook', 'pin']) expect(text).not.toContain(gone)
    // the photo once (the card's photo and the article's at another size are one picture); the same file twice: once
    expect((xml.match(/<image /g) ?? []).length).toBe(2)
    // tagged
    expect(app.sync.noteMeta().get(r.noteIds[0])?.tags).toContain('recipe')
  })

  it('the card only, when the article isn’t wanted', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/recipe/chili`, recipeArticle: false })
    const text = md(r.noteIds[0])
    expect(text).toContain('## Ingredients')
    expect(text).not.toContain('From the article')
    expect(text).not.toContain('Simmer it uncovered')
  })
})

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
    const newer = listNotes(ws).find((n) => n.title.startsWith('Software – latest from the site ('))!
    expect(md(newer.id)).toContain('Deploy with Gradle 9.')
    // the new page: added to the folder, and to the contents
    const vision = listNotes(ws).find((n) => n.title === 'Vision' && n.folderId === r.folderId)
    expect(vision).toBeTruthy()
    expect(check.notes.join('\n')).toMatch(/New pages: Vision/)
    expect(check.notes.join('\n')).toMatch(/Updated: Wiring/)
    expect(intro).toBeTruthy()
  })

  it('a Google Doc: its contents link to the headings, indented as they were', async () => {
    const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url: `${base}/document/d/e/2PACX-x/pub` })
    const text = md(r.noteIds[0])
    const xml = getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()
    // the document's own title – not its first heading, nor Google's banner and footer
    expect(text).toMatch(/^# Trials Manual - Cookie Chaos\n/)
    for (const t of ['Published using Google Docs', 'Updated automatically', 'Learn more']) expect(text).not.toContain(t)
    // the contents: a list nested as it was indented, each line going to its heading in the note
    expect(text).toContain('- [[1 INTRODUCTION]]\n  - [[1.1 PROGRAM HISTORY]]\n  - [[1.2 GOALS]]\n- [[3 ARENA]]\n  - [[3.2 ZONES & MARKINGS]]\n    - [[3.2.1 CENTER LINE]]\n    - [[3.2.2 BAKERY]]')
    expect(xml).toContain(`<notelink find="3.2.1 CENTER LINE" label="3.2.1 CENTER LINE" noteId="${r.noteIds[0]}"`)
    // and a link in the text to a heading
    expect(xml).toContain(`<notelink find="3.2.2 BAKERY" label="the bakery" noteId="${r.noteIds[0]}"`)
  })

  it('a note imported before imports were remembered: checked for updates from its "From" line, your edits kept', async () => {
    const url = `${base}/document/d/e/2PACX-x/pub`
    await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id: 'oldimport00001', title: 'My manual' }))
    await app.sync.change(noteDocName('oldimport00001'), (doc) =>
      void getContent(doc).insert(0, markdownToNodes(`My manual\n\n# Revisions\n\n*From [${url.replace('http://', '')}](<${url}>) · imported 2026-10-08*\n\nOld text.`, { attach: () => null, noteFor: () => null })),
    )
    expect(importsFor(app.store, app.sync, { noteId: 'oldimport00001' })).toEqual([])
    const record = await adoptImport(app.store, app.sync, 'oldimport00001')
    expect(record?.url).toBe(url)
    expect(app.sync.noteMeta().get('oldimport00001')?.source).toBe(url)
    const r = await refreshImport(app.config, app.store, app.ai, app.sync, record!)
    // yours is kept (with a note saying there's a new version); the new version is next to it
    expect(md('oldimport00001')).toContain('Old text.')
    expect(md('oldimport00001')).toContain('This page has changed on the site')
    expect(r.notes[0]).toContain('you’d edited these')
    // named after yours, saying what it is
    const fresh = [...app.sync.noteMeta().values()].find((m) => /^My manual – latest from the site \(\w{3} \d{1,2}, \d{4}\)$/.test(m.title) && m.source === url)!.id
    expect(md(fresh)).toMatch(/^# My manual – latest from the site \(/)
    expect(md(fresh).replace(/\*/g, '')).toContain('The site’s latest version of [[My manual]]. You’d edited that note, so it was kept as it was.')
    expect(md('oldimport00001').replace(/\*/g, '')).toContain('the new version: [[My manual – latest from the site (')
    // its contents go to its own headings, not yours
    const xml = getContent(app.sync.getDoc(noteDocName(fresh))!).toString()
    expect(xml).toContain(`<notelink find="1.1 PROGRAM HISTORY" label="1.1 PROGRAM HISTORY" noteId="${fresh}"`)
    expect(xml).toContain(`label="My manual" noteId="oldimport00001"`)
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

describe('Markdown from pages and PDFs', () => {
  it('a single ~ is "about", not strikethrough', async () => {
    const { markdownToNodes } = await import('../src/importNotes')
    const doc = new (await import('yjs')).Doc()
    getContent(doc).insert(0, markdownToNodes('Foam (~58 mm) and 4½ in (~114 mm) tall, ~~gone~~.', { attach: () => null, noteFor: () => null }))
    const xml = getContent(doc).toString()
    expect(xml).toContain('Foam (~58 mm) and 4½ in (~114 mm) tall, ')
    expect(xml).toMatch(/<strike>gone<\/strike>/)
  })
})

describe('a PDF’s table of contents', () => {
  it('becomes a list nested by its numbers, each line going to its heading in the note', async () => {
    const { makePdf } = await import('./pdfHelper')
    const pdf = makePdf([
      [[24, 'Contents'], [11, '1 Introduction ............................ 2'], [11, '1.1 Overview ............................ 2'], [11, '2 Game Rules ....................... 3'], [11, '2.1 Fouls ............................ 3']],
      [[24, '1 Introduction'], [16, '1.1 Overview'], [11, 'Welcome to the game.']],
      [[24, '2 Game Rules'], [16, '2.1 Fouls'], [11, 'G301 Robots may not damage the field.']],
    ])
    const pdfServer = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(pdf))
    await new Promise<void>((r) => pdfServer.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(pdfServer.address() as AddressInfo).port}/Contents.pdf`
      const r = await importWebPages(app.config, app.store, app.ai, app.sync, { url, folderId: null })
      const m = md(r.noteIds[0])
      expect(m).toContain('- [[1 Introduction]]\n  - [[1.1 Overview]]\n- [[2 Game Rules]]\n  - [[2.1 Fouls]]')
      expect(m).not.toContain('.....')
      const xml = getContent(app.sync.getDoc(noteDocName(r.noteIds[0]))!).toString()
      expect(xml).toContain(`<notelink find="2.1 Fouls" label="2.1 Fouls" noteId="${r.noteIds[0]}"`)
    } finally {
      pdfServer.close()
    }
  })

  it('reads its entries even where the dots and page numbers run into the next one', () => {
    const text =
      '1.10 Question and Answer System ............................................................ 12 2 FIRST Season Overview ....................................................... 13 3 Game Sponsor Recognition ........................................................ 15 4 Game Overview ...................... 17 5 ARENA ................................ 19 5.1 FIELD........................................ 19 5.2 Areas, Zones, & Markings.................................. 21 5.3 REEF ........................ 23 5.4.1 CAGE ............. 26'
    expect(contentsEntries(text).map((e) => `${e.num} ${e.title} ${e.page}`)).toEqual([
      '1.10 Question and Answer System 12',
      '2 FIRST Season Overview 13',
      '3 Game Sponsor Recognition 15',
      '4 Game Overview 17',
      '5 ARENA 19',
      '5.1 FIELD 19',
      '5.2 Areas, Zones, & Markings 21',
      '5.3 REEF 23',
      '5.4.1 CAGE 26',
    ])
  })
})
