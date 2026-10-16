import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * End-to-end feature checks: the real server, a stand-in AI (an OpenAI-compatible server that
 * answers like a model would), and a browser. Covers:
 *   - Edit in a note's chat: just the selected part, with a quick change, and Revert
 *   - a suggested title and tags (after pasting into an empty note)
 *   - due dates with a time ("!tomorrow 3pm"), the Week view, dragging onto Tomorrow, snooze
 *   - Undo after deleting a folder
 *   - the sync button counting changes made while the server is away
 *
 *   npm run build && npm run e2e:features [screenshot-dir]
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-shots-'))
fs.mkdirSync(SHOTS, { recursive: true })
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-e2e-features-'))
const TOKEN = 'e2e-token-0123456789abcdef'
const PORT = 8821
const AI_PORT = 8829

// the stand-in AI: answers each kind of request the way a model would
const ai = http
  .createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'stand-in' }] }))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const prompt = JSON.stringify(body.messages ?? '')
    const content = prompt.includes('Rewrite the part of a note below')
      ? '- [ ] milk\n- [ ] eggs\n\n===CHANGED===\nMade it a to-do list.'
      : prompt.includes('Suggest a title and tags')
        ? 'Title: Weekend Plans\nTags: personal, errands'
        : 'ok'
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)
      return res.end()
    }
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
  .listen(AI_PORT)

const startServer = () =>
  spawn('node', [path.join(ROOT, 'apps/server/dist/index.js')], {
    env: { ...process.env, RECON_TOKEN: TOKEN, RECON_DATA_DIR: DATA, RECON_PORT: String(PORT), RECON_HTTPS_PORT: String(PORT + 1), RECON_WEB_DIR: path.join(ROOT, 'apps/web/dist'), RECON_BACKUP_INTERVAL_HOURS: '0' },
    stdio: 'inherit',
  })
let server = startServer()
await new Promise((r) => setTimeout(r, 1500))
const api = (method, url, body) =>
  fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())
