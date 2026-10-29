import { safeLocalGet, safeLocalSet } from '../lib/store'

/**
 * Wider or narrower folders and notes columns
 * ===========================================
 *
 * On a computer (or an iPad with a trackpad) the folders and notes columns
 * have a handle on their right edge: drag it to make the column wider or
 * narrower, double-click it to go back to the usual width. Each width is
 * kept on this device.
 */

export type ColumnVar = '--sidebar-w' | '--list-w'
const KEY = 'reconnotes.columnWidths'
const LIMITS: Record<ColumnVar, [number, number]> = { '--sidebar-w': [180, 480], '--list-w': [220, 720] }
/** the note always keeps this much room */
const NOTE_MIN = 380

/** The widths set by dragging, as CSS variables for the app (none: the usual widths). */
export function savedColumnWidths(): React.CSSProperties {
  const saved = safeLocalGet<Partial<Record<ColumnVar, number>>>(KEY, {})
  return Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, `${v}px`])) as React.CSSProperties
}

export function ColumnResizer({ name, label }: { name: ColumnVar; label: string }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    e.preventDefault()
    e.stopPropagation()
    const app = e.currentTarget.closest('.app') as HTMLElement | null
    const col = e.currentTarget.parentElement
    if (!app || !col) return
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = col.getBoundingClientRect().width
    // the note keeps its room: what the other columns and the chat take is left alone
    const others = [...app.querySelectorAll<HTMLElement>('.panel-sidebar, .panel-list, .ask-dock')].filter((x) => !x.contains(col)).reduce((w, x) => w + x.getBoundingClientRect().width, 0)
    const [lo, hi] = LIMITS[name]
    const max = Math.max(lo, Math.min(hi, app.clientWidth - others - NOTE_MIN))
    let w = startW
    document.body.classList.add('col-resizing')
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.max(lo, Math.min(max, startW + ev.clientX - startX)))
      app.style.setProperty(name, `${w}px`)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('col-resizing')
      safeLocalSet(KEY, { ...safeLocalGet<Partial<Record<ColumnVar, number>>>(KEY, {}), [name]: w })
      window.dispatchEvent(new Event('resize'))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  // back to the usual width
  const reset = (e: React.MouseEvent<HTMLDivElement>) => {
    const app = e.currentTarget.closest('.app') as HTMLElement | null
    app?.style.removeProperty(name)
    const saved = { ...safeLocalGet<Partial<Record<ColumnVar, number>>>(KEY, {}) }
    delete saved[name]
    safeLocalSet(KEY, saved)
    window.dispatchEvent(new Event('resize'))
  }
  return <div className="col-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${label}`} title="Drag to resize · double-click for the usual width" onPointerDown={start} onDoubleClick={reset} />
}
