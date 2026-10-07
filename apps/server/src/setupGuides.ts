import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_DOC, createFolder, getContent, getFolders, noteDocName, readFolder, updateNote } from '@reconnotes/core'
import type { Ai } from './ai'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { importNotes, markdownToNodes } from './importNotes'

/**
 * Setup guides
 * ============
 *
 * The guides in docs/setup (installing, connecting devices, HTTPS, AI,
 * backups) come with the server as notes in a "ReconNotes Setup" folder,
 * so they're at hand in the app itself. Each guide is added once: delete it
 * and it stays deleted. When an update improves a guide, its note is brought
 * up to date – unless you've edited that note, which then stays yours. A
 * guide added in a later version appears after updating.
 */

export const GUIDES_FOLDER = 'ReconNotes Setup'
const FIRST = 'Start here.md'

/** Where the guides are: the repo's docs/setup (next to the built server), or the Docker image's. */
export function guidesDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const d of [process.env.RECON_GUIDES_DIR, path.resolve(here, '../../../docs/setup'), path.resolve(here, '../docs/setup')]) {
    if (d && fs.existsSync(d)) return d
  }
  return null
}

interface Guide {
  noteId: string
  /** the guide's text when it was last written into the note */
  hash: string
  /** when it was written (a later edit in the note = yours: left alone) */
  at: number
}
interface State {
  folderId?: string
  /** guides already added (file names) */
  seen: string[]
  guides?: Record<string, Guide>
}

const hashOf = (s: string) => crypto.createHash('sha1').update(s).digest('hex')
const titleOf = (file: string) => file.replace(/\.md$/, '')

/**
 * Add the guides not added before, and bring the ones you haven't edited up
 * to date when a newer version of ReconNotes ships a better guide. Returns
 * the ids of the notes added or updated.
 */
export async function seedSetupGuides(config: Config, store: Store, ai: Ai, sync: SyncEngine, dir = guidesDir()): Promise<string[]> {
  if (!dir) return []
  const state = store.getSetting<State>('setupGuides') ?? { seen: [] }
  const guides = { ...(state.guides ?? {}) }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => (a === FIRST ? -1 : b === FIRST ? 1 : a.localeCompare(b)))
  const text = new Map(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]))
  const meta = sync.noteMeta()
  // guides added before this record was kept: find their notes by title in the folder
  for (const f of state.seen) {
    if (guides[f]) continue
    const m = [...meta.values()].find((n) => n.folderId === state.folderId && n.title === titleOf(f) && !n.trashedAt)
    if (m) guides[f] = { noteId: m.id, hash: '', at: m.createdAt }
  }
  const changed: string[] = []

  // 1. newer versions of guides you haven't touched
  const titles = new Map<string, string>()
  for (const [f, g] of Object.entries(guides)) titles.set(titleOf(f).toLowerCase(), g.noteId)
  for (const f of files) {
    const g = guides[f]
    const m = g && meta.get(g.noteId)
    if (!g || !m || m.trashedAt || g.hash === hashOf(text.get(f)!)) continue
    // edited since it was written (a few seconds' grace for the first sync)
    if (m.updatedAt > g.at + 10_000) continue
    await sync.change(noteDocName(g.noteId), (doc) => {
      const content = getContent(doc)
      content.delete(0, content.length)
      content.insert(0, markdownToNodes(text.get(f)!, { attach: () => null, noteFor: (t) => titles.get(t.toLowerCase()) ?? null }))
    })
    guides[f] = { noteId: g.noteId, hash: hashOf(text.get(f)!), at: Date.now() }
    changed.push(g.noteId)
  }

  // 2. guides not added before
  const fresh = files.filter((f) => !state.seen.includes(f))
  if (fresh.length) {
    // the folder made before, if it's still there; else a new one
    let folderId = state.folderId ?? null
    await sync.change(WORKSPACE_DOC, (ws) => {
      const m = folderId ? getFolders(ws).get(folderId) : null
      if (!m || readFolder(m).trashedAt) folderId = createFolder(ws, { name: GUIDES_FOLDER })
    })
    const r = await importNotes(
      config,
      store,
      ai,
      sync,
      fresh.map((f) => ({ path: f, data: Buffer.from(text.get(f)!) })),
      folderId,
    )
    fresh.forEach((f, i) => (guides[f] = { noteId: r.noteIds[i], hash: hashOf(text.get(f)!), at: Date.now() }))
    // "Start here" at the top of the folder
    const first = fresh.indexOf(FIRST)
    if (first >= 0 && r.noteIds[first]) await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, r.noteIds[first], { pinned: true }))
    state.folderId = folderId ?? undefined
    changed.push(...r.noteIds)
  }
  store.setSetting('setupGuides', { folderId: state.folderId, seen: [...new Set([...state.seen, ...fresh])], guides } satisfies State)
  return changed
}
