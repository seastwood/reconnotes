import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as Y from 'yjs'
import {
  WORKSPACE_DOC,
  getFolders,
  getNotes,
  noteDocName,
  readFolder,
  readNote,
  restoreNoteContent,
  type FolderData,
} from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { snapshotNow } from './versions'
import { log } from './log'

/**
 * Restoring from a backup
 * =======================
 *
 * A backup holds a copy of the database. Restoring never swaps the database
 * file (devices would fight it, since they still hold the newer state);
 * instead the backed-up notes are written back as ordinary edits, exactly
 * like restoring a version, so every device syncs to them. The note's
 * current state is kept in its version history first, and notes that didn't
 * exist at the time of the backup go to Recently Deleted, so nothing is lost.
 */

export interface BackupInfo {
  name: string
  createdAt: string
  notes: number
}

export interface BackupNote {
  id: string
  title: string
  folder: string
  /** compared with the note now */
  status: 'same' | 'changed' | 'deleted' | 'trashed'
}

const NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/

function backupDb(config: Config, name: string): Database.Database {
  if (!NAME.test(name)) throw new Error('unknown backup')
  const file = path.join(config.backupDir, name, 'reconnotes.db')
  if (!fs.existsSync(file)) throw new Error('unknown backup')
  return new Database(file, { readonly: true, fileMustExist: true })
}

function loadDoc(db: Database.Database, name: string): Y.Doc | null {
  const row = db.prepare('SELECT state FROM documents WHERE name = ?').get(name) as { state: Buffer } | undefined
  if (!row) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(row.state))
  return doc
}

export function describeBackups(config: Config, names: string[]): BackupInfo[] {
  return names.map((name) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(config.backupDir, name, 'manifest.json'), 'utf8'))
      return { name, createdAt: m.createdAt, notes: m.notes ?? 0 }
    } catch {
      return { name, createdAt: name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z'), notes: 0 }
    }
  })
}

/** What a note's content looks like, to tell whether it changed since the backup. */
function fingerprint(doc: Y.Doc | null): string {
  if (!doc) return ''
  const parts = [doc.getXmlFragment('content').toString()]
  for (const key of [...doc.share.keys()].sort()) {
    if (!key.startsWith('ink:')) continue
    const ink = doc.getArray<{ id: string }>(key)
    parts.push(`${key}:${ink.length}:${ink.length ? ink.get(ink.length - 1)?.id : ''}`)
  }
  return parts.join('|')
}

function folderPath(folders: Map<string, FolderData>, id: string | null): string {
  const names: string[] = []
  for (let f = id ? folders.get(id) : undefined; f && names.length < 20; f = f.parentId ? folders.get(f.parentId) : undefined) names.unshift(f.name)
  return names.join(' / ')
}

/** The notes in a backup, and how each compares with now. */
export function backupNotes(config: Config, sync: SyncEngine, name: string): BackupNote[] {
  const db = backupDb(config, name)
  try {
    const ws = loadDoc(db, WORKSPACE_DOC)
    if (!ws) return []
    const folders = new Map<string, FolderData>()
    getFolders(ws).forEach((m) => {
      const f = readFolder(m)
      folders.set(f.id, f)
    })
    const now = getNotes(sync.getDoc(WORKSPACE_DOC) ?? new Y.Doc())
    const out: BackupNote[] = []
    getNotes(ws).forEach((m) => {
      const n = readNote(m)
      if (n.trashedAt) return
      const current = now.get(n.id)
      let status: BackupNote['status']
      if (!current) status = 'deleted'
      else if (readNote(current).trashedAt) status = 'trashed'
      else status = fingerprint(loadDoc(db, noteDocName(n.id))) === fingerprint(sync.getDoc(noteDocName(n.id))) ? 'same' : 'changed'
      out.push({ id: n.id, title: n.title || 'Untitled', folder: folderPath(folders, n.folderId), status })
    })
    return out.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title))
  } finally {
    db.close()
  }
}

/** Copy a Y.Map's entries (folder / note metadata) into a new map. */
function cloneMeta(m: Y.Map<unknown>): Y.Map<unknown> {
  const out = new Y.Map<unknown>()
  m.forEach((v, k) => out.set(k, Array.isArray(v) ? [...v] : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v))
  return out
}

/**
 * Restore notes from a backup: the given ones, or (no ids) the whole
 * library as it was then. Returns how many notes were restored.
 */
export async function restoreFromBackup(
  config: Config,
  store: Store,
  sync: SyncEngine,
  name: string,
  noteIds: string[] | null,
): Promise<{ restored: number; trashed: number }> {
  const db = backupDb(config, name)
  try {
    const ws = loadDoc(db, WORKSPACE_DOC)
    if (!ws) throw new Error('This backup has no notes in it.')
    const backedUp = getNotes(ws)
    const ids = (noteIds ?? [...backedUp.keys()].filter((id) => !readNote(backedUp.get(id)!).trashedAt)).filter((id) => backedUp.has(id))
    const wanted = new Set(ids)

    // 1. the notes' contents
    const touched = new Set<string>()
    for (const id of ids) {
      const old = loadDoc(db, noteDocName(id))
      if (!old) continue
      const docName = noteDocName(id)
      const current = sync.getDoc(docName)
      if (current && fingerprint(current) === fingerprint(old)) continue
      if (current) snapshotNow(store, docName, current, 'Before restoring a backup')
      await sync.change(docName, (doc) => restoreNoteContent(doc, old))
      touched.add(id)
    }

    // 2. the folders and note list: bring back what's missing, untrash what
    //    was restored, and (whole library) put newer notes in Recently Deleted
    let trashed = 0
    const now = Date.now()
    await sync.change(WORKSPACE_DOC, (doc) => {
      const folders = getFolders(doc)
      const notes = getNotes(doc)
      const oldFolders = getFolders(ws)
      const needFolder = (id: string | null) => {
        for (let f = id; f; ) {
          const old = oldFolders.get(f)
          if (!old) break
          const cur = folders.get(f)
          if (!cur) folders.set(f, cloneMeta(old))
          else if (cur.get('trashedAt')) cur.set('trashedAt', null)
          f = (old.get('parentId') as string | null) ?? null
        }
      }
      for (const id of ids) {
        const old = backedUp.get(id)!
        const cur = notes.get(id)
        if (!cur) {
          notes.set(id, cloneMeta(old))
          touched.add(id)
        } else {
          if (cur.get('trashedAt')) {
            cur.set('trashedAt', null)
            touched.add(id)
          }
          if (noteIds === null && cur.get('folderId') !== old.get('folderId')) cur.set('folderId', old.get('folderId'))
        }
        needFolder((old.get('folderId') as string | null) ?? null)
      }
      if (noteIds === null) {
        notes.forEach((m, id) => {
          if (!wanted.has(id) && !m.get('trashedAt') && !m.get('template')) {
            m.set('trashedAt', now)
            trashed++
          }
        })
      }
    })
    sync.reindexAll()
    const restored = touched.size
    log.info(`restored ${restored} note(s) from backup ${name}${trashed ? `, ${trashed} newer note(s) moved to Recently Deleted` : ''}`)
    return { restored, trashed }
  } finally {
    db.close()
  }
}
