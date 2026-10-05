import fs from 'node:fs'
import path from 'node:path'
import {
  WORKSPACE_DOC,
  buildTree,
  extractNote,
  listFolders,
  listNotes,
  noteDocName,
  noteToMarkdown,
  type TreeNode,
} from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { log } from './log'

/**
 * Backups
 * =======
 *
 * Each backup is a timestamped directory containing:
 *
 *   reconnotes.db   – a consistent copy of the database (restore = copy back)
 *   markdown/       – every note as a Markdown file in its folder structure,
 *                     readable without ReconNotes
 *   manifest.json
 *
 * Attachments are immutable, so they are stored once in a shared `blobs/`
 * directory next to the backups and only new files are copied each time.
 */
export async function runBackup(config: Config, store: Store, sync: SyncEngine): Promise<string> {
  sync.hocuspocus.flushPendingStores()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(config.backupDir, stamp)
  fs.mkdirSync(dir, { recursive: true })

  await store.db.backup(path.join(dir, 'reconnotes.db'))

  const blobsOut = path.join(config.backupDir, 'blobs')
  const copied = copyNewFiles(store.blobDir, blobsOut)

  const notes = exportMarkdown(sync, path.join(dir, 'markdown'), blobsOut)

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), notes, newAttachments: copied }, null, 2),
  )
  prune(config.backupDir, config.backupKeep)
  log.info(`backup written to ${dir} (${notes} notes, ${copied} new attachments)`)
  return dir
}

export function listBackups(config: Config): string[] {
  if (!fs.existsSync(config.backupDir)) return []
  return fs
    .readdirSync(config.backupDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d))
    .sort()
    .reverse()
}

function prune(backupDir: string, keep: number) {
  const all = fs
    .readdirSync(backupDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d))
    .sort()
  for (const d of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(backupDir, d), { recursive: true, force: true })
  }
}

function copyNewFiles(src: string, dest: string): number {
  let n = 0
  if (!fs.existsSync(src)) return 0
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) n += copyNewFiles(s, d)
    else if (!entry.name.endsWith('.tmp') && !fs.existsSync(d)) {
      fs.mkdirSync(dest, { recursive: true })
      try {
        fs.linkSync(s, d) // free when on the same filesystem
      } catch {
        fs.copyFileSync(s, d)
      }
      n++
    }
  }
  return n
}

export const safeName = (s: string) => (s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 80) || 'Untitled')

function exportMarkdown(sync: SyncEngine, outDir: string, blobsDir: string): number {
  const ws = sync.getDoc(WORKSPACE_DOC)
  if (!ws) return 0
  const folders = listFolders(ws)
  const folderPath = new Map<string, string>()
  const walk = (nodes: TreeNode[], base: string) => {
    for (const n of nodes) {
      const p = path.join(base, safeName(n.folder.name))
      folderPath.set(n.folder.id, p)
      walk(n.children, p)
    }
  }
  walk(buildTree(folders), outDir)

  let count = 0
  const used = new Set<string>()
  for (const note of listNotes(ws)) {
    const doc = sync.getDoc(noteDocName(note.id))
    if (!doc) continue
    let dir = (note.folderId && folderPath.get(note.folderId)) || outDir
    if (note.trashedAt) dir = path.join(outDir, '.trash')
    fs.mkdirSync(dir, { recursive: true })
    const title = safeName(note.title || extractNote(doc).title || 'Untitled')
    let file = path.join(dir, title + '.md')
    for (let i = 2; used.has(file); i++) file = path.join(dir, `${title} (${i}).md`)
    used.add(file)
    const md = noteToMarkdown(doc, {
      attachmentUrl: (id) => path.relative(dir, path.join(blobsDir, id.slice(-2), id)).split(path.sep).join('/'),
    })
    fs.writeFileSync(file, md)
    fs.utimesSync(file, new Date(), new Date(note.updatedAt || Date.now()))
    count++
  }
  return count
}

/** Schedule periodic backups. Returns a function that stops the schedule. */
export function scheduleBackups(config: Config, store: Store, sync: SyncEngine): () => void {
  if (!config.backupIntervalHours || config.backupIntervalHours <= 0) return () => {}
  const run = () => runBackup(config, store, sync).catch((err) => log.error('backup failed', err))
  const ms = config.backupIntervalHours * 3600_000
  const last = listBackups(config)[0]
  const lastTime = last ? Date.parse(last.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')) : 0
  const first = setTimeout(run, Math.max(60_000, lastTime + ms - Date.now()))
  const every = setInterval(run, ms)
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
