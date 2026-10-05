import { Store, useStore } from './store'

/** Is the on-screen keyboard showing (set from the visible area's size in main.tsx)? */
export const keyboard = new Store<{ open: boolean }>({ open: false })
export const useKeyboardOpen = () => useStore(keyboard, (s) => s.open)

/** Close the on-screen keyboard: take focus away from whatever is being typed in. */
export function hideKeyboard() {
  const el = document.activeElement as HTMLElement | null
  el?.blur()
  window.getSelection()?.removeAllRanges()
}
