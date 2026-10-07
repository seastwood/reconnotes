import * as Y from 'yjs'
import { createFolder, createNote, getContent, getFolders, getNotes, getSettings, noteDocName, readFolder, readNote } from '@reconnotes/core'
import { isSyncConfigured } from './settings'
import { sync } from './sync'
import { workspaceDoc } from './workspace'

/**
 * Daily note
 * ==========
 *
 * "Today" opens today's note (in a "Daily notes" folder), making it the first
 * time: the date as its title, a to-do list – with the to-dos you didn't tick
 * off in the last daily note carried over – and a place for notes. On every
 * device, the same note for the same day.
 */

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const settings = () => getSettings(workspaceDoc)
const dailyMap = () => ({ ...((settings().get('dailyNotes') as Record<string, string> | undefined) ?? {}) })

const liveNote = (id: string | undefined) => {
  const m = id ? getNotes(workspaceDoc).get(id) : null
  return Boolean(m && !readNote(m).trashedAt)
}

function dailyFolder(): string {
  const folders = getFolders(workspaceDoc)
  const saved = settings().get('dailyFolder') as string | undefined
  const ok = (id: string) => {
    const m = folders.get(id)
    return Boolean(m && !readFolder(m).trashedAt)
  }
  if (saved && ok(saved)) return saved
  for (const [id, m] of folders) {
    const f = readFolder(m)
    if (!f.trashedAt && !f.parentId && f.name.toLowerCase() === 'daily notes') {
      settings().set('dailyFolder', id)
      return id
    }
  }
  const id = createFolder(workspaceDoc, { name: 'Daily notes' })
  settings().set('dailyFolder', id)
  return id
}

const block = (name: string, children: (Y.XmlElement | Y.XmlText)[] = [], attrs: Record<string, unknown> = {}) => {
  const el = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string)
  if (children.length) el.insert(0, children)
  return el
}
const text = (t: string) => new Y.XmlText(t)

/** The unticked to-dos of an earlier daily note (copies). */
async function openTodos(noteId: string): Promise<Y.XmlElement[]> {
  const { handle, close } = sync.open(noteDocName(noteId))
  try {
    await handle.loaded
    // the copy on this device may be behind (or not here yet): get the server's, for a few seconds
    for (let i = 0; i < 50 && isSyncConfigured() && !handle.synced; i++) await new Promise((r) => setTimeout(r, 100))
    const out: Y.XmlElement[] = []
    const walk = (el: Y.XmlElement | Y.XmlFragment) => {
      for (const c of el.toArray()) {
        if (!(c instanceof Y.XmlElement)) continue
        if (c.nodeName === 'taskItem') {
          const checked = c.getAttribute('checked') as unknown
          const empty = !c.toString().replace(/<[^>]+>/g, '').trim()
          if (checked !== true && checked !== 'true' && !empty) out.push(c.clone() as Y.XmlElement)
        } else walk(c)
      }
    }
    walk(getContent(handle.doc))
    return out
  } finally {
    close()
  }
}

/** Today's daily note (made now if there isn't one). Returns its id. */
export async function openDailyNote(): Promise<string> {
  const today = dayKey()
  const map = dailyMap()
  if (liveNote(map[today])) return map[today]
  const title = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const id = createNote(workspaceDoc, { folderId: dailyFolder(), title })
  settings().set('dailyNotes', { ...map, [today]: id })
  // the latest earlier daily note's unfinished to-dos
  const earlier = Object.keys(map)
    .filter((d) => d < today && liveNote(map[d]))
    .sort()
    .at(-1)
  const carried = earlier ? await openTodos(map[earlier]).catch(() => []) : []
  const { handle, close } = sync.open(noteDocName(id))
  await handle.loaded
  handle.doc.transact(() => {
    getContent(handle.doc).insert(0, [
      block('heading', [text(title)], { level: 1 }),
      block('heading', [text('To do')], { level: 2 }),
      block('taskList', carried.length ? carried : [block('taskItem', [block('paragraph')], { checked: false })]),
      block('heading', [text('Notes')], { level: 2 }),
      block('paragraph'),
    ])
  })
  setTimeout(close, 3000)
  return id
}
