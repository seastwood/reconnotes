import { useMemo } from 'react'
import { Folder, Inbox, X } from 'lucide-react'
import { buildTree, descendantFolderIds, moveFolder, moveNote, type TreeNode } from '@reconnotes/core'
import { useWorkspace, workspaceDoc } from '../lib/workspace'

/** Pick a destination folder (touch-friendly alternative to drag and drop). */
export function MoveDialog({ target, onClose }: { target: { kind: 'note' | 'folder'; id: string }; onClose: () => void }) {
  const ws = useWorkspace()
  const tree = useMemo(() => buildTree(ws.folders, ws.rootSort), [ws.folders, ws.rootSort])
  const blocked = useMemo(
    () => (target.kind === 'folder' ? descendantFolderIds(ws.folders, target.id) : new Set<string>()),
    [ws.folders, target],
  )
  const choose = (folderId: string | null) => {
    if (target.kind === 'note') moveNote(workspaceDoc, target.id, folderId)
    else moveFolder(workspaceDoc, target.id, folderId)
    onClose()
  }
  const render = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.folder.id}>
        <button className="move-row" style={{ paddingLeft: 12 + depth * 18 }} disabled={blocked.has(n.folder.id)} onClick={() => choose(n.folder.id)}>
          <Folder size={16} /> {n.folder.name}
        </button>
        {render(n.children, depth + 1)}
      </div>
    ))
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Move {target.kind} to…</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <div className="move-list">
          <button className="move-row" onClick={() => choose(null)}>
            <Inbox size={16} /> {target.kind === 'note' ? 'No folder' : 'Top level'}
          </button>
          {render(tree, 0)}
        </div>
      </div>
    </div>
  )
}
