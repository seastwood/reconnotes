import { ArrowDown, ArrowUp, Check } from 'lucide-react'
import type { SortMode } from '@reconnotes/core'

export const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Manual (drag to reorder)',
  title: 'Title',
  created: 'Date created',
  updated: 'Date edited',
}

/** which way an order runs, in words */
export const sortDirection = (mode: SortMode, reverse: boolean) =>
  mode === 'manual' ? '' : mode === 'title' ? (reverse ? 'Z to A' : 'A to Z') : reverse ? 'Oldest first' : 'Newest first'

/**
 * The "Sort by" choices in a menu. The chosen one shows which way it runs (an arrow:
 * down – newest first, A to Z; up – the other way); choosing it again turns it around.
 */
export function SortChoices({
  sort,
  reverse,
  onChange,
  manual = true,
}: {
  sort: SortMode
  reverse: boolean
  onChange: (sort: SortMode, reverse: boolean) => void
  /** offer manual order (drag to reorder) */
  manual?: boolean
}) {
  return (
    <>
      {(Object.keys(SORT_LABELS) as SortMode[])
        .filter((m) => m !== 'manual' || manual)
        .map((m) => {
          const on = sort === m
          const turnable = m !== 'manual'
          return (
            <button
              key={m}
              className={on ? 'sort-on' : ''}
              onClick={() => onChange(m, on && turnable ? !reverse : false)}
              title={on && turnable ? `${sortDirection(m, reverse)} – choose again for ${sortDirection(m, !reverse).toLowerCase()}` : undefined}
              aria-pressed={on}
            >
              {SORT_LABELS[m]}
              {on && (
                <span className="sort-dir">
                  {turnable && <small>{sortDirection(m, reverse)}</small>}
                  {!turnable ? <Check size={15} /> : reverse ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
                </span>
              )}
            </button>
          )
        })}
    </>
  )
}
