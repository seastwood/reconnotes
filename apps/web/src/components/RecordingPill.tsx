import { useEffect, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { stopRecording, useRecording } from '../lib/recorder'
import { getNotes, readNote } from '@reconnotes/core'
import { workspaceDoc } from '../lib/workspace'

/**
 * A recording keeps going when you leave its note: this shows it (and stops
 * it) from anywhere. Tapping it goes back to the note.
 */
export function RecordingPill({ shownNoteId, onOpen }: { shownNoteId: string | null; onOpen: (id: string) => void }) {
  const active = useRecording()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  if (!active || active.noteId === shownNoteId) return null
  const secs = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000))
  const meta = getNotes(workspaceDoc).get(active.noteId)
  const title = (meta && readNote(meta).title) || 'Untitled'
  return (
    <div className="recording-pill" role="status">
      <button className="recording-pill-open" onClick={() => onOpen(active.noteId)} title="Go to the note">
        <Mic size={15} className="rec-dot" />
        <span className="recording-pill-text">
          Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')} · {title}
        </span>
      </button>
      <button className="recording-pill-stop" onClick={() => void stopRecording()} aria-label="Stop recording">
        <Square size={14} /> Stop
      </button>
    </div>
  )
}
