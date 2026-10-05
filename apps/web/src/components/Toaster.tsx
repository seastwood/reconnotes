import { X } from 'lucide-react'
import { dismissToast, useToast } from '../lib/toast'

export function Toaster() {
  const t = useToast()
  if (!t) return null
  return (
    <div className="toast" role="status" key={t.id}>
      <span>{t.text}</span>
      {t.undo && (
        <button
          className="toast-undo"
          onClick={() => {
            t.undo!()
            dismissToast()
          }}
        >
          Undo
        </button>
      )}
      <button className="icon" onClick={dismissToast} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  )
}
