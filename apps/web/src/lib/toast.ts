import { Store, useStore } from './store'

/** A short message at the bottom of the screen, optionally with an Undo button. */
export interface Toast {
  id: number
  text: string
  undo?: () => void
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

export function dismissToast() {
  toasts.set({ current: null })
}
