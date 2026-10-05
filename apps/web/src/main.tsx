import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { syncScribbleSetting } from './lib/deviceOcr'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

syncScribbleSetting()
pinToViewport()

/**
 * Keep the app exactly the size of the visible area: when the on-screen
 * keyboard opens, the app shrinks above it (the note scrolls inside) instead
 * of iOS sliding the whole page – and the toolbars – up out of view.
 */
function pinToViewport() {
  const vv = window.visualViewport
  const apply = () => {
    // not while pinch-zoomed: then the visible area is smaller on purpose
    if (vv && Math.abs(vv.scale - 1) < 0.01) document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
  }
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('scroll', apply, { passive: true })
  window.addEventListener('orientationchange', () => setTimeout(apply, 300))
  apply()
}

// Offline support: cache the app shell so it opens with no connection.
if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol !== 'capacitor:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker registration failed', err))
  })
}
