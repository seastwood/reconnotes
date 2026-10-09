import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { transcriptApi } from '../lib/agents'
import { showToast } from '../lib/toast'

/**
 * Fix a word the speech-to-text misheard ("Summet" → "Summit"): in this recording's transcript,
 * or in every recording's – and remembered, so new transcripts come out right (and Whisper is
 * told how it's spelled). Starts with the words you'd selected in the transcript, if any.
 * A dialog over the note – not inside the editor, which would take the taps and typing (iOS).
 */
export function WordFix({ attachmentId, selected, onClose }: { attachmentId: string; selected: string; onClose: () => void }) {
  const [from, setFrom] = useState(selected)
  const [to, setTo] = useState(selected)
  const [everywhere, setEverywhere] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const fix = async () => {
    if (!from.trim() || !to.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await transcriptApi.fix(attachmentId, from, to, everywhere)
      showToast(
        r.places
          ? `Fixed ${r.places === 1 ? 'once' : `${r.places} times`}${r.recordings > 1 ? ` in ${r.recordings} recordings` : ''} – new transcripts will spell it “${to.trim()}” too`
          : `“${from.trim()}” isn’t in ${everywhere ? 'any transcript' : 'this transcript'} – remembered for new ones`,
      )
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog word-fix"
        role="dialog"
        aria-label="Fix a misheard word"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void fix()
        }}
      >
        <div className="word-fix-head">
          <b>Fix a misheard word</b>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="word-fix-fields">
          <label>
            It heard
            <input
              ref={first}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="Summet"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="next"
            />
          </label>
          <label>
            It should be
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Summit" autoCorrect="off" enterKeyHint="done" />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
          In every recording’s transcript
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="word-fix-actions">
          <button type="submit" className="primary" disabled={busy || !from.trim() || !to.trim() || from.trim() === to.trim()}>
            {busy ? <Loader2 size={14} className="spin" /> : null} Fix
          </button>
          <span className="hint">Whole words only; remembered for new transcripts.</span>
        </div>
      </form>
    </div>,
    document.body,
  )
}
