import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as Y from 'yjs'
import { WORKSPACE_DOC, getNotes, noteDocName, noteToMarkdown, readNote } from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import { listBackups } from './backup'
import { log } from './log'

/**
 * Checking a backup can be restored
 * =================================
 *
 * A backup nobody has tried is only a hope. Once a month (and whenever asked) the newest backup is
 * read the way a restore would read it – never touching the live notes: its database copy must be
 * sound, every note in it must open and turn into Markdown, the Markdown copy must be all there,
 * and every attachment it names must be in the backup's file store. What it found is kept, to show
 * on the Backups page.
 */
export interface BackupCheck {
  at: number
  backup: string | null
  ok: boolean
  /** notes in the backup (not in Recently Deleted), and how many opened */
  notes: number
  readable: number
  attachments: number
  missingAttachments: number
  problems: string[]
}

const KEY = 'backupCheck'
/** how often it checks by itself */
export const CHECK_EVERY_DAYS = 30

export const lastBackupCheck = (store: Store) => store.getSetting<BackupCheck>(KEY)

export function checkBackup(config: Config, store: Store, name = listBackups(config)[0]): BackupCheck {
  const out: BackupCheck = { at: Date.now(), backup: name ?? null, ok: false, notes: 0, readable: 0, attachments: 0, missingAttachments: 0, problems: [] }
  const done = () => {
    out.ok = out.problems.length === 0
    store.setSetting(KEY, out)
    if (out.ok) log.info(`backup check: ${name} restores fine (${out.readable} notes, ${out.attachments} attachments)`)
    else log.warn(`backup check: ${name ?? '(none)'} – ${out.problems.join('; ')}`)
    return out
  }
  if (!name) {
    out.problems.push('There are no backups yet.')
    return done()
  }
  const dir = path.join(config.backupDir, name)
  const file = path.join(dir, 'reconnotes.db')
  if (!fs.existsSync(file)) {
    out.problems.push('The backup has no database copy.')
    return done()
  }
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    if (integrity !== 'ok') out.problems.push(`The database copy is damaged (${integrity}).`)
    const load = (docName: string): Y.Doc | null => {
      const row = db!.prepare('SELECT state FROM documents WHERE name = ?').get(docName) as { state: Buffer } | undefined
      if (!row) return null
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(row.state))
      return doc
    }
    const ws = load(WORKSPACE_DOC)
    // (no list of notes at all: nothing had been written yet – an empty library, not a damaged backup)
    if (!ws) return done()
    const unreadable: string[] = []
    getNotes(ws).forEach((m) => {
      const n = readNote(m)
      if (n.trashedAt) return
      out.notes++
      try {
        const doc = load(noteDocName(n.id))
        // (a note never written to has no document yet – it's empty, not lost)
        if (doc) noteToMarkdown(doc)
        out.readable++
      } catch {
        unreadable.push(n.title || 'Untitled')
      }
    })
    if (unreadable.length) out.problems.push(`${unreadable.length} note${unreadable.length === 1 ? '' : 's'} couldn’t be read: ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? '…' : ''}`)
    // every attachment it names, in the backup's own file store
    const blobs = path.join(config.backupDir, 'blobs')
    for (const { id } of db.prepare('SELECT id FROM attachments').all() as { id: string }[]) {
      out.attachments++
      if (!fs.existsSync(path.join(blobs, id.slice(-2), id))) out.missingAttachments++
    }
    if (out.missingAttachments) out.problems.push(`${out.missingAttachments} attachment${out.missingAttachments === 1 ? ' is' : 's are'} missing from the backup.`)
    // the Markdown copy, readable without ReconNotes
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { notes?: number }
      const written = countFiles(path.join(dir, 'markdown'), '.md')
      if ((manifest.notes ?? 0) > written) out.problems.push(`The Markdown copy has ${written} of ${manifest.notes} notes.`)
    } catch {
      out.problems.push('The backup’s manifest is missing.')
    }
  } catch (err) {
    out.problems.push(`The backup couldn’t be opened: ${(err as Error).message}`)
  } finally {
    db?.close()
  }
  return done()
}

function countFiles(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name), ext)
    else if (e.name.endsWith(ext)) n++
  }
  return n
}

/** Check by itself when the last check is a month old, or found something wrong (after a backup is made). */
export function checkIfDue(config: Config, store: Store) {
  const last = lastBackupCheck(store)
  if (last?.ok && Date.now() - last.at < CHECK_EVERY_DAYS * 24 * 3600_000) return
  try {
    checkBackup(config, store)
  } catch (err) {
    log.warn(`backup check failed: ${(err as Error).message}`)
  }
}
