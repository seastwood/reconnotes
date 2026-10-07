import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_DOC, getContent, listFolders, listNotes, noteDocName, updateNote } from '@reconnotes/core'
import { loadConfig } from '../src/config'
import { createApp, type App } from '../src/app'
import { GUIDES_FOLDER, guidesDir, seedSetupGuides } from '../src/setupGuides'

let app: App
let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-guides-'))
  app = createApp(loadConfig({ RECON_TOKEN: 'test-token-0123456789abcdef', RECON_DATA_DIR: dir, RECON_AUTO_HANDWRITING: 'false' }), { backups: false })
})

afterAll(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ws = () => app.sync.getDoc(WORKSPACE_DOC)!
const guideNotes = () => {
  const folder = listFolders(ws()).find((f) => f.name === GUIDES_FOLDER && !f.trashedAt)!
  return listNotes(ws()).filter((n) => n.folderId === folder?.id && !n.trashedAt)
}

describe('setup guides', () => {
  it('come with the server as notes in a ReconNotes Setup folder, Start here pinned, linked to each other', async () => {
    const src = guidesDir()!
    expect(src).toBeTruthy()
    const files = fs.readdirSync(src).filter((f) => f.endsWith('.md'))
    expect(files).toContain('HTTPS with your own domain.md')
    const ids = await seedSetupGuides(app.config, app.store, app.ai, app.sync)
    expect(ids).toHaveLength(files.length)
    const notes = guideNotes()
    expect(notes.map((n) => n.title).sort()).toEqual(files.map((f) => f.replace(/\.md$/, '')).sort())
    const start = notes.find((n) => n.title === 'Start here')!
    expect(start.pinned).toBe(true)
    // [[links]] between the guides are real note links
    const content = getContent(app.sync.getDoc(noteDocName(start.id))!).toString()
    expect((content.match(/<notelink/gi) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('are added once: what you edit or delete stays that way; a new guide arrives after an update', async () => {
    const before = guideNotes()
    await app.sync.change(WORKSPACE_DOC, (d) => updateNote(d, before.find((n) => n.title === 'AI agents')!.id, { trashedAt: Date.now() }))
    expect(await seedSetupGuides(app.config, app.store, app.ai, app.sync)).toEqual([]) // nothing comes back
    expect(guideNotes().some((n) => n.title === 'AI agents')).toBe(false)
    // a later version brings one more guide
    const next = fs.mkdtempSync(path.join(os.tmpdir(), 'reconnotes-guides-next-'))
    for (const f of fs.readdirSync(guidesDir()!)) fs.copyFileSync(path.join(guidesDir()!, f), path.join(next, f))
    fs.writeFileSync(path.join(next, 'Something new.md'), '# Something new\n\nA new guide.')
    const added = await seedSetupGuides(app.config, app.store, app.ai, app.sync, next)
    expect(added).toHaveLength(1)
    expect(guideNotes().map((n) => n.title)).toContain('Something new') // in the same folder
    fs.rmSync(next, { recursive: true, force: true })
  })
})
