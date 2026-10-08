import { StrictMode } from 'react'
import { Capacitor } from '@capacitor/core'
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
  // Safari in a browser tab (not the app, not on the Home Screen): with the
  // keyboard down the app runs on under Safari's see-through toolbar, as
  // pages do in iOS 26, with room left below so nothing ends up under it
  const glass = isSafariTab()
  document.documentElement.classList.toggle('glass', glass)
  const probe = glass ? document.createElement('div') : null
  if (probe) {
    probe.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:100lvh;visibility:hidden;pointer-events:none'
    document.documentElement.appendChild(probe)
  }
  const apply = () => {
    // not while pinch-zoomed: then the visible area is smaller on purpose
    if (vv && Math.abs(vv.scale - 1) < 0.01) {
      // the keyboard covers the home-indicator area, so bottom toolbars
      // shouldn't keep their safe-area gap above it
      const tallest = Math.max(full.get(window.innerWidth) ?? 0, vv.height, window.innerHeight)
      full.set(window.innerWidth, tallest)
      const open = tallest - vv.height > 150
      document.documentElement.classList.toggle('keyboard-open', open)
      if (keyboard.get().open !== open) keyboard.set({ open })
      // the screen below the visible area: Safari's toolbar (none when the keyboard is up)
      const large = probe?.offsetHeight ?? 0
      const gap = !open && large > vv.height && large - vv.height < 240 ? Math.round(large - vv.height) : 0
      document.documentElement.style.setProperty('--bar-gap', `${gap}px`)
      document.documentElement.style.setProperty('--app-height', `${Math.round(gap ? large : vv.height)}px`)
      // iOS may also slide the visible area down the page as the keyboard
      // opens (and leave it there): keep the app on the visible area
      document.documentElement.style.setProperty('--app-top', `${gap ? 0 : Math.max(0, Math.round(vv.offsetTop))}px`)
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
  apply()
}

// Offline support: cache the app shell so it opens with no connection.
if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol !== 'capacitor:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker registration failed', err))
  })
}

/** Safari (or another iOS browser) in a tab: it has a toolbar over the page's bottom edge. */
function isSafariTab() {
  if (Capacitor.isNativePlatform()) return false
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const homeScreen = (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches
  return ios && !homeScreen
}
