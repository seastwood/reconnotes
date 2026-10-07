import { useEffect, useRef, useState } from 'react'

const FIRST = 150
const MORE = 300

/**
 * Long lists (thousands of notes) render in pieces: the first rows straight
 * away, more as you scroll near the end – so opening a big folder stays
 * instant. `reset` starts again from the top (a different folder); `keep`
 * is a row index that must be shown (the open note).
 */
export function useProgressive(total: number, reset: unknown, keep = -1): { limit: number; sentinel: (el: HTMLElement | null) => void } {
  const [limit, setLimit] = useState(FIRST)
  const observer = useRef<IntersectionObserver | null>(null)
  useEffect(() => setLimit(FIRST), [reset])
  useEffect(() => {
    if (keep >= limit) setLimit(keep + MORE)
  }, [keep, limit])
  useEffect(() => () => observer.current?.disconnect(), [])
  const sentinel = (el: HTMLElement | null) => {
    observer.current?.disconnect()
    if (!el || typeof IntersectionObserver === 'undefined') return
    observer.current = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLimit((l) => l + MORE), { rootMargin: '600px' })
    observer.current.observe(el)
  }
  return { limit: Math.min(limit, total), sentinel }
}
