import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { syncScribbleSetting } from './lib/deviceOcr'
import { handleConnectHash } from './lib/connectLink'
import { startOfflineFolders } from './lib/offline'
import { startJobs } from './lib/jobs'
import { keyboard } from './lib/keyboard'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

syncScribbleSetting()
handleConnectHash()
startOfflineFolders()
startJobs()
pinToViewport()
stopSidewaysScroll()
keepCaretAboveKeyboard()

/**
 * Moving the cursor in a field (e.g. dragging on the space bar) makes iOS
 * scroll whatever is around the field to keep the cursor in view – even
 * panels that are never meant to scroll sideways, which then stay shifted.
 * Put those straight back.
 */
function stopSidewaysScroll() {
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target
      if (el === document || el === document.documentElement || el === document.body) {
        if (window.scrollX) window.scrollTo(0, window.scrollY)
        return
      }
      if (!(el instanceof HTMLElement) || !el.scrollLeft) return
      const x = getComputedStyle(el).overflowX
      if (x !== 'auto' && x !== 'scroll') el.scrollLeft = 0
    },
    { capture: true, passive: true },
  )
}

/**
 * Keep the app exactly the size of the visible area: when the on-screen
 * keyboard opens, the app shrinks above it (the note scrolls inside) instead
 * of iOS sliding the whole page – and the toolbars – up out of view.
 */
function pinToViewport() {
  const vv = window.visualViewport
  /** the tallest the visible area has been at this width (keyboard closed) */
  const full = new Map<number, number>()
  const apply = () => {
    // not while pinch-zoomed: then the visible area is smaller on purpose
    if (vv && Math.abs(vv.scale - 1) < 0.01) {
      document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
      // iOS may also slide the visible area down the page as the keyboard
      // opens (and leave it there): keep the app on the visible area
      document.documentElement.style.setProperty('--app-top', `${Math.max(0, Math.round(vv.offsetTop))}px`)
      // the keyboard covers the home-indicator area, so bottom toolbars
      // shouldn't keep their safe-area gap above it
      const tallest = Math.max(full.get(window.innerWidth) ?? 0, vv.height, window.innerHeight)
      full.set(window.innerWidth, tallest)
      const open = tallest - vv.height > 150
      document.documentElement.classList.toggle('keyboard-open', open)
      if (keyboard.get().open !== open) keyboard.set({ open })
    }
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
  }
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('scroll', apply, { passive: true })
  window.addEventListener('orientationchange', () => setTimeout(apply, 300))
  // iOS also scrolls the app's fixed frames (which have no scroll bar, so
  // they could never be scrolled back) to show a focused text box: undo it
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !el.scrollTop) return
      const y = getComputedStyle(el).overflowY
      if (y === 'hidden' || y === 'clip') el.scrollTop = 0
    },
    { capture: true, passive: true },
  )
  document.addEventListener('focusout', () => setTimeout(apply, 50))
  // a text box low in a list ("Add a to-do" under the calendar): once the keyboard is up (and the
  // app has shrunk above it), its list scrolls just enough to show it
  document.addEventListener('focusin', (e) => {
    const el = e.target
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.type === 'checkbox' || el.type === 'date') return
    const show = () => {
      if (!el.isConnected || document.activeElement !== el) return
      const r = el.getBoundingClientRect()
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight
      if (r.bottom > bottom - 8 || r.top < 0) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    setTimeout(show, 350)
    setTimeout(show, 750)
  })
  apply()
}

/**
 * Typing in a note low on the screen: once the keyboard is up (and the app has shrunk above it),
 * the line being typed on is scrolled up into view. iOS would do it by scrolling the page, which
 * the app undoes (above) – so the note's own scroll area does it instead, here.
 */
function keepCaretAboveKeyboard() {
  const vv = window.visualViewport
  let timer: ReturnType<typeof setTimeout> | undefined
  const scroller = (el: HTMLElement | null): HTMLElement | null => {
    for (let p = el; p; p = p.parentElement) {
      const y = getComputedStyle(p).overflowY
      if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p
    }
    return null
  }
  const check = () => {
    const el = document.activeElement
    if (!keyboard.get().open || !(el instanceof HTMLElement) || !el.isContentEditable) return
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const at = sel.getRangeAt(0).cloneRange()
    at.collapse(false)
    let r: DOMRect | undefined = at.getClientRects()[0] ?? at.getBoundingClientRect()
    // an empty line has no text to measure: its block instead
    if (!r || (!r.height && !r.top)) {
      const n = sel.focusNode
      r = (n instanceof Element ? n : n?.parentElement)?.getBoundingClientRect()
    }
    if (!r) return
    const bottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 28
    if (r.bottom <= bottom) return
    const box = scroller(el)
    box?.scrollBy({ top: r.bottom - bottom + 48, behavior: 'smooth' })
  }
  const soon = (ms = 60) => {
    clearTimeout(timer)
    timer = setTimeout(check, ms)
  }
  // the keyboard has just come up (the app shrinks a moment later), the cursor moved, or a new line
  keyboard.subscribe(() => {
    if (!keyboard.get().open) return
    soon(120)
    setTimeout(check, 450)
  })
  vv?.addEventListener('resize', () => soon(80))
  document.addEventListener('selectionchange', () => soon())
}

// Offline support: cache the app shell so it opens with no connection.
if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol !== 'capacitor:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker registration failed', err))
  })
}
