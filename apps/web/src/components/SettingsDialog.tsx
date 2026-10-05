import { useState } from 'react'
import { X } from 'lucide-react'
import { settings, useSettings, type PencilInTextMode, type Theme } from '../lib/settings'
import { serverInfo } from '../lib/ai'
import { AiAgentsSection } from './AiAgentsSection'
import { deviceOcrAvailable } from '../lib/deviceOcr'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings((x) => x)
  const [url, setUrl] = useState(s.serverUrl)
  const [token, setToken] = useState(s.token)
  const [status, setStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const connected = Boolean(s.serverUrl && s.token)
  const unsaved = url !== s.serverUrl || token !== s.token

  const test = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const info = await serverInfo(url, token)
      if (!info.authorized) setStatus('❌ Server reachable, but the token is wrong.')
      else {
        const ai = Object.entries(info.ai)
          .filter(([, v]) => v)
          .map(([k]) => k)
        setStatus(
          `✅ Connected to ReconNotes ${info.version}. AI: ${ai.length ? ai.join(', ') : 'off'}. Audio transcription: ${info.transcription ? 'on' : 'off'}.` +
            (unsaved ? ' Press “Save & connect” to start using it.' : ''),
        )
      }
    } catch (e) {
      setStatus(`❌ Could not reach the server: ${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>

        <section>
          <h3>Sync server</h3>
          <p className="hint">
            Notes always work offline. Connect your self-hosted ReconNotes server to sync between devices, back up, search
            attachments and use AI. Leave empty to keep everything on this device.
          </p>
          <label>
            Server address
            <input value={url} placeholder="https://notes.example.com" onChange={(e) => setUrl(e.target.value.trim())} autoCapitalize="off" autoCorrect="off" />
          </label>
          <label>
            Access token
            <input value={token} type="password" placeholder="RECON_TOKEN from the server" onChange={(e) => setToken(e.target.value.trim())} />
          </label>
          <div className="row">
            <button onClick={test} disabled={!url || testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button className="primary" onClick={() => settings.set({ serverUrl: url, token })}>
              Save &amp; connect
            </button>
            {s.serverUrl && (
              <button
                onClick={() => {
                  settings.set({ serverUrl: '', token: '' })
                  setUrl('')
                  setToken('')
                }}
              >
                Disconnect
              </button>
            )}
          </div>
          {status && <p className="status">{status}</p>}
          {unsaved && url && token && <p className="status warn-text">You have unsaved changes – press “Save &amp; connect”.</p>}
        </section>

        <section>
          <h3>AI agents</h3>
          {connected ? (
            <AiAgentsSection key={s.serverUrl + s.token} />
          ) : (
            <div className="setup-problem">
              <strong>Connect your server first</strong>
              <div>
                AI agents are set up on your ReconNotes server. Enter the server address and access token above (the token is RECON_TOKEN in
                /etc/reconnotes.env), press <b>Save &amp; connect</b>, and the “Add AI agent” button will appear here.
              </div>
            </div>
          )}
        </section>

        {deviceOcrAvailable() && (
          <section>
            <h3>Handwriting recognition on this device</h3>
            <label className="check">
              <input type="checkbox" checked={s.deviceOcr} onChange={(e) => settings.set({ deviceOcr: e.target.checked })} />
              Use Apple’s on-device recognition (fast, private, works offline)
            </label>
            <p className="hint">
              Your handwriting stays ink until you press “Convert to text” (on a drawing, a picture, or “Convert all handwriting” in the
              note’s ⋯ menu). Apple’s recognizer runs on this device; your server’s AI agents are used only if it finds nothing.
            </p>
            <label className="check">
              <input type="checkbox" checked={s.backgroundOcr} onChange={(e) => settings.set({ backgroundOcr: e.target.checked })} />
              Make handwriting searchable in the background (only stores hidden search text – never changes your note)
            </label>
            {s.deviceOcr && (
              <label className="check">
                <input type="checkbox" checked={s.deviceOcrCleanup} onChange={(e) => settings.set({ deviceOcrCleanup: e.target.checked })} />
                Then polish the result with my “Clean up converted text” agent when online
              </label>
            )}
          </section>
        )}

        <section>
          <h3>Apple Pencil &amp; drawing</h3>
          <label className="check">
            <input type="checkbox" checked={s.fingerDrawing} onChange={(e) => settings.set({ fingerDrawing: e.target.checked })} />
            Draw with finger (otherwise only Apple Pencil and mouse draw, and fingers scroll the page)
          </label>
          <label>
            When the Pencil touches typed text
            <select value={s.pencilInText} onChange={(e) => settings.set({ pencilInText: e.target.value as PencilInTextMode })}>
              <option value="scribble">Use iPadOS Scribble (writing on text becomes typed text; off while editing a drawing)</option>
              <option value="draw">Start a drawing there</option>
            </select>
          </label>
          {s.pencilInText === 'scribble' && (
            <p className="hint">
              Scribble must also be on in the iPad's Settings › Apple Pencil › Scribble. To start a drawing, use the pen button in the
              toolbar.
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={Boolean(s.debugInput)} onChange={(e) => settings.set({ debugInput: e.target.checked })} />
            Log typing and Scribble events (troubleshooting – shown in Xcode’s console as “[input]”)
          </label>
          <p className="hint">
            Pencil double-tap follows your iPad setting (Settings › Apple Pencil). Squeezing an Apple Pencil Pro opens the tool palette with
            undo, tools and colours.
          </p>
        </section>

        <section>
          <h3>Appearance</h3>
          <label>
            Theme
            <select value={s.theme} onChange={(e) => settings.set({ theme: e.target.value as Theme })}>
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </section>
      </div>
    </div>
  )
}
