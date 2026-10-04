import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Emit a small service worker that precaches the built app shell, so the web
 * app (and "Add to Home Screen" install) opens instantly with no network.
 * Note data itself lives in IndexedDB, not in this cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'reconnotes-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'))
      const assets = ['/', ...files.map((f) => '/' + f), '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-512.png']
      const version = createHash('sha1').update(assets.join()).digest('hex').slice(0, 10)
      const source = `// generated at build time
const CACHE = 'reconnotes-${version}'
const ASSETS = ${JSON.stringify(assets)}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sync') return
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')))
    return
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
})
`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
})
