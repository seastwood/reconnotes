import { useEffect, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { agentsApi, promptsApi, type AgentsState, type EditablePrompt } from '../lib/agents'

/**
 * Settings › Prompts: what the AI is told for each kind of job – the parts of the meeting-notes
 * prompt that decide what the notes say, and your own standing instructions for each kind of job –
 * each with "Reset to default". Plus how a long meeting is read.
 */
export function PromptsSection() {
  const [prompts, setPrompts] = useState<EditablePrompt[] | null>(null)
  const [state, setState] = useState<AgentsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void promptsApi
      .list()
      .then((r) => setPrompts(r.prompts))
      .catch((e) => setError((e as Error).message))
    void agentsApi
      .list()
      .then(setState)
      .catch(() => {})
  }, [])
  if (error) return <p className="status error-text">{error}</p>
  if (!prompts)
    return (
      <p className="hint">
        <Loader2 size={14} className="spin" /> Loading prompts…
      </p>
    )
  const save = (key: string, value: string | null) =>
    promptsApi
      .set(key, value)
      .then((r) => setPrompts(r.prompts))
      .catch((e) => setError((e as Error).message))
  const groups = [...new Set(prompts.map((p) => p.group))]
  const changed = prompts.filter((p) => p.changed)
  return (
    <div className="prompts">
      <p className="hint">
        Change what the AI is told, if a kind of job keeps getting something wrong. Every prompt has <b>Reset to default</b>. A change applies to the next job – redo a
        meeting’s notes to see it. (The notes’ headings and layout stay fixed: the checks after the AI writes rely on them.)
      </p>
      {changed.length > 1 && (
        <button
          className="text"
          onClick={() => confirm(`Put all ${changed.length} changed prompts back to their defaults?`) && void Promise.all(changed.map((p) => save(p.key, null)))}
        >
          <RotateCcw size={14} /> Reset all to defaults
        </button>
      )}
      {groups.map((g) => (
        <section key={g}>
          <h3>{g}</h3>
          {g === 'Meeting notes' && state && (
            <MeetingKnobs
              minutes={state.settings.meetingPartMinutes ?? 8}
              think={state.settings.meetingThink ?? true}
              onChange={(patch) => void agentsApi.updateSettings(patch).then(setState)}
            />
          )}
          {prompts
            .filter((p) => p.group === g)
            .map((p) => (
              <PromptEditor key={p.key} prompt={p} onSave={(v) => save(p.key, v)} />
            ))}
        </section>
      ))}
    </div>
  )
}

function PromptEditor({ prompt, onSave }: { prompt: EditablePrompt; onSave: (value: string | null) => Promise<void> }) {
  const [text, setText] = useState(prompt.value)
  const [saved, setSaved] = useState(false)
  useEffect(() => setText(prompt.value), [prompt.value])
  const dirty = text !== prompt.value
  const save = () => {
    if (!dirty) return
    void onSave(text).then(() => {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    })
  }
  const standing = prompt.key.startsWith('extra.')
  return (
    <div className={`prompt-editor${prompt.changed ? ' changed' : ''}`}>
      <div className="prompt-head">
        <b>{prompt.label}</b>
        {prompt.changed && <span className="prompt-badge">Changed</span>}
        {saved && <span className="muted">Saved</span>}
      </div>
      <p className="hint">{prompt.help}</p>
      <textarea
        value={text}
        rows={standing ? 2 : Math.min(10, Math.max(3, Math.ceil(text.length / 70)))}
        placeholder={standing ? 'Nothing – write any instructions you always want followed' : ''}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
      />
      <div className="row">
        {dirty && (
          <button className="primary" onClick={save}>
            Save
          </button>
        )}
        {(prompt.changed || dirty) && (
          <button
            onClick={() => {
              if (!confirm(standing ? 'Clear your instructions?' : 'Put this prompt back to its default?')) return
              setText(prompt.default)
              void onSave(null)
            }}
          >
            <RotateCcw size={14} /> {standing ? 'Clear' : 'Reset to default'}
          </button>
        )}
      </div>
    </div>
  )
}

/** How a long meeting is read: minutes per part, and reasoning first or not. */
function MeetingKnobs({ minutes, think, onChange }: { minutes: number; think: boolean; onChange: (patch: { meetingPartMinutes?: number; meetingThink?: boolean }) => void }) {
  const [draft, setDraft] = useState(minutes)
  useEffect(() => setDraft(minutes), [minutes])
  useEffect(() => {
    if (draft === minutes) return
    const t = setTimeout(() => onChange({ meetingPartMinutes: draft }), 600)
    return () => clearTimeout(t)
  }, [draft, minutes, onChange])
  return (
    <div className="meeting-knobs">
      <label className="check">
        <input type="checkbox" checked={think} onChange={(e) => onChange({ meetingThink: e.target.checked })} />
        Let the model think before writing (better notes; slower – off answers straight away)
      </label>
      <div className="speaker-threshold">
        <span className="muted">Long meetings are read in parts of</span>
        <input type="range" min={4} max={20} step={1} value={draft} onChange={(e) => setDraft(Number(e.target.value))} aria-label="Minutes per part" />
        <b>{draft} min</b>
        {draft !== 8 && (
          <button className="text" onClick={() => setDraft(8)}>
            Default
          </button>
        )}
      </div>
      <p className="hint">
        Shorter parts: more detail from each, more of the meeting’s time spent reading (and topics cut more often). Longer: faster, but a small model skims. 8 minutes
        suits an 8B model.
      </p>
    </div>
  )
}