await api('POST', '/api/ai/agents', { name: 'Stand-in', kind: 'openai', baseUrl: `http://127.0.0.1:${AI_PORT}/v1`, model: 'stand-in', vision: false })

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const errors = []
const check = (ok, what) => {
  if (!ok) throw new Error(`check failed: ${what}`)
  console.log(`✓ ${what}`)
}
const text = async (p) => (await p.locator('.ProseMirror').first().innerText()).replace(/\n+/g, ' | ')

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await p.addInitScript(([port, token]) => {
    localStorage.setItem('reconnotes.tourSeen', '1')
    localStorage.setItem('reconnotes.settings', JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token }))
  }, [PORT, TOKEN])
  await p.goto(`http://127.0.0.1:${PORT}/`)
  await p.waitForSelector('.sync-online', { timeout: 10000 })
  const newNote = async () => {
    await p.getByText('All Notes').first().click()
    await p.locator('button[aria-label="New note"]').first().click()
    await p.waitForSelector('.note-content')
    await p.locator('.ProseMirror').first().click()
  }

  // ---- Edit just the selected part, with a quick change; then Revert
  await newNote()
  await p.keyboard.type('Weekend\nGroceries\nmilk\neggs\nbread\nCall mom on Sunday.')
  await p.waitForTimeout(1200)
  await p.locator('.ProseMirror p', { hasText: 'milk' }).click()
  await p.keyboard.press('Home')
  await p.keyboard.press('Shift+ArrowDown')
  await p.keyboard.press('Shift+End')
  await p.waitForTimeout(400)
  await p.locator('button[aria-label="Chat about this note"]').click()
  await p.getByRole('radio', { name: 'Edit' }).click()
  check((await p.locator('.ask-edit-part').innerText()).includes('milk'), 'Edit shows the selected part')
  await p.locator('.ask-quick button', { hasText: 'To-do list' }).click()
  await p.locator('.ask-edit-done').first().waitFor({ timeout: 30000 })
  await p.waitForTimeout(1200)
  check((await p.locator('.ProseMirror ul[data-type="taskList"] li').count()) === 2, 'only the selected lines became to-dos')
  check((await text(p)).includes('bread | Call mom'), 'the rest of the note is as it was')
  await p.screenshot({ path: `${SHOTS}/f1-edit-part.png` })
  await p.getByRole('button', { name: 'Revert' }).click()
  await p.waitForTimeout(1200)
  check((await p.locator('.ProseMirror ul[data-type="taskList"] li').count()) === 0, 'Revert puts it back')
  await p.locator('button[aria-label="Close the chat"]').first().click()

  // ---- a title and tags, suggested after pasting into an empty note
  await newNote()
  await p.evaluate((t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, 'This weekend we need to get groceries: milk, eggs and bread. Then call mom on Sunday about the trip in December, and book the hotel for three nights near the station. Also remember to water the plants before leaving.')
  await p.locator('.suggest-bar button', { hasText: 'Use title' }).waitFor({ timeout: 20000 }).catch(async (e) => {
    await p.screenshot({ path: `${SHOTS}/f2-suggest-failed.png` })
    const jobs = await api('GET', '/api/jobs')
    console.log('jobs:', JSON.stringify((jobs.jobs ?? jobs).map?.((j) => [j.kind, j.status, j.error, j.noteId]) ?? jobs).slice(0, 800))
    throw e
  })
  await p.screenshot({ path: `${SHOTS}/f2-suggest.png` })
  await p.locator('.suggest-bar button', { hasText: 'Use title' }).click()
  await p.locator('.suggest-bar button', { hasText: 'Add tags' }).click()
  await p.waitForTimeout(800)
  check((await p.locator('.ProseMirror h1').innerText()) === 'Weekend Plans', 'the suggested title is used')
  check((await text(p)).includes('#personal #errands'), 'the suggested tags are added')

  // ---- due dates with a time, the week, dragging, snooze
  await newNote()
  await p.keyboard.type('Chores\n')
  await p.keyboard.type('[] Call the dentist !tomorrow 3pm \nOld thing !2020-01-10 \nPay rent !today ')
  await p.waitForTimeout(1500)
  check((await p.locator('.due-chip').first().innerText()).includes('3'), 'the time shows on the date')
  const tasks = await api('GET', '/api/tasks')
  check(tasks.tasks.some((t) => t.text.startsWith('Call the dentist') && t.time === '15:00'), 'the time is saved with the to-do')
  await p.locator('.folder-row', { has: p.locator('.folder-name', { hasText: /^Due$/ }) }).click()
  await p.waitForTimeout(800)
  const row = p.locator('.due-row', { hasText: 'Old thing' })
  const box = await row.boundingBox()
  await p.mouse.move(box.x + 60, box.y + 10)
  await p.mouse.down()
  await p.mouse.move(box.x + 80, box.y + 40, { steps: 5 })
  const drop = await p.locator('.due-drop-bar span', { hasText: 'Tomorrow' }).boundingBox()
  await p.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(1200)
  check((await p.locator('.due-group', { hasText: 'Tomorrow' }).innerText()).includes('Old thing'), 'dragged onto Tomorrow')
  await p.locator('.due-row', { hasText: 'Pay rent' }).locator('.due-snooze').click()
  await p.locator('.menu button', { hasText: 'Next week' }).click()
  await p.waitForTimeout(1200)
  check(!(await p.locator('.due-group', { hasText: 'Today' }).innerText().catch(() => '')).includes('Pay rent'), 'snoozed off today')
  await p.getByRole('tab', { name: 'Week' }).click()
  await p.waitForTimeout(500)
  check((await p.locator('.week-day').count()) === 7, 'the week shows seven days')
  await p.screenshot({ path: `${SHOTS}/f3-week.png` })

  // ---- Undo after deleting a folder
  const folder = p.locator('.folder-row', { hasText: 'ReconNotes Setup' })
  await folder.hover()
  await folder.locator('.row-menu').click()
  await p.locator('.menu button.danger').last().click()
  await p.waitForTimeout(500)
  check((await folder.count()) === 0, 'the folder is deleted')
  await p.locator('.toast button', { hasText: 'Undo' }).click()
  await p.waitForTimeout(500)
  check((await folder.count()) === 1, 'Undo brings the folder back')

  // ---- the sync button counts changes made while the server is away
  server.kill()
  await p.waitForSelector('.sync-offline', { timeout: 10000 })
  await newNote()
  await p.keyboard.type('Written offline')
  await p.waitForTimeout(1500)
  check(Number(await p.locator('.sync-count').innerText()) > 0, 'changes waiting are counted')
  await p.locator('.sync-badge').click()
  await p.screenshot({ path: `${SHOTS}/f4-sync-offline.png` })
  server = startServer()
  await new Promise((r) => setTimeout(r, 1500))
  await p.locator('.sync-panel button', { hasText: 'Sync now' }).click()
  await p.waitForSelector('.sync-online', { timeout: 15000 })
  await p.waitForFunction(() => !document.querySelector('.sync-count'), null, { timeout: 15000 })
  check(true, 'back online, nothing waiting')
} catch (e) {
  console.error('E2E FEATURES FAILED', e)
  process.exitCode = 1
} finally {
  const unexpected = errors.filter((e) => !/WebSocket connection|ERR_CONNECTION_REFUSED|Failed to fetch/.test(e))
  console.log('unexpected page errors:', unexpected.length ? unexpected : 'none')
  if (unexpected.length) process.exitCode = 1
  console.log('screenshots in', SHOTS)
  await browser.close()
  server.kill()
  ai.close()
}
