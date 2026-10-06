import { Maximize2, Minimize2 } from 'lucide-react'

/** iPad / computer: widen the notes / Jobs column over the note area, and back. */
export function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      className={`icon expand-col${expanded ? ' on' : ''}`}
      onClick={onToggle}
      aria-label={expanded ? 'Back to the usual width' : 'Widen this column'}
      title={expanded ? 'Back to the usual width' : 'Widen this column over the note'}
    >
      {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
    </button>
  )
}
