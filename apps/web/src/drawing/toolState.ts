import type { Tool } from '@reconnotes/core'
import { Store, safeLocalGet, safeLocalSet, useStore } from '../lib/store'

export type DrawTool = Tool | 'eraser' | 'lasso'
export type EraserMode = 'object' | 'pixel'

export interface ToolState {
  tool: DrawTool
  /** tool to go back to (Pencil double-tap "switch to previous" / eraser toggle) */
  previousTool: DrawTool
  eraserMode: EraserMode
  colors: Record<Tool, string>
  sizes: Record<Tool, number>
  /** recently used colours, newest first */
  recentColors: string[]
}

export const INK_TOOLS: Tool[] = ['pen', 'pencil', 'marker', 'highlighter']

export const PALETTE = ['#000000', '#5b5b5b', '#1d4ed8', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#c026d3', '#7c3aed']
export const HIGHLIGHT_PALETTE = ['#facc15', '#4ade80', '#38bdf8', '#f472b6', '#fb923c']
export const SIZES = [1.5, 3, 5, 8, 12]

const KEY = 'reconnotes.tools'

export const toolState = new Store<ToolState>(
  safeLocalGet<ToolState>(KEY, {
    tool: 'pen',
    previousTool: 'pen',
    eraserMode: 'object',
    colors: { pen: '#000000', pencil: '#5b5b5b', marker: '#1d4ed8', highlighter: '#facc15' },
    sizes: { pen: 3, pencil: 3, marker: 5, highlighter: 5 },
    recentColors: [],
  }),
)
toolState.subscribe(() => safeLocalSet(KEY, toolState.get()))

export const useTools = <S,>(select: (s: ToolState) => S) => useStore(toolState, select)

export function selectTool(tool: DrawTool) {
  const s = toolState.get()
  if (s.tool === tool) return
  toolState.set({ tool, previousTool: s.tool })
}

/** Apple Pencil double-tap default: toggle between the eraser and the current tool. */
export function toggleEraser() {
  const s = toolState.get()
  if (s.tool === 'eraser') toolState.set({ tool: s.previousTool === 'eraser' ? 'pen' : s.previousTool, previousTool: 'eraser' })
  else toolState.set({ tool: 'eraser', previousTool: s.tool })
}

export function switchToPrevious() {
  const s = toolState.get()
  toolState.set({ tool: s.previousTool, previousTool: s.tool })
}

export function setColor(color: string) {
  const s = toolState.get()
  const tool: Tool = INK_TOOLS.includes(s.tool as Tool) ? (s.tool as Tool) : 'pen'
  toolState.set({
    tool,
    colors: { ...s.colors, [tool]: color },
    recentColors: [color, ...s.recentColors.filter((c) => c !== color)].slice(0, 6),
  })
}

export function setSize(size: number) {
  const s = toolState.get()
  const tool: Tool = INK_TOOLS.includes(s.tool as Tool) ? (s.tool as Tool) : 'pen'
  toolState.set({ sizes: { ...s.sizes, [tool]: size } })
}

/** UI state that should not persist. */
export interface InkUi {
  /** id of the drawing being worked on (shows the ink toolbar) */
  activeDrawing: string | null
  /** quick palette opened by Pencil squeeze / double-tap, in viewport coords */
  palette: { x: number; y: number } | null
  /** last position of a hovering / touching pencil, in viewport coords */
  lastPencil: { x: number; y: number } | null
  /** true once an Apple Pencil has been used: fingers then scroll instead of draw */
  pencilSeen: boolean
}

export const inkUi = new Store<InkUi>({ activeDrawing: null, palette: null, lastPencil: null, pencilSeen: false })
export const useInkUi = <S,>(select: (s: InkUi) => S) => useStore(inkUi, select)
