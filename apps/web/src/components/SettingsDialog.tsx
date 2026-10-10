import { useEffect, useRef, useState } from 'react'
import { Archive, Bell, Bot, PenTool, RefreshCw, ScanText, ScrollText, SlidersHorizontal, X, type LucideIcon } from 'lucide-react'
import { PromptsSection } from './PromptsSection'
import { settings, useSettings, type PencilInTextMode, type Theme } from '../lib/settings'
import { serverInfo } from '../lib/ai'
import { AiAgentsSection } from './AiAgentsSection'
import { TestBenchSection } from './AiHealth'
import { BackupsSection } from './BackupsSection'
import { SharingSection } from './SharingSection'
import { OffsiteSection } from './OffsiteSection'
import { ExportImportSection } from './ExportImportSection'
import { DevicesSection } from './DevicesSection'
import { NotificationsSection } from './NotificationsSection'
import { CalendarDigestSection } from './CalendarDigestSection'
import { notificationsSupported } from '../lib/notify'
import { deviceOcrAvailable } from '../lib/deviceOcr'
import { deviceSpeechAvailable } from '../lib/speech'

/**
 * Settings: a page of its own, in categories – a list down the side on a wide screen, tabs along
 * the top on a phone. The category you were last in opens next time.
 */
export type SettingsTab = 'general' | 'sync' | 'ai' | 'prompts' | 'recognition' | 'pencil' | 'notifications' | 'data'

export const SETTINGS_TABS: {
  id: SettingsTab
  label: string
  icon: LucideIcon
  blurb: string
}[] = [
  {
    id: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    blurb: 'How ReconNotes looks and behaves on this device.',
  },
  {
    id: 'sync',
    label: 'Sync & devices',
    icon: RefreshCw,
    blurb: 'Your ReconNotes server, and the devices that use it.',
  },
  {
    id: 'ai',
    label: 'AI agents',
    icon: Bot,
    blurb: 'The models your server uses, and which one does what.',
  },
  {
    id: 'prompts',
    label: 'Prompts',
    icon: ScrollText,
    blurb: 'What the AI is told for each kind of job – change it, or put it back to the default.',
  },
  {
    id: 'recognition',
    label: 'Handwriting & speech',
    icon: ScanText,
    blurb: 'Reading handwriting, pictures and recordings – on your server and on this device.',
  },
  {
    id: 'pencil',
    label: 'Pencil & drawing',
    icon: PenTool,
    blurb: 'Apple Pencil, finger drawing and shapes.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    blurb: 'Reminders, notifications, your calendar feed and the weekly digest.',
  },
  {
    id: 'data',
    label: 'Sharing & backups',
    icon: Archive,
    blurb: 'What’s shared with others, backups of your library, offsite copies, and moving notes in and out.',
  },
]
const LAST_TAB = 'reconnotes.settingsTab'

function lastTab(): SettingsTab {
  try {
    const t = localStorage.getItem(LAST_TAB)
    if (SETTINGS_TABS.some((x) => x.id === t)) return t as SettingsTab
  } catch {
    /* no storage */
  }
  return 'general'
}

