import { createContext, useContext, useEffect, useState } from 'react'
import * as Y from 'yjs'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { getContent } from '@reconnotes/core'

/**
 * One undo history per note covering both typed text and ink, so the undo
 * button always reverts the last thing you did, whatever it was.
 *
 * Only local changes are tracked: undo never reverts edits that arrived from
 * another device.
 */
export const DRAW_ORIGIN = { source: 'ink' }

export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  const um = new Y.UndoManager([getContent(doc)], {
    trackedOrigins: new Set<unknown>([ySyncPluginKey, DRAW_ORIGIN]),
    captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
    captureTimeout: 400,
  })
  doc.share.forEach((_type, key) => {
    if (key.startsWith('ink:')) um.addToScope(doc.getArray(key))
  })
  return um
}

export const UndoContext = createContext<Y.UndoManager | null>(null)
export const useUndoManager = () => useContext(UndoContext)

/** Re-render when undo/redo availability changes. */
export function useUndoState(um: Y.UndoManager | null) {
  const [state, setState] = useState({ canUndo: false, canRedo: false })
  useEffect(() => {
    if (!um) return
    const update = () => setState({ canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 })
    update()
    um.on('stack-item-added', update)
    um.on('stack-item-popped', update)
    um.on('stack-cleared', update)
    return () => {
      um.off('stack-item-added', update)
      um.off('stack-item-popped', update)
      um.off('stack-cleared', update)
    }
  }, [um])
  return state
}
