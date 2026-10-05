import { ChevronDown, Keyboard } from 'lucide-react'
import { hideKeyboard, useKeyboardOpen } from '../lib/keyboard'

/**
 * iPhone / iPad: a small button just above the on-screen keyboard that puts
 * it away (the app hides iOS's own bar with the ✓, which took a lot of room).
 */
export function HideKeyboardButton() {
  const open = useKeyboardOpen()
  if (!open) return null
  return (
    <button
      className="hide-keyboard"
      // don't take focus first: that would move the cursor or close the keyboard half-way
      onPointerDown={(e) => e.preventDefault()}
      onClick={hideKeyboard}
      aria-label="Hide keyboard"
      title="Hide keyboard"
    >
      <Keyboard size={17} />
      <ChevronDown size={14} />
    </button>
  )
}