export function SettingsDialog({ onClose, tab: initial }: { onClose: () => void; tab?: SettingsTab }) {
  const s = useSettings((x) => x)
  const connected = Boolean(s.serverUrl && s.token)
  // nothing set up yet: start where you connect your server
  const [tab, setTab] = useState<SettingsTab>(() => initial ?? (connected ? lastTab() : 'sync'))
  const pane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    try {
      localStorage.setItem(LAST_TAB, tab)
    } catch {
      /* no storage */
    }
    pane.current?.scrollTo({ top: 0 })
    // the chosen tab in view in the strip along the top (phones)
    document.querySelector('.settings-nav .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const key = s.serverUrl + s.token
  const current = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0]
  const needsServer = (what: string) => <ConnectFirst what={what} onGo={() => setTab('sync')} />

  return (
    <div className="settings-page dialog" role="dialog" aria-label="Settings">
      <header className="settings-head">
        <h2>Settings</h2>
        <button className="icon" onClick={onClose} aria-label="Close settings">
          <X size={20} />
        </button>
      </header>
      <nav className="settings-nav" role="tablist" aria-label="Settings categories">
        {SETTINGS_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} onClick={() => setTab(t.id)}>
            <t.icon size={17} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-pane" ref={pane} role="tabpanel" aria-label={current.label}>
        <h2 className="settings-title">{current.label}</h2>
        <p className="hint">{current.blurb}</p>

        {tab === 'general' && (
          <>
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

            <section>
              <h3>Checklists</h3>
              <label className="check">
                <input type="checkbox" checked={s.sortChecked !== false} onChange={(e) => settings.set({ sortChecked: e.target.checked })} />
                Move ticked items below the unticked ones (unticking moves an item back up)
              </label>
            </section>
          </>
        )}

        {tab === 'sync' && (
          <>
            <SyncServerSection />
            {connected && (
              <section>
                <h3>Devices</h3>
                <DevicesSection key={key} />
              </section>
            )}
          </>
        )}

        {tab === 'ai' &&
          (connected ? (
            <>
              <AiAgentsSection key={key} />
              <TestBenchSection />
            </>
          ) : (
            needsServer('AI agents are set up on your server')
          ))}

        {tab === 'prompts' && (connected ? <PromptsSection key={key} /> : needsServer('The prompts are kept on your server'))}

        {tab === 'recognition' && (
          <>
            {connected ? (
              <section>
                <AiAgentsSection key={key} part="recognition" />
              </section>
            ) : (
              needsServer('Reading handwriting, pictures and recordings for search happens on your server')
            )}

            {deviceOcrAvailable() && (
              <section>
                <h3>Handwriting recognition on this device</h3>
                <label className="check">
                  <input type="checkbox" checked={s.deviceOcr} onChange={(e) => settings.set({ deviceOcr: e.target.checked })} />
                  Use Apple’s on-device recognition (fast, private, works offline)
                </label>
                {s.deviceOcr && (
                  <label>
                    “Convert to text” uses
                    <select
                      value={s.ocrFirst ?? 'device'}
                      onChange={(e) =>
                        settings.set({
                          ocrFirst: e.target.value as 'device' | 'server',
                        })
                      }
                    >
                      <option value="device">Apple first – your server’s models if it finds nothing</option>
                      <option value="server">Your server’s models first – Apple when offline or they fail</option>
                    </select>
                  </label>
                )}
                <p className="hint">
                  Your handwriting stays ink until you press “Convert to text” (on a drawing, a picture, or “Convert all handwriting” in the note’s ⋯ menu).{' '}
                  {s.ocrFirst === 'server'
                    ? 'Your server’s handwriting agents read it (Settings › AI agents); Apple’s recognizer on this device steps in when the server can’t be reached or finds nothing. The Jobs list shows which one did each conversion.'
                    : 'Apple’s recognizer runs on this device; your server’s AI agents are used only if it finds nothing. The Jobs list shows which one did each conversion.'}
                </p>
                <label className="check">
                  <input type="checkbox" checked={s.backgroundOcr} onChange={(e) => settings.set({ backgroundOcr: e.target.checked })} />
                  Make handwriting searchable in the background (only stores hidden search text – never changes your note)
                  {s.ocrFirst === 'server' ? ' – with your server’s models first, the server does this' : ''}
                </label>
                {s.deviceOcr && (
                  <label className="check">
                    <input type="checkbox" checked={s.deviceOcrCleanup} onChange={(e) => settings.set({ deviceOcrCleanup: e.target.checked })} />
                    Then polish the result with my “Clean up converted text” agent when online
                  </label>
                )}
              </section>
            )}

            {deviceSpeechAvailable() && (
              <section>
                <h3>Audio transcription on this device</h3>
                <label className="check">
                  <input type="checkbox" checked={s.deviceSpeech} onChange={(e) => settings.set({ deviceSpeech: e.target.checked })} />
                  Use Apple’s speech recognition for “Transcribe” (private, works offline for most languages)
                </label>
                <p className="hint">
                  Your server’s “Audio to text” agents (e.g. a Whisper server) are used when Apple can’t read the recording or finds no speech.
                </p>
              </section>
            )}
          </>
        )}

        {tab === 'pencil' && (
          <section>
            <h3>Apple Pencil &amp; drawing</h3>
            <label className="check">
              <input type="checkbox" checked={s.fingerDrawing} onChange={(e) => settings.set({ fingerDrawing: e.target.checked })} />
              Draw with finger in an open drawing (tap a drawing to open it; two fingers scroll). Otherwise only Apple Pencil and mouse draw
            </label>
            <label className="check">
              <input type="checkbox" checked={s.shapeSnap !== false} onChange={(e) => settings.set({ shapeSnap: e.target.checked })} />
              Hold the pen still at the end of a line, box, circle or arrow to make it a clean shape
            </label>
            <label>
              When the Pencil touches typed text
              <select
                value={s.pencilInText}
                onChange={(e) =>
                  settings.set({
                    pencilInText: e.target.value as PencilInTextMode,
                  })
                }
              >
                <option value="scribble">Use iPadOS Scribble (writing on text becomes typed text; off while editing a drawing)</option>
                <option value="draw">Start a drawing there</option>
              </select>
            </label>
            {s.pencilInText === 'scribble' && (
              <p className="hint">
                Scribble must also be on in the iPad's Settings › Apple Pencil › Scribble. To start a drawing, use the pen button in the toolbar.
              </p>
            )}
            <label className="check">
              <input type="checkbox" checked={Boolean(s.debugInput)} onChange={(e) => settings.set({ debugInput: e.target.checked })} />
              Log typing and Scribble events (troubleshooting – shown in Xcode’s console as “[input]”)
            </label>
            <p className="hint">
              Pencil double-tap follows your iPad setting (Settings › Apple Pencil). Squeezing an Apple Pencil Pro opens the tool palette with undo, tools and
              colours.
            </p>
          </section>
        )}

        {tab === 'notifications' && (
          <>
            {deviceSpeechAvailable() && (
              <section>
                <h3>Reminders</h3>
                <label className="check">
                  <input type="checkbox" checked={s.dueReminders !== false} onChange={(e) => settings.set({ dueReminders: e.target.checked })} />
                  Remind me at 9:00 on the day a checklist item is due (type “!friday”, “!tomorrow”, “!oct 12” in an item)
                </label>
              </section>
            )}

            {(connected || notificationsSupported()) && (
              <section>
                <h3>Notifications</h3>
                <NotificationsSection key={key} />
              </section>
            )}

            {connected ? (
              <section>
                <h3>Calendar &amp; weekly digest</h3>
                <CalendarDigestSection key={key} />
              </section>
            ) : (
              needsServer('Notifications, the calendar feed and the weekly digest come from your server')
            )}
          </>
        )}

        {tab === 'data' &&
          (connected ? (
            <>
              <section>
                <h3>Shared with others</h3>
                <SharingSection />
              </section>
              <section>
                <h3>Backups</h3>
                <BackupsSection key={key} />
                <OffsiteSection key={`offsite${key}`} />
              </section>
              <section>
                <h3>Export &amp; import</h3>
                <ExportImportSection />
              </section>
            </>
          ) : (
            needsServer('Backups and export are made by your server')
          ))}
      </div>
    </div>
  )
}

/** Where to find what a tab needs, before a server is connected. */
function ConnectFirst({ what, onGo }: { what: string; onGo: () => void }) {
  return (
    <div className="setup-problem">
      <strong>Connect your server first</strong>
      <div>{what}. Enter its address and access token (RECON_TOKEN in /etc/reconnotes.env) under Sync &amp; devices.</div>
      <button onClick={onGo}>Go to Sync &amp; devices</button>
    </div>
  )
}

/** The server this device syncs with: test it, connect, disconnect. */
function SyncServerSection() {
  const s = useSettings((x) => x)
  const [url, setUrl] = useState(s.serverUrl)
  const [token, setToken] = useState(s.token)
  const [status, setStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

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
    <section>
      <h3>Sync server</h3>
      <p className="hint">
        Notes always work offline. Connect your self-hosted ReconNotes server to sync between devices, back up, search attachments and use AI. Leave empty to
        keep everything on this device.
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
  )
}
