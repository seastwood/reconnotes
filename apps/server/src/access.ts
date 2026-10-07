import { WORKSPACE_DOC, effectiveFolderId, folderRules, listFolders } from '@reconnotes/core'
import type { SyncEngine } from './sync'

/**
 * Which notes a search or "Ask your notes" may use
 * ================================================
 *
 * - Notes in a password-protected folder only when the asking device has
 *   unlocked it (it says which).
 * - Notes in folders left out of search only when that folder is searched on
 *   purpose (`folders`).
 * - With `folders`, only notes in those folders and their subfolders
 *   ('none' = notes in no folder).
 */
export interface Scope {
  folders?: string[] | null
  unlocked?: string[]
  /** only these notes ("Ask about this note") */
  notes?: string[]
}

export function noteFilter(sync: SyncEngine, scope: Scope = {}): (noteId: string) => boolean {
  const ws = sync.getDoc(WORKSPACE_DOC)
  const folders = ws ? listFolders(ws) : []
  const rules = folderRules(folders)
  const live = new Set(rules.keys())
  const meta = sync.noteMeta()
  const unlocked = new Set(scope.unlocked ?? [])
  const only = scope.notes?.length ? new Set(scope.notes) : null
  let inScope: Set<string> | null = null
  if (scope.folders?.length) {
    inScope = new Set(scope.folders)
    // and their subfolders
    let grew = true
    while (grew) {
      grew = false
      for (const f of folders) if (!f.trashedAt && f.parentId && inScope.has(f.parentId) && !inScope.has(f.id)) (inScope.add(f.id), (grew = true))
    }
  }
  return (noteId) => {
    const n = meta.get(noteId)
    if (!n) return false
    const f = effectiveFolderId(n, live)
    const rule = f ? rules.get(f) : undefined
    if (rule?.lockedBy && !unlocked.has(rule.lockedBy)) return false
    if (only) return only.has(noteId)
    if (inScope) return inScope.has(f ?? 'none')
    return !rule?.noSearch
  }
}

/** The scope from a search's query string: ?folders=a,b&unlocked=c */
export function scopeFromQuery(params: URLSearchParams): Scope {
  const list = (k: string) => (params.get(k) ?? '').split(',').filter((id) => /^([a-z0-9]{8,64}|none)$/.test(id))
  return { folders: list('folders'), unlocked: list('unlocked') }
}

export function scopeFromInput(input: Record<string, unknown>): Scope {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((id) => /^([a-z0-9]{8,64}|none)$/.test(id)) : [])
  return { folders: list(input.folders), unlocked: list(input.unlocked), notes: list(input.notes).filter((id) => id !== 'none') }
}
