import { useState } from 'react'
import { ArrowLeft, ArrowRight, Command, Link2, PenLine, Search, Sparkles, Hand, X } from 'lucide-react'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { isSyncConfigured } from '../lib/settings'

const KEY = 'reconnotes.tourSeen'

/** Show the tour on a device's first start (not to automated test browsers). */
export function shouldShowTour(): boolean {
  return !safeLocalGet<boolean>(KEY, false) && !navigator.webdriver
}
export function markTourSeen() {
  safeLocalSet(KEY, true)
}

const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const phone = touch && typeof screen !== 'undefined' && Math.min(screen.width, screen.height) < 600

interface Card {
  icon: typeof PenLine
  title: string
  lines: React.ReactNode[]
}

function cards(): Card[] {
  return [
    {
      icon: Sparkles,
      title: 'Welcome to ReconNotes',
      lines: [
        'Type, write and draw in the same note. Everything works offline and syncs when you’re back online.',
        isSyncConfigured()
          ? 'This device is connected to your server: notes sync and back up on their own.'
          : 'To sync between devices and back up, connect your ReconNotes server in Settings.',
      ],
    },
    {
      icon: PenLine,
      title: 'Write by hand',
      lines: phone
        ? ['Tap the pen button to add a drawing, then write or sketch with your finger.', 'Your handwriting is read in the background, so search finds it.']
        : [
            'Touch the page with Apple Pencil to start writing – or use the pen button.',
            'Handwriting is read in the background, so search finds it. “Convert to text” turns it into typing.',
            'Hold the pen still at the end of a line, box or circle to make it a clean shape.',
          ],
    },
    {
      icon: Hand,
      title: touch ? 'Swipes' : 'Moving around',
      lines: touch
        ? [
            'Swipe in from the left edge to show your notes and folders – or to go back after following a link. From the right edge to go forward.',
            'Swipe a note in the list to the left for Move, Pin and Delete; to the right to pin it.',
          ]
        : ['⌘[ and ⌘] go back and forward after following links between notes.', '⌘-click or Shift-click notes in the list to select several, then drag them onto a folder.'],
    },
    {
      icon: Link2,
      title: 'Links, tags and dates',
      lines: [
        <>
          Type <b>[[</b> to link to another note.
        </>,
        <>
          Type <b>#robotics</b> to tag a note – tags appear in the sidebar.
        </>,
        <>
          In a checklist, <b>!friday</b> or <b>!oct 12</b> makes a due date with a reminder.
        </>,
      ],
    },
    {
      icon: Search,
      title: 'Find anything',
      lines: [
        'Search looks inside typing, handwriting, photos, PDFs, documents and recordings – and highlights the words where they are.',
        <>
          <Command size={14} style={{ verticalAlign: -2 }} /> The ⌘ button (or ⌘K) runs any command or jumps to any note. “Ask your notes” answers questions
          from what you’ve written.
        </>,
      ],
    },
  ]
}

export function Tour({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const all = cards()
  const [i, setI] = useState(0)
  const card = all[i]
  const Icon = card.icon
  const close = () => {
    markTourSeen()
    onClose()
  }
  const last = i === all.length - 1
  return (
    <div className="dialog-backdrop" onClick={close}>
      <div
        className="tour"
        role="dialog"
        aria-label="Tips"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' && !last) setI(i + 1)
          if (e.key === 'ArrowLeft' && i > 0) setI(i - 1)
          if (e.key === 'Escape') close()
        }}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <button className="icon tour-close" onClick={close} aria-label="Close tips">
          <X size={18} />
        </button>
        <div className="tour-icon">
          <Icon size={30} />
        </div>
        <h2>{card.title}</h2>
        {card.lines.map((l, k) => (
          <p key={k}>{l}</p>
        ))}
        {i === 0 && !isSyncConfigured() && (
          <button
            className="text"
            onClick={() => {
              close()
              onSettings()
            }}
          >
            Connect a server…
          </button>
        )}
        <div className="tour-dots" aria-hidden="true">
          {all.map((_, k) => (
            <span key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)} />
          ))}
        </div>
        <div className="tour-nav">
          {i > 0 ? (
            <button onClick={() => setI(i - 1)}>
              <ArrowLeft size={16} /> Back
            </button>
          ) : (
            <button className="text" onClick={close}>
              Skip
            </button>
          )}
          <button className="primary" onClick={() => (last ? close() : setI(i + 1))}>
            {last ? 'Start writing' : 'Next'} {!last && <ArrowRight size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}

