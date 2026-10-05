import { useEffect, useRef, useState } from 'react'
import { Check, FolderInput, Pin, PinOff, Trash2 } from 'lucide-react'
import { Store, useStore } from '../lib/store'

/** Only one row is swiped open at a time. */
const openRow = new Store<{ id: string | null }>({ id: null })

const ACTIONS = 3 * 68
const EDGE = 28 // the screen edge belongs to the panel swipe

interface Props {
  id: string
  className: string
  pinned: boolean
  selecting: boolean
  selected: boolean
  draggable: boolean
  onClick: (e: React.MouseEvent) => void
  onPin: () => void
  onMove: () => void
  onDelete: () => void
  children: React.ReactNode
  liProps?: React.LiHTMLAttributes<HTMLLIElement>
}

/**
 * A note in the list. With a finger: swipe left for Move / Pin / Delete (a
 * long swipe deletes straight away), swipe right to pin or unpin – like
 * Apple Notes. In select mode it shows a tick circle instead.
 */
export function NoteRow({ id, className, pinned, selecting, selected, draggable, onClick, onPin, onMove, onDelete, children, liProps }: Props) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const openId = useStore(openRow, (s) => s.id)
  const gesture = useRef<{ x: number; y: number; base: number; pointer: number; swiping: boolean } | null>(null)
  const swiped = useRef(false)
  const ref = useRef<HTMLLIElement>(null)

  // another row opened (or select mode started): close this one
  useEffect(() => {
    if ((openId !== id || selecting) && offset !== 0 && !dragging) setOffset(0)
  }, [openId, id, selecting, offset, dragging])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || selecting || e.clientX <= EDGE || e.clientX >= window.innerWidth - EDGE) return
    gesture.current = { x: e.clientX, y: e.clientY, base: offset, pointer: e.pointerId, swiping: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || e.pointerId !== g.pointer) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (!g.swiping) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (gesture.current = null) // scrolling
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      g.swiping = true
      setDragging(true)
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      openRow.set({ id })
    }
    const w = ref.current?.clientWidth ?? 320
    setOffset(Math.max(-w, Math.min(96, g.base + dx)))
  }
  const onPointerUp = () => {
    const g = gesture.current
    gesture.current = null
    if (!g?.swiping) return
    // ignore the click the browser may send as the finger lifts
    swiped.current = true
    setTimeout(() => (swiped.current = false), 350)
    setDragging(false)
    const w = ref.current?.clientWidth ?? 320
    if (offset < -w * 0.6) {
      setOffset(-w)
      setTimeout(onDelete, 150)
    } else if (offset < -60) setOffset(-ACTIONS)
    else {
      if (offset > 64) onPin()
      setOffset(0)
    }
  }

  const close = () => {
    setOffset(0)
    openRow.set({ id: null })
  }

  return (
    <li
      ref={ref}
      {...liProps}
      className={`${className} swipe-row${selected ? ' selected' : ''}${offset ? ' swiping' : ''}`}
      draggable={draggable && !offset}
      onClickCapture={(e) => {
        // the click that ends a swipe, or a tap on an open row, just closes it
        if ((e.target as Element).closest('.swipe-actions')) return
        if (swiped.current || offset) {
          e.stopPropagation()
          e.preventDefault()
          swiped.current = false
          if (offset) close()
        }
      }}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {offset > 0 && (
        <div className="swipe-pin" style={{ width: offset }}>
          {pinned ? <PinOff size={18} /> : <Pin size={18} />}
        </div>
      )}
      {offset < 0 && (
        <div className="swipe-actions" style={{ width: Math.max(-offset, ACTIONS) }}>
          <button
            className="swipe-move"
            onClick={(e) => {
              e.stopPropagation()
              close()
              onMove()
            }}
          >
            <FolderInput size={18} />
            <span>Move</span>
          </button>
          <button
            className="swipe-pin-btn"
            onClick={(e) => {
              e.stopPropagation()
              close()
              onPin()
            }}
          >
            {pinned ? <PinOff size={18} /> : <Pin size={18} />}
            <span>{pinned ? 'Unpin' : 'Pin'}</span>
          </button>
          <button
            className="swipe-delete"
            onClick={(e) => {
              e.stopPropagation()
              close()
              onDelete()
            }}
          >
            <Trash2 size={18} />
            <span>Delete</span>
          </button>
        </div>
      )}
      <div className={`swipe-content${dragging ? '' : ' settle'}`} style={offset ? { transform: `translateX(${offset}px)` } : undefined}>
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
