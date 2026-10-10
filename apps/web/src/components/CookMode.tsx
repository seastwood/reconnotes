import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, LayoutGrid, ListChecks, Square, X } from 'lucide-react'
import { safeLocalGet, safeLocalSet } from '../lib/store'

type View = 'step' | 'board'
const VIEW = 'reconnotes.cookView'

/**
 * Cook mode, two ways (the screen kept on while it's open):
 *
 * - One step: the steps one at a time, big – Next and Back (or swipe, or the
 *   arrow keys), the ingredients a tap away.
 * - All steps (the default on a bigger screen, like a recipe card from a meal
 *   kit): the ingredients down the side, ticked off as they go in, and every
 *   step a numbered tile, in rows – scroll for more; tap one to see it big.
 */
export function CookMode({ title, steps, ingredients, onClose }: { title: string; steps: string[]; ingredients: string[]; onClose: () => void }) {
  const [view, setViewState] = useState<View>(() => safeLocalGet<View | null>(VIEW, null) ?? (window.innerWidth >= 900 ? 'board' : 'step'))
  const setView = (v: View) => (setViewState(v), safeLocalSet(VIEW, v))
  const [at, setAt] = useState(0)
  /** All steps: the step shown big (null: none) */
  const [zoom, setZoom] = useState<number | null>(null)
  const [showIngredients, setShowIngredients] = useState(false)
  // what's done: ingredients in, steps finished (for while you cook; not saved)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [done, setDone] = useState<Set<number>>(new Set())
  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  }
  const clamp = (i: number) => Math.max(0, Math.min(steps.length - 1, i))
  const go = (d: number) => setAt((i) => clamp(i + d))

  // the screen stays on (where the browser can keep it on), again when you come back to the app
  useEffect(() => {
    type Lock = { release: () => Promise<void> }
    const wake = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock
    let lock: Lock | null = null
    const take = () => void wake?.request('screen').then((l) => (lock = l)).catch(() => {})
    take()
    const onVisible = () => document.visibilityState === 'visible' && take()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => {})
    }
  }, [])
  const keys = useRef({ view, zoom })
  keys.current = { view, zoom }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { view: v, zoom: z } = keys.current
      if (e.key === 'Escape') return z !== null ? setZoom(null) : onClose()
      const d = e.key === 'ArrowRight' || e.key === ' ' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!d) return
      if (v === 'step') go(d)
      else if (z !== null) setZoom(clamp(z + d))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // a swipe: next or back (one step at a time, or the step shown big)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current
    touch.current = null
    if (!s) return
    const dx = e.changedTouches[0].clientX - s.x
    const dy = e.changedTouches[0].clientY - s.y
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return
    if (view === 'step') go(dx < 0 ? 1 : -1)
    else if (zoom !== null) setZoom(clamp(zoom + (dx < 0 ? 1 : -1)))
  }

  const ingredientList = (
    <ul className="cook-check-list">
      {ingredients.map((t, i) => (
        <li key={i}>
          <button className={added.has(i) ? 'in' : ''} onClick={() => setAdded(toggle(added, i))} aria-pressed={added.has(i)}>
            {added.has(i) ? <Check size={18} /> : <Square size={18} />} <span>{t}</span>
          </button>
        </li>
      ))}
    </ul>
  )

  return createPortal(
    <div className={`cook-mode cook-${view}`} role="dialog" aria-label={`Cook mode: ${title}`} onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })} onTouchEnd={onTouchEnd}>
      <header className="cook-head">
        <button className="icon" onClick={onClose} aria-label="Close cook mode">
          <X size={22} />
        </button>
        <div className="cook-title">{title}</div>
        <div className="cook-views" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === 'step'} className={view === 'step' ? 'on' : ''} onClick={() => setView('step')}>
            <ChevronRight size={16} /> One step
          </button>
          <button role="radio" aria-checked={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
            <LayoutGrid size={16} /> All steps
          </button>
        </div>
        {view === 'step' && (
          <button className={`text${showIngredients ? ' on' : ''}`} onClick={() => setShowIngredients((v) => !v)} aria-pressed={showIngredients}>
            <ListChecks size={18} /> Ingredients
          </button>
        )}
      </header>

      {view === 'step' ? (
        <>
          {showIngredients ? (
            <div className="cook-ingredients">{ingredientList}</div>
          ) : (
            <div className="cook-step" aria-live="polite">
              <div className="cook-count">
                Step {at + 1} of {steps.length}
              </div>
              <p>{steps[at]}</p>
            </div>
          )}
          <footer className="cook-nav">
            <button onClick={() => go(-1)} disabled={at === 0}>
              <ChevronLeft size={22} /> Back
            </button>
            <div className="cook-dots" aria-hidden>
              {steps.map((_, i) => (
                <span key={i} className={i === at ? 'on' : ''} />
              ))}
            </div>
            {at < steps.length - 1 ? (
              <button className="primary" onClick={() => go(1)}>
                Next <ChevronRight size={22} />
              </button>
            ) : (
              <button className="primary" onClick={onClose}>
                Done
              </button>
            )}
          </footer>
        </>
      ) : (
        <div className="cook-board">
          <aside className="cook-side">
            <h2>
              Ingredients <span className="cook-side-count">{ingredients.length - added.size} left</span>
            </h2>
            {ingredientList}
          </aside>
          <StepTiles steps={steps} done={done} onToggleDone={(i) => setDone(toggle(done, i))} onOpen={setZoom} />
        </div>
      )}

      {view === 'board' && zoom !== null && (
        <div className="cook-zoom-backdrop" onClick={() => setZoom(null)}>
          <div className="cook-zoom" role="dialog" aria-label={`Step ${zoom + 1}`} onClick={(e) => e.stopPropagation()}>
            <div className="cook-zoom-head">
              <span className="cook-num big">{zoom + 1}</span>
              <span className="cook-count">
                Step {zoom + 1} of {steps.length}
              </span>
              <button className="icon" onClick={() => setZoom(null)} aria-label="Close">
                <X size={22} />
              </button>
            </div>
            <p>{steps[zoom]}</p>
            <footer className="cook-nav">
              <button onClick={() => setZoom(clamp(zoom - 1))} disabled={zoom === 0}>
                <ChevronLeft size={22} /> Back
              </button>
              <button className={done.has(zoom) ? 'on' : ''} onClick={() => setDone(toggle(done, zoom))} aria-pressed={done.has(zoom)}>
                <Check size={20} /> {done.has(zoom) ? 'Done' : 'Mark done'}
              </button>
              {zoom < steps.length - 1 ? (
                <button className="primary" onClick={() => setZoom(zoom + 1)}>
                  Next <ChevronRight size={22} />
                </button>
              ) : (
                <button className="primary" onClick={() => setZoom(null)}>
                  Close
                </button>
              )}
            </footer>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}

/**
 * Every step a tile, reading across (1 2 3, then 4 5 6…), each in the shortest column so far
 * (masonry): as many columns as fit, scrolling down for more.
 */
function StepTiles({ steps, done, onToggleDone, onOpen }: { steps: string[]; done: Set<number>; onToggleDone: (i: number) => void; onOpen: (i: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(2)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setCols(Math.max(1, Math.min(4, Math.floor((el.clientWidth - 16) / 240))))
    fit()
    const watch = new ResizeObserver(fit)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  // each step into the column that's shortest so far (masonry): the numbers still read across, row
  // by row, and a long step doesn't leave a hole under its neighbours
  const width = (box.current?.clientWidth ?? 800) / cols
  const perLine = Math.max(16, Math.floor((width - 40) / 9.5))
  const tall = (t: string) => 64 + Math.ceil(t.length / perLine) * 26
  const columns: number[][] = Array.from({ length: cols }, () => [])
  const heights = Array.from({ length: cols }, () => 0)
  steps.forEach((t, i) => {
    const c = heights.indexOf(Math.min(...heights))
    columns[c].push(i)
    heights[c] += tall(t) + 14
  })
  return (
    <div className="cook-tiles" ref={box}>
      {columns.map((col, c) => (
        <div key={c} className="cook-col">
          {col.map((i) => (
            <div
              key={i}
              className={`cook-tile${done.has(i) ? ' done' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(i)}
              onKeyDown={(e) => (e.key === 'Enter' ? onOpen(i) : undefined)}
              aria-label={`Step ${i + 1}: ${steps[i]}`}
            >
              <div className="cook-tile-head">
                <span className="cook-num">{i + 1}</span>
                <button
                  className={`cook-done${done.has(i) ? ' on' : ''}`}
                  onClick={(e) => (e.stopPropagation(), onToggleDone(i))}
                  aria-label={done.has(i) ? `Step ${i + 1} done – undo` : `Mark step ${i + 1} done`}
                  aria-pressed={done.has(i)}
                >
                  <Check size={16} />
                </button>
              </div>
              <p>{steps[i]}</p>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
