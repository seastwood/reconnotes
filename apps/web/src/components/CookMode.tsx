import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ListChecks, X } from 'lucide-react'

/**
 * Cook mode: a recipe's steps one at a time, in big text – Next and Back (or
 * swipe, or the arrow keys), the ingredients a tap away – with the screen kept
 * on while it's open.
 */
export function CookMode({ title, steps, ingredients, onClose }: { title: string; steps: string[]; ingredients: string[]; onClose: () => void }) {
  const [at, setAt] = useState(0)
  const [showIngredients, setShowIngredients] = useState(false)
  const go = (d: number) => setAt((i) => Math.max(0, Math.min(steps.length - 1, i + d)))

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === ' ') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // a swipe: next or back
  const touch = useRef<{ x: number; y: number } | null>(null)

  return createPortal(
    <div
      className="cook-mode"
      role="dialog"
      aria-label={`Cook mode: ${title}`}
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const s = touch.current
        touch.current = null
        if (!s) return
        const dx = e.changedTouches[0].clientX - s.x
        const dy = e.changedTouches[0].clientY - s.y
        if (Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6) go(dx < 0 ? 1 : -1)
      }}
    >
      <header className="cook-head">
        <button className="icon" onClick={onClose} aria-label="Close cook mode">
          <X size={22} />
        </button>
        <div className="cook-title">{title}</div>
        <button className={`text${showIngredients ? ' on' : ''}`} onClick={() => setShowIngredients((v) => !v)} aria-pressed={showIngredients}>
          <ListChecks size={18} /> Ingredients
        </button>
      </header>
      {showIngredients ? (
        <ul className="cook-ingredients">
          {ingredients.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
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
    </div>,
    document.body,
  )
}
