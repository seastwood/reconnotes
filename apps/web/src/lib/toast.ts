import { Store, useStore } from './store'

/** A short message at the bottom of the screen, optionally with an Undo button. */
export interface Toast {
  id: number
  text: string
  undo?: () => void
  /** another button instead of Undo, e.g. "Open" */
  action?: { label: string; run: () => void }
}

export const toasts = new Store<{ current: Toast | null }>({ current: null })
export const useToast = () => useStore(toasts, (s) => s.current)

let next = 1
let timer: ReturnType<typeof setTimeout> | null = null

export function showToast(text: string, undo?: () => void, ms = 6000) {
  if (timer) clearTimeout(timer)
  const t = { id: next++, text, undo }
  toasts.set({ current: t })
  timer = setTimeout(() => {
    if (toasts.get().current?.id === t.id) toasts.set({ current: null })
  }, ms)
}

/** A message with a button that does something (not Undo). */
export function showActionToast(text: string, label: string, run: () => void, ms = 8000) {
  showToast(text, undefined, ms)
  const cur = toasts.get().current
  if (cur) toasts.set({ current: { ...cur, action: { label, run } } })
}

export function dismissToast() {
  toasts.set({ current: null })
}
