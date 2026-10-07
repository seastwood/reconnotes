import type { Stroke } from '@reconnotes/core'
import { Store, useStore } from '../lib/store'

/**
 * Handwriting copied or cut with the lasso, to paste into this drawing or
 * another one (in any note). Kept while the app is open.
 */
export const inkClipboard = new Store<{ strokes: Stroke[]; from: string | null }>({ strokes: [], from: null })
export const useInkClipboard = () => useStore(inkClipboard, (s) => s.strokes.length)
