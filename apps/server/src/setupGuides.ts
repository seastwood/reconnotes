import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_DOC, createFolder, getFolders, readFolder, updateNote } from '@reconnotes/core'
import type { Ai } from './ai'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { importNotes } from './importNotes'

/**
 * Setup guides
 * ============
 *
 * The guides in docs/setup (installing, connecting devices, HTTPS, AI,
 * backups) come with the server as notes in a "ReconNotes Setup" folder,
 * so they're at hand in the app itself. Each guide is added once: edit or
 * delete it and it stays that way. A guide added in a later version of
 * ReconNotes appears after updating.
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

interface State {
  folderId?: string
  /** guides already added (file names) */
  seen: string[]
}

/** Add the guides not added before. Returns the new notes' ids. */
export async function seedSetupGuides(config: Config, store: Store, ai: Ai, sync: SyncEngine, dir = guidesDir()): Promise<string[]> {
  if (!dir) return []
  const state = store.getSetting<State>('setupGuides') ?? { seen: [] }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => (a === FIRST ? -1 : b === FIRST ? 1 : a.localeCompare(b)))
  const fresh = files.filter((f) => !state.seen.includes(f))
  if (!fresh.length) return []
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
    fresh.map((f) => ({ path: f, data: fs.readFileSync(path.join(dir, f)) })),
    folderId,
  )
  // "Start here" at the top of the folder
  const first = fresh.indexOf(FIRST)
  if (first >= 0 && r.noteIds[first]) await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, r.noteIds[first], { pinned: true }))
  store.setSetting('setupGuides', { folderId: folderId ?? undefined, seen: [...state.seen, ...fresh] } satisfies State)
  return r.noteIds
}
