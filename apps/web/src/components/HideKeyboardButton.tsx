import { ChevronDown, Keyboard } from 'lucide-react'
import { hideKeyboard, useKeyboardOpen } from '../lib/keyboard'
import { askChat } from '../lib/askChat'
import { useStore } from '../lib/store'

/**
 * iPhone / iPad: a small button just above the on-screen keyboard that puts
 * it away (the app hides iOS's own bar with the ✓, which took a lot of room).
 */
export function HideKeyboardButton() {
  const open = useKeyboardOpen()
  // not over the Ask chat: its send button is there (and sending puts the keyboard away)
  const chatting = useStore(askChat, (s) => Boolean(s.target && !s.hidden))
  if (!open || chatting) return null
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
