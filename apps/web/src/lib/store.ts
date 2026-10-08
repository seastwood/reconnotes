import { useSyncExternalStore } from 'react'

/** Minimal observable store usable from React via useStore(). */
export class Store<T> {
  private listeners = new Set<() => void>()
  constructor(private state: T) {}
  get = () => this.state
  set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const p = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...p }
    this.listeners.forEach((l) => l())
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

export function useStore<T, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()))
}

export function safeLocalGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    if (!v) return fallback
    const saved = JSON.parse(v) as unknown
    // a list stays a list (spreading one into an object made { 0: …, 1: … })
    if (Array.isArray(fallback)) return (Array.isArray(saved) ? saved : fallback) as T
    // settings objects: saved values over the defaults (new settings get theirs)
    if (fallback && typeof fallback === 'object') return saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...fallback, ...saved } : fallback
    // a plain value: only one of the same kind
    return (typeof saved === typeof fallback ? saved : fallback) as T
  } catch {
    return fallback
  }
}

export function safeLocalSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode) – settings just won't persist */
  }
}
