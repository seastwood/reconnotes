import { Check } from 'lucide-react'

interface Props {
  id: string
  className: string
  selecting: boolean
  selected: boolean
  draggable: boolean
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
  liProps?: React.LiHTMLAttributes<HTMLLIElement>
}

/**
 * A note in the list. Pin, move and delete are in its ⋯ menu – a sideways swipe on the list moves
 * the panels, not the row. In select mode it shows a tick circle.
 */
export function NoteRow({ className, selecting, selected, draggable, onClick, children, liProps }: Props) {
  return (
    <li {...liProps} className={`${className} swipe-row${selected ? ' selected' : ''}`} draggable={draggable} onClick={onClick}>
      <div className="swipe-content">
        {selecting && (
          <span className={`select-tick${selected ? ' on' : ''}`} aria-hidden="true">
            {selected && <Check size={13} strokeWidth={3} />}
          </span>
        )}
        <div className="swipe-body">{children}</div>
      </div>
    </li>
  )
}
