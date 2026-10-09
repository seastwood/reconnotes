import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { openExternal, openableUrl } from '../lib/appLinks'
import { playListenLink } from '../lib/replay'
import { showToast } from '../lib/toast'

/**
 * Tap or click a link in a note to open it (Safari / a new tab). A drag that
 * selects text, or a long press for the menu, doesn't open it; neither does
 * a tap with Shift (to put the cursor there and edit the link's text).
 */
export const LinkOpener = Extension.create({
  name: 'linkOpener',
  addProseMirrorPlugins() {
    let down: { x: number; y: number; t: number; href: string } | null = null
    const linkAt = (target: EventTarget | null) => {
      const a = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || !a.closest('.ProseMirror')) return null
      const href = a.getAttribute('href') ?? ''
      // a meeting note's ▶ link: plays its recording from there
      return href.startsWith('listen:') ? href : openableUrl(href)
    }
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            pointerdown: (_view, e) => {
              const href = e.button === 0 && !e.shiftKey ? linkAt(e.target) : null
              down = href ? { x: e.clientX, y: e.clientY, t: Date.now(), href } : null
              return false
            },
            pointerup: (_view, e) => {
              const d = down
              down = null
              if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || Date.now() - d.t > 600) return false
              if (linkAt(e.target) !== d.href) return false
              if (!playListenLink(d.href, showToast)) openExternal(d.href)
              return false
            },
            // the browser's own link following stays off (it would replace the app)
            click: (_view, e) => {
              if (linkAt(e.target)) e.preventDefault()
              return false
            },
          },
        },
      }),
    ]
  },
})
