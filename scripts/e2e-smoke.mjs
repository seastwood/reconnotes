import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * End-to-end smoke test: runs the real server and two browser "devices"
 * (iPad and iPhone sized), then exercises folders, rich text, checklists,
 * drawing with undo/redo, images, sync, offline edits that merge, and search.
 *
 *   npm run build && npm run e2e [screenshot-dir]
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SHOTS = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-shots-'))
fs.mkdirSync(SHOTS, { recursive: true })
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-e2e-'))
const TOKEN = 'e2e-token-0123456789abcdef'
const PORT = 8811
const startServer = () => spawn('node', [path.join(ROOT, 'apps/server/dist/index.js')], {
  env: { ...process.env, RECON_TOKEN: TOKEN, RECON_DATA_DIR: DATA, RECON_PORT: String(PORT), RECON_WEB_DIR: path.join(ROOT, 'apps/web/dist'), RECON_BACKUP_INTERVAL_HOURS: '0' },
  stdio: 'inherit',
})
let server = startServer()
await new Promise((r) => setTimeout(r, 1200))
const URL = `http://127.0.0.1:${PORT}/`
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const errors = []

async function device(name, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`))
  await page.goto(URL)
  await page.evaluate(([u, t]) => localStorage.setItem('reconnotes.settings', JSON.stringify({ serverUrl: u, token: t })), [URL.slice(0, -1), TOKEN])
  await page.reload()
  await page.waitForSelector('.app')
  return { ctx, page }
}

try {
  const ipad = await device('ipad', { width: 1180, height: 820 })
  const p = ipad.page
  await p.waitForSelector('.sync-online', { timeout: 10000 })

  // folders: create, nest
  await p.click('button[aria-label="New folder"]')
  await p.keyboard.type('Work')
  await p.keyboard.press('Enter')
  await p.locator('.folder-row', { hasText: 'Work' }).hover()
  await p.locator('.folder-row', { hasText: 'Work' }).locator('.row-menu').click()
  await p.click('text=New subfolder')
  await p.keyboard.type('Projects')
  await p.keyboard.press('Enter')
  await p.locator('.folder-row', { hasText: 'Projects' }).click()

  // note with styles + checklist
  await p.click('button[aria-label="New note"]')
  await p.waitForSelector('.note-content')
  await p.click('.note-content')
  await p.click('button[title="Text style"]')
  await p.click('.menu >> text=Title')
  await p.keyboard.type('Site survey')
  await p.keyboard.press('Enter')
  await p.keyboard.type('Measured the ')
  await p.keyboard.press('ControlOrMeta+b')
  await p.keyboard.type('north wall')
  await p.keyboard.press('ControlOrMeta+b')
  await p.keyboard.press('Enter')
  await p.keyboard.type('[ ] Order beams')
  await p.keyboard.press('Enter')
  await p.keyboard.type('Check permits')
  await p.keyboard.press('Enter')
  await p.keyboard.press('Enter')

  // drawing: insert and draw with a mouse (pen pointer events can't be synthesized reliably)
  await p.click('button[aria-label="Add drawing"]')
  const canvas = p.locator('.ink-input').first()
  await canvas.waitFor()
  const box = await canvas.boundingBox()
  const draw = async (pts) => {
    await p.mouse.move(box.x + pts[0][0], box.y + pts[0][1])
    await p.mouse.down()
    for (const [x, y] of pts.slice(1)) await p.mouse.move(box.x + x, box.y + y, { steps: 4 })
    await p.mouse.up()
  }
  await draw([[40, 60], [80, 120], [120, 60], [160, 120], [200, 60]])
  await draw([[240, 60], [240, 130]])
  await draw([[230, 60], [300, 60], [300, 95], [240, 95]])
  await p.click('.ink-tool[aria-label="Highlighter"]')
  await draw([[30, 160], [330, 160]])
  await p.waitForTimeout(400)
  const strokesBefore = await p.evaluate(() => document.querySelectorAll('.drawing-block').length)
  await p.screenshot({ path: `${SHOTS}/1-ipad-drawing.png` })

  // undo removes the highlighter stroke; check via image diff of canvas
  const pixel = async () => p.evaluate(() => {
    const c = document.querySelector('.ink-layer')
    return c.toDataURL().length
  })
  const withHl = await pixel()
  await p.click('.ink-toolbar button[aria-label="Undo"]')
  await p.waitForTimeout(200)
  const afterUndo = await pixel()
  await p.click('.ink-toolbar button[aria-label="Redo"]')
  await p.waitForTimeout(200)
  const afterRedo = await pixel()
  console.log('undo changed canvas:', withHl !== afterUndo, 'redo restored:', afterRedo === withHl)
  await p.click('.ink-toolbar button[aria-label="Done drawing"]')

  // image paste via file input
  const png = fs.readFileSync(path.join(ROOT, 'apps/web/public/icon-180.png'))
  await p.setInputFiles('input[accept="image/*"]:not([capture])', { name: 'shot.png', mimeType: 'image/png', buffer: png })
  await p.waitForSelector('.image-block img', { timeout: 5000 })
  await p.waitForTimeout(1500)
  await p.screenshot({ path: `${SHOTS}/2-ipad-note.png` })

  // second device (iPhone) sees the same note
  const iphone = await device('iphone', { width: 390, height: 844 })
  const q = iphone.page
  await q.waitForSelector('.sync-online', { timeout: 10000 })
  await q.click('.folder-row:has-text("All Notes")')
  await q.waitForSelector('.note-row:has-text("Site survey")', { timeout: 10000 })
  await q.click('.note-row:has-text("Site survey")')
  await q.waitForSelector('.note-content h1:has-text("Site survey")', { timeout: 10000 })
  await q.waitForSelector('.image-block img', { timeout: 10000 })
  await q.waitForTimeout(800)
  await q.screenshot({ path: `${SHOTS}/3-iphone-synced.png` })

  // both go offline and edit the same note
  await p.waitForTimeout(2500) // let the server persist
  server.kill()
  await p.waitForSelector('.sync-offline, .sync-connecting', { timeout: 15000 })
  await p.screenshot({ path: `${SHOTS}/3b-ipad-offline.png` })
  await p.click('.note-content h1')
  await p.keyboard.press('End')
  await p.keyboard.type(' (iPad edit)')
  await q.click('.note-content h1')
  await q.keyboard.press('End')
  await q.keyboard.press('Enter')
  await q.keyboard.type('Added on the iPhone while offline')
  await p.waitForTimeout(500)
  server = startServer()
  const merged = async (page) => page.waitForFunction(() => {
    const t = document.querySelector('.note-content').innerText
    return t.includes('(iPad edit)') && t.includes('Added on the iPhone while offline')
  }, null, { timeout: 30000 })
  await merged(p)
  await merged(q)
  console.log('offline edits merged on both devices')
  await p.screenshot({ path: `${SHOTS}/4-ipad-merged.png` })

  // search (local index + server)
  await q.click('button[aria-label="Back"]')
  await q.click('button[aria-label="Back to folders"]')
  await q.fill('.search input', 'beams')
  await q.waitForSelector('.note-row:has-text("Site survey")', { timeout: 5000 })
  await q.screenshot({ path: `${SHOTS}/5-iphone-search.png` })
  console.log('search ok')

  // dark mode
  await p.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/6-ipad-dark.png` })
} catch (e) {
  console.error('E2E FAILED', e)
  process.exitCode = 1
} finally {
  // connection errors are expected while the server is deliberately stopped
  const unexpected = errors.filter((e) => !/WebSocket connection|ERR_CONNECTION_REFUSED/.test(e))
  console.log('unexpected page errors:', unexpected.length ? unexpected : 'none')
  if (unexpected.length) process.exitCode = 1
  console.log('screenshots in', SHOTS)
  await browser.close()
  server.kill()
}
