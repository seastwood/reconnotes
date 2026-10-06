import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const PANEL_MS = 260

/**
 * A panel that slides in and out instead of popping: it stays on screen
 * while it slides away, then leaves. `mode` "side" slides a column in from
 * the left (iPad / computer); "push" slides whole screens like iOS
 * navigation (iPhone), forwards from the right and back to the right.
 * Nothing animates on first appearance (opening the app).
 */
export function Panel({
  show,
  mode,
  dir = 'fwd',
  className = '',
  style,
  children,
}: {
  show: boolean
  mode: 'side' | 'push' | 'none'
  dir?: 'fwd' | 'back'
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(show)
  const [phase, setPhase] = useState<'idle' | 'enter' | 'exit'>('idle')
  const [phaseDir, setPhaseDir] = useState(dir)
  const first = useRef(true)

  // set before the first paint, so an entering panel never flashes in place
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (mode === 'none') {
      setMounted(show)
      setPhase('idle')
      return
    }
    setPhaseDir(dir)
    if (show) {
      setMounted(true)
      setPhase('enter')
    } else if (mounted) setPhase('exit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show])

  useEffect(() => {
    if (phase === 'idle') return
    const t = setTimeout(() => {
      if (phase === 'exit') setMounted(false)
      setPhase('idle')
    }, PANEL_MS)
    return () => clearTimeout(t)
  }, [phase])

  if (!show && !mounted) return null
  const anim = phase === 'idle' ? '' : ` panel-${phase} panel-${phaseDir}`
  return (
    <div
      className={`panel panel-${mode}${anim} ${className}`}
      style={style}
      // a panel that is leaving can't be used any more
      inert={phase === 'exit' || undefined}
    >
      {children}
    </div>
  )
}
