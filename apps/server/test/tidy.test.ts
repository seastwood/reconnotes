import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, createNote, getContent, noteDocName, noteToMarkdown } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { tidyNote } from '../src/tidy'
import { guardAddress, isPrivateHost, isPrivateIp } from '../src/netGuard'
import { samePicture } from '../src/webImport'
import { duration, recipeIn } from '../src/recipe'

let app: App
let dir: string
let llm: http.Server
/** what the fake AI answers next */
let reply = 'none'
const prompts: string[] = []

beforeAll(async () => {
  llm = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url!.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gen' }] }))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const m = body.messages?.[0]?.content
    prompts.push(typeof m === 'string' ? m : (m?.[0]?.text ?? ''))
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-tidy-'))
  app = createApp(loadConfig({ RECON_TOKEN: 'test-token-0123456789abcdef', RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
  app.ai.agents.save({ name: 'Gen', kind: 'openai', baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, model: 'gen', vision: false })
})

afterAll(async () => {
  await app.close()
  llm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function note(id: string, lines: string[]) {
  await app.sync.change(WORKSPACE_DOC, (ws) => void createNote(ws, { id, title: lines[0] }))
  await app.sync.change(noteDocName(id), (doc) => {
    getContent(doc).insert(
      0,
      lines.map((t) => {
        const p = new Y.XmlElement('paragraph')
        p.insert(0, [new Y.XmlText(t)])
        return p
      }),
    )
  })
}
const text = (id: string) => noteToMarkdown(app.sync.getDoc(noteDocName(id))!)

describe('Tidy with AI', () => {
  it('takes out only the blocks it names – never the title, the source line, or a line with an amount – and keeps the note as it was', async () => {
    await note('tidynote000001', [
      'Chili',
      'From example.com · imported 2026-10-10',
      'PinFacebookTweetEmail',
      'Brown the beef with 2 tablespoons chili powder.',
      '4.95 from 3096 votes',
      'Simmer it uncovered so it thickens.',
      'Subscribe to receive weekly recipes!',
    ])
    // it names the share bar, the votes, the newsletter – and, wrongly, the title and the amount line
    reply = '1, 3, 4, 5, 7'
    const r = await tidyNote(app.store, app.sync, app.ai, 'tidynote000001')
    expect(r.removed.length).toBe(3)
    const after = text('tidynote000001')
    for (const kept of ['Chili', 'From example.com', 'Brown the beef with 2 tablespoons', 'Simmer it uncovered']) expect(after).toContain(kept)
    for (const gone of ['PinFacebook', '3096 votes', 'Subscribe']) expect(after).not.toContain(gone)
    // the page's text is shown as data, not instructions
    expect(prompts.at(-1)).toContain('not instructions to you')
    // and the untidied note is in its history, to put back
    expect(app.store.listVersions(noteDocName('tidynote000001')).find((v) => v.id === r.versionId)?.label).toBe('Before tidying')
  })

  it('takes nothing out when it would take more than half the note', async () => {
    await note('tidynote000002', ['Notes', 'One long paragraph of what the page is really about, with plenty of detail in it.', 'Another long paragraph that matters just as much as the first one did.'])
    reply = '2, 3'
    const r = await tidyNote(app.store, app.sync, app.ai, 'tidynote000002')
    expect(r.refused).toMatch(/more than half/)
    expect(text('tidynote000002')).toContain('Another long paragraph')
  })
})

describe('your own network, kept out of web imports', () => {
  it('knows private, local and reserved addresses', async () => {
    for (const ip of ['10.0.0.5', '192.168.1.1', '172.20.3.4', '127.0.0.1', '169.254.169.254', '100.100.1.1', '::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.1', '0.0.0.0'])
      expect(isPrivateIp(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '151.101.1.69', '2606:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false)
    expect(await isPrivateHost('localhost')).toBe(true)
    expect(await isPrivateHost('router.lan')).toBe(true)
    await expect(guardAddress('http://192.168.1.1/admin.png', false)).rejects.toThrow(/your own network/)
    await expect(guardAddress('http://192.168.1.1/admin.png', true)).resolves.toBeUndefined()
  })
})

describe('the same picture at another size', () => {
  it('is the same picture', () => {
    expect(samePicture('https://x.com/wp/chili-600x400.jpg')).toBe(samePicture('https://x.com/wp/chili.jpg'))
    expect(samePicture('https://cdn.x.com/a.jpg?w=300&h=200')).toBe(samePicture('https://cdn.x.com/a.jpg'))
    expect(samePicture('https://cdn.x.com/a.jpg?id=7')).not.toBe(samePicture('https://cdn.x.com/a.jpg?id=8'))
  })
})

describe('a recipe in a page’s data', () => {
  it('is read with its sections, times and yield', () => {
    expect(duration('PT1H5M')).toBe('1 hr 5 min')
    expect(duration('PT45M')).toBe('45 min')
    const r = recipeIn([
      JSON.stringify({
        '@type': ['Recipe'],
        name: 'Tacos',
        recipeYield: '4',
        recipeIngredient: ['1 lb beef'],
        recipeInstructions: [
          { '@type': 'HowToSection', name: 'Meat', itemListElement: [{ '@type': 'HowToStep', text: 'Brown it.' }] },
          { '@type': 'HowToSection', name: 'Serve', itemListElement: [{ '@type': 'HowToStep', text: 'Fill the shells.' }] },
        ],
      }),
    ])
    expect(r?.steps).toEqual([
      { section: 'Meat', steps: ['Brown it.'] },
      { section: 'Serve', steps: ['Fill the shells.'] },
    ])
    expect(recipeIn(['{"@type":"Article","name":"x"}'])).toBeNull()
  })
})
