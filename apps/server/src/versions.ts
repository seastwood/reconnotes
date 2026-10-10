import * as Y from 'yjs'
import { extractNote, getContent } from '@reconnotes/core'
import type { Store, VersionRow } from './store'

/**
 * Version history
 * ===============
 *
 * The server keeps snapshots of every note as it changes: at most one every
 * 10 minutes while someone edits. Older ones are thinned out – everything
 * from the last day, one per hour for a week, one per day for 90 days.
 */

const EVERY_MS = 10 * 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const KEEP_DAYS = 90

/** Remember the latest snapshot time per note, so most stores cost nothing. */
const lastSnapshot = new Map<string, { at: number; text: string }>()

function summary(doc: Y.Doc) {
  const ex = extractNote(doc)
  // what makes two versions different: text plus how much ink there is
  let ink = 0
  for (const key of doc.share.keys()) if (key.startsWith('ink:')) ink += doc.getArray(key).length
  return { title: ex.title, chars: ex.text.length, fingerprint: `${ex.text}\u0000${ink}\u0000${getContent(doc).length}` }
}

/** Called after a note is saved: take a snapshot if it's due and the note changed. */
export function maybeSnapshot(store: Store, docName: string, doc: Y.Doc, now = Date.now()) {
  let last = lastSnapshot.get(docName)
  if (!last) {
    const newest = store.listVersions(docName)[0]
    if (newest) {
      const state = store.getVersionState(docName, newest.id)
      const old = new Y.Doc()
      if (state) Y.applyUpdate(old, state)
      last = { at: newest.createdAt, text: summary(old).fingerprint }
    }
  }
  if (last && now - last.at < EVERY_MS) return
  const s = summary(doc)
  if (!s.chars && !getContent(doc).length) return // nothing written yet
  if (last && last.text === s.fingerprint) return // unchanged
  store.addVersion(docName, { createdAt: now, title: s.title, chars: s.chars, state: Y.encodeStateAsUpdate(doc) })
  lastSnapshot.set(docName, { at: now, text: s.fingerprint })
  prune(store, docName, now)
}

/** Snapshot right now, whatever the timing (e.g. just before a restore). */
/** Keep the note as it is now in its history (labelled); returns the version's id. */
export function snapshotNow(store: Store, docName: string, doc: Y.Doc, label: string, now = Date.now()): number {
  const s = summary(doc)
  const id = store.addVersion(docName, { createdAt: now, title: s.title, chars: s.chars, label, state: Y.encodeStateAsUpdate(doc) })
  lastSnapshot.set(docName, { at: now, text: s.fingerprint })
  return id
}

/** Thin out old snapshots: all from the last day, hourly for a week, daily for 90 days. */
export function prune(store: Store, docName: string, now = Date.now()) {
  const drop: number[] = []
  const seen = new Set<string>()
  for (const v of store.listVersions(docName)) {
    const age = now - v.createdAt
    if (age > KEEP_DAYS * DAY) {
      drop.push(v.id)
      continue
    }
    if (age <= DAY || v.label) continue
    const bucket = age <= 7 * DAY ? `h${Math.floor(v.createdAt / HOUR)}` : `d${Math.floor(v.createdAt / DAY)}`
    if (seen.has(bucket)) drop.push(v.id) // newest first, so the first in each bucket stays
    else seen.add(bucket)
  }
  if (drop.length) store.deleteVersions(drop)
}

export function loadVersion(store: Store, docName: string, id: number): Y.Doc | null {
  const state = store.getVersionState(docName, id)
  if (!state) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

export type { VersionRow }
