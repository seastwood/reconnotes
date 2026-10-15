import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ArrowUpDown, BookOpen, ChevronLeft, FileText, FilePlus2, Folder, History, Library, Loader2, MessageCircleQuestion, Search, Sparkles, SquarePen, Trash2, X } from 'lucide-react'
import { useFolderAccess } from '../lib/folderLock'
import { isFinished, submitJob, useJobs, watchingJob, type Job } from '../lib/jobs'
import { safeLocalGet, safeLocalSet, useStore } from '../lib/store'
import { isSyncConfigured } from '../lib/settings'
import { chatList, forgetChat, markChatSeen, refreshChats, type ChatBrief } from '../lib/chatList'
import { useMedia } from '../lib/media'
import { useWorkspace } from '../lib/workspace'
import { ALL_NOTES, DOCK_MEDIA, askChat, browseChats, chatKey, closeAskChat, hideAskChat, lastChatTarget, openAskChat, openChatAt, showAskChat, stopBrowsing, type AskChatTarget } from '../lib/askChat'
import { Popover } from './Popover'
import { useAskHistory, when, type Conversation } from './AskHistory'
import { AskAnswer, Turn, type AskResult } from './AskPanel'
import { ReferencesBar } from './References'
import { SaveAsNoteDialog } from './SaveAsNoteDialog'
import type { TurnToSave } from '../lib/askToNote'

/**
 * The Ask chat ("Ask about this note", "Ask this folder", "Ask your notes").
 *
 * On a big screen it's a panel beside the note (drag its edge to make it wider): it stays on its
 * chat as you go from note to note, so you can read it and write a note at once, and its sources
 * open in the note beside it. On a phone it covers the note; a source opens the note and the chat
 * steps aside ("Back to chat" brings it back). Swiping in from the right edge opens it; swiping
 * right from its left edge closes it. Every chat is kept (on the server): the list of chats shows
 * them all – about all your notes, each folder, each note – to read again or carry on.
 */
export function AskChatHost({
  onOpen,
  onShowFolder,
  current,
  noteOnScreen,
}: {
  onOpen: (noteId: string, find?: string) => void
  onShowFolder: (folderId: string) => void
  /** the note open now (a new chat can be about it, or its folder) */
  current: { noteId: string; title: string; folderId: string | null } | null
  /** a note is what's on screen (the right-edge swipe opens the chat only from a note) */
  noteOnScreen: boolean
}) {
  const target = useStore(askChat, (s) => s.target)
  const hidden = useStore(askChat, (s) => s.hidden)
  const browsing = useStore(askChat, (s) => s.browsing)
  const docked = useMedia(DOCK_MEDIA)
  const currentRef = useRef(current)
  currentRef.current = current
  const onScreenRef = useRef(noteOnScreen)
  onScreenRef.current = noteOnScreen
  // the swipe brings back the chat last open (the chat button, the one about the note on screen);
  // with none yet, one about the note
  useChatSlide(docked, () => {
    if (!onScreenRef.current) return null
    const c = currentRef.current
    return lastChatTarget() ?? (c ? { noteId: c.noteId, title: c.title } : null)
  })
  if (!target && !browsing) return null
  const inner = browsing || !target ? (
    <ChatBrowser docked={docked} current={current} />
  ) : (
    <AskChat target={target} docked={docked} current={current} onOpen={onOpen} onShowFolder={onShowFolder} />
  )
  if (docked) return <ChatDock>{inner}</ChatDock>
  if (hidden && target && !browsing)
    return createPortal(
      <div className="ask-chat-pill">
        <button className="ask-chat-pill-open" onClick={showAskChat}>
          <MessageCircleQuestion size={16} /> Back to chat
        </button>
        <button className="icon" aria-label="Close the chat" onClick={closeAskChat}>
          <X size={15} />
        </button>
      </div>,
      document.body,
    )
  return createPortal(inner, document.body)
}

const DOCK_WIDTH = 'reconnotes.chatWidth'
/** how the list of chats is sorted (kept on this device) */
const CHAT_SORT = 'reconnotes.chatSort'
type ChatSort = 'subject' | 'recent' | 'oldest' | 'unread'

/** The panel beside the note: its left edge dragged to make it wider or narrower (remembered). */
function ChatDock({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(() => safeLocalGet<number>(DOCK_WIDTH, 420))
  const clamp = (w: number) => Math.round(Math.max(320, Math.min(w, innerWidth * 0.6)))
  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const start = width
    let now = start
    const move = (m: PointerEvent) => {
      now = clamp(start + (startX - m.clientX))
      setWidth(now)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-chat')
      safeLocalSet(DOCK_WIDTH, now)
    }
    document.body.classList.add('resizing-chat')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <aside className="ask-dock" style={{ width: clamp(width) }}>
      <div className="ask-dock-edge" onPointerDown={drag} role="separator" aria-orientation="vertical" aria-label="Drag to resize the chat" title="Drag to resize" />
      {children}
    </aside>
  )
}

/**
 * Touch screens: the chat slides in from the right edge over a note – following the finger, and
 * opening if it's pulled far enough (or flicked), else sliding back – and out again the same way,
 * pulled right from its left edge. So swiping goes folders › notes › note › chat and back. Beside
 * the note (a big screen), the swipe just shows or hides the panel.
 */
function useChatSlide(docked: boolean, openable: () => AskChatTarget | null) {
  const dockedRef = useRef(docked)
  dockedRef.current = docked
  const openableRef = useRef(openable)
  openableRef.current = openable
  useEffect(() => {
    const EDGE = 24
    type Drag = { mode: 'open' | 'close'; x0: number; y0: number; locked: boolean; wasHidden: boolean; target: AskChatTarget | null; last: { x: number; t: number }[] }
    let d: Drag | null = null
    const el = () => document.querySelector<HTMLElement>('.ask-chat:not(.docked)')
    const W = () => innerWidth
    const place = (x: number, animate: boolean) => {
      const e = el()
      if (!e) return
      e.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      e.style.transform = `translateX(${x}px)`
    }
    const settle = (x: number, then: () => void) => {
      place(x, true)
      setTimeout(() => {
        then()
        const e = el()
        if (e) {
          e.style.transition = ''
          e.style.transform = ''
        }
      }, 230)
    }
    const down = (ev: TouchEvent) => {
      const t = ev.touches[0]
      d = null
      if (ev.touches.length !== 1 || !t || (t as Touch & { touchType?: string }).touchType === 'stylus') return
      const s = askChat.get()
      const showing = Boolean((s.target && !s.hidden) || s.browsing)
      if (dockedRef.current) {
        // beside the note: a plain swipe shows or hides the panel
        if (!showing && t.clientX > W() - EDGE) {
          const target = openableRef.current()
          if (target) d = { mode: 'open', x0: t.clientX, y0: t.clientY, locked: false, wasHidden: false, target, last: [] }
        } else if (showing) {
          const dock = document.querySelector('.ask-dock')?.getBoundingClientRect()
          if (dock && t.clientX >= dock.left && t.clientX < dock.left + EDGE) d = { mode: 'close', x0: t.clientX, y0: t.clientY, locked: false, wasHidden: false, target: null, last: [] }
        }
        return
      }
      if (!showing && t.clientX > W() - EDGE) {
        const target = s.hidden && s.target ? s.target : openableRef.current()
        if (target) d = { mode: 'open', x0: t.clientX, y0: t.clientY, locked: false, wasHidden: s.hidden, target, last: [] }
      } else if (showing && t.clientX < EDGE + 6 && (ev.target as Element).closest?.('.ask-chat')) {
        d = { mode: 'close', x0: t.clientX, y0: t.clientY, locked: false, wasHidden: false, target: null, last: [] }
      }
    }
    const move = (ev: TouchEvent) => {
      const t = ev.touches[0]
      if (!d || !t) return
      const dx = t.clientX - d.x0
      const dy = t.clientY - d.y0
      if (!d.locked) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) return void (d = null) // scrolling
        if (Math.abs(dx) < 8) return
        if ((d.mode === 'open' && dx > 0) || (d.mode === 'close' && dx < 0)) return void (d = null)
        d.locked = true
        if (dockedRef.current) return
        // in it comes, from the edge
        if (d.mode === 'open') askChat.set({ target: d.target, hidden: false, browsing: false, dragX: W() })
      }
      if (ev.cancelable) ev.preventDefault()
      if (dockedRef.current) return
      d.last = [...d.last.slice(-4), { x: t.clientX, t: performance.now() }]
      place(d.mode === 'open' ? Math.max(0, Math.min(W(), W() + dx)) : Math.max(0, dx), false)
    }
    const up = (ev: TouchEvent) => {
      if (!d?.locked) return void (d = null)
      const drag = d
      d = null
      const t = ev.changedTouches[0]
      const dx = (t?.clientX ?? drag.x0) - drag.x0
      if (dockedRef.current) {
        if (drag.mode === 'open' && dx < -50 && drag.target) openAskChat(drag.target)
        if (drag.mode === 'close' && dx > 60) closeAskChat()
        return
      }
      // how fast at the end (px/ms; + rightwards)
      const a = drag.last[0]
      const b = drag.last[drag.last.length - 1]
      const v = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0
      const far = Math.abs(dx) > W() * 0.35
      if (drag.mode === 'open') {
        if (far || v < -0.45) settle(0, () => askChat.set({ dragX: null }))
        else settle(W(), () => (drag.wasHidden ? askChat.set({ hidden: true, dragX: null }) : closeAskChat()))
      } else {
        if (far || v > 0.45) settle(W(), () => closeAskChat())
        else settle(0, () => undefined)
      }
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', up, { passive: true })
    window.addEventListener('touchcancel', up, { passive: true })
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      window.removeEventListener('touchcancel', up)
    }
  }, [])
}

function AskChat({
  target,
  docked,
  current,
  onOpen,
  onShowFolder,
}: {
  target: AskChatTarget
  docked: boolean
  current: { noteId: string; title: string; folderId: string | null } | null
  onOpen: (noteId: string, find?: string) => void
  onShowFolder: (folderId: string) => void
}) {
  const access = useFolderAccess()
  const key = chatKey(target)
  const chatId = useStore(askChat, (s) => s.chat[key] ?? null)
  const setChat = (id: string | null) => askChat.set((s) => ({ chat: { ...s.chat, [key]: id } }))
  const history = useAskHistory(target.all ? {} : target.folderId ? { folderId: target.folderId } : { noteId: target.noteId })
  // on screen: its answers are read
  const unread = useStore(chatList, (s) => (chatId ? (s.list?.find((c) => c.id === chatId)?.unread ?? 0) : 0))
  useEffect(() => {
    if (chatId && unread && document.visibilityState === 'visible') markChatSeen(chatId)
  }, [chatId, unread])
  // what it answers from: your notes, or anything (the AI's own answer: a recipe for the Recipes
  // folder) – kept for each chat window (a note's, a folder's, all notes')
  const [mode, setModeState] = useState<'notes' | 'general'>(() => safeLocalGet<Record<string, 'notes' | 'general'>>(MODES, {})[key] ?? 'notes')
  const setMode = (m: 'notes' | 'general') => {
    setModeState(m)
    safeLocalSet(MODES, { ...safeLocalGet<Record<string, 'notes' | 'general'>>(MODES, {}), [key]: m })
  }
  const jobs = useJobs((s) => s.jobs)
  const conversation = chatId ? history.list?.find((c) => c.id === chatId) : undefined
  const saved = conversation?.turns ?? []
  // questions of this chat not kept yet (being answered, or just answered)
  const live = chatId
    ? jobs
        .filter((j) => j.kind === 'ask' && (j.id === chatId || j.input.thread === chatId))
        .filter((j) => !saved.some((t) => t.question === j.input.question && t.at >= j.createdAt))
        .sort((a, b) => a.createdAt - b.createdAt)
        // a stopped question shows as stopped – until it's asked again
        .filter((j, i, all) => j.status !== 'cancelled' || !all.slice(i + 1).some((k) => k.input.question === j.input.question))
    : []
  // chats about this with a question still being answered (a new chat is only kept once answered)
  const ofThis = (j: Job) => {
    const notes = Array.isArray(j.input.notes) ? j.input.notes.map(String) : []
    const folders = Array.isArray(j.input.folders) ? j.input.folders.map(String) : []
    if (target.all) return !notes.length && !folders.length
    return target.folderId ? !notes.length && folders.length === 1 && folders[0] === target.folderId : notes.length === 1 && notes[0] === target.noteId
  }
  const answering = jobs.filter((j) => j.kind === 'ask' && !isFinished(j) && ofThis(j)).sort((a, b) => b.createdAt - a.createdAt)
  const rootOf = (j: Job) => (typeof j.input.thread === 'string' && j.input.thread ? j.input.thread : j.id)
  // opened with no chat chosen while one is being answered: that one
  const newestBusy = answering[0] ? rootOf(answering[0]) : null
  const loaded = useJobs((s) => s.loaded)
  const decided = useRef(false)
  useEffect(() => {
    if (decided.current || !loaded) return
    decided.current = true
    if (!chatId && newestBusy) setChat(newestBusy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])
  const empty = !chatId
  const busy = live.some((j) => !isFinished(j))
  const [error, setError] = useState<string | null>(null)

  // while they're on screen, no "finished" toast for them
  const liveIds = live.map((j) => j.id).join(',')
  useEffect(() => {
    const ids = liveIds ? liveIds.split(',') : []
    ids.forEach((id) => watchingJob(id, true))
    return () => ids.forEach((id) => watchingJob(id, false))
  }, [liveIds])

  const scope = target.all
    ? { folders: [] as string[], unlocked: access.unlockedIds }
    : target.folderId
    ? { folders: [target.folderId], unlocked: access.unlockedIds }
    : {
        folders: [] as string[],
        notes: [target.noteId!],
        unlocked: access.unlockedIds,
      }
  const send = async (question: string, as: 'notes' | 'general' = mode) => {
    setError(null)
    if (!isSyncConfigured()) return setError('Asking uses the AI agents on your ReconNotes server – connect one in Settings.')
    const input: Record<string, unknown> = {
      ...scope,
      tzOffset: new Date().getTimezoneOffset(),
      question,
      ...(as === 'general' ? { mode: 'general' } : {}),
    }
    try {
      if (!chatId) {
        // a new chat (asked with no chat open, or from the list of chats): its first question's job names it
        const j = await submitJob({ kind: 'ask', title: question, input })
        setChat(j.id)
      } else {
        // the chat so far, so a follow-up can say "it" and "that"
        const turns = [
          ...saved.map((t) => ({
            question: t.question,
            answer: t.answer,
            sources: t.sources.map((s) => s.noteId),
          })),
          ...live
            .filter((j) => j.status === 'done' && typeof j.result?.answer === 'string')
            .map((j) => {
              const r = j.result as unknown as AskResult
              return {
                question: String(j.input.question),
                answer: r.answer,
                sources: r.sources.map((s) => s.noteId),
              }
            }),
        ]
        await submitJob({
          kind: 'ask',
          title: question,
          input: { ...input, thread: chatId, history: turns },
        })
      }
    } catch (e) {
      setError((e as Error).message)
      throw e
    }
  }
  const retry = (j: Job) =>
    void submitJob({
      kind: 'ask',
      title: String(j.input.question),
      input: j.input,
    })
      // the chat's first question asked again: the chat is the new one
      .then((n) => j.id === chatId && setChat(n.id))
      .catch((e) => setError((e as Error).message))

  // saving an answer (or the whole chat) as a note
  const [saving, setSaving] = useState<TurnToSave[] | null>(null)
  const doneLive: TurnToSave[] = live
    .filter((j) => j.status === 'done' && typeof j.result?.answer === 'string')
    .map((j) => {
      const r = j.result as unknown as AskResult
      return { question: String(j.input.question), answer: r.answer, sources: r.sources, cites: r.cites }
    })
  /** an answer from the notes that found nothing in them: the same question, answered without them */
  const notFound = (r: { answer: string; sources: unknown[]; general?: boolean }) =>
    !r.general && !r.sources.length && /don['’]t contain|do not contain|doesn['’]t (?:say|mention|contain)|no (?:information|mention)|not (?:mentioned|found|in (?:the|your) notes)/i.test(r.answer)
  const withoutNotes = (q: string) => (
    <button className="text ask-save" onClick={() => void send(q, 'general').catch(() => {})} disabled={busy}>
      <Sparkles size={14} /> Answer without my notes
    </button>
  )
  const allTurns: TurnToSave[] = [...saved.map((t) => ({ question: t.question, answer: t.answer, sources: t.sources, cites: t.cites })), ...doneLive]
  const saveButton = (t: TurnToSave) => (
    <button className="text ask-save" onClick={() => setSaving([t])}>
      <FilePlus2 size={14} /> Save as note
    </button>
  )

  /** a source: the note, at the line with the answer – beside the chat, or with the chat stepping aside (phone) */
  const go = (noteId: string, find?: string) => {
    if (!docked) hideAskChat()
    onOpen(noteId, find)
  }

  // the newest message in view
  const scroller = useRef<HTMLDivElement>(null)
  const count = saved.length + live.length
  const writing = live.map((j) => (j.partial as { answer?: string } | undefined)?.answer?.length ?? 0).join(',')
  const nearBottom = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    nearBottom.current = true
  }, [count, chatId, Boolean(conversation)])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [writing, liveIds.length, live.map((j) => j.status).join(',')])

  // Escape closes it – beside the note, only from inside the chat (Escape in the note is the note's)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || newMenuRef.current || (docked && !root.current?.contains(document.activeElement))) return
      closeAskChat()
    }
    // (before the menu's own Escape handler has closed it)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [docked])
  const newBtn = useRef<HTMLButtonElement>(null)
  const [newMenu, setNewMenu] = useState(false)
  // (Escape with the menu open closes the menu, not the chat)
  const newMenuRef = useRef(false)
  newMenuRef.current = newMenu

  // brought in by a finger (it places it) – or with a button: it slides in by itself
  const startX = useStore(askChat, (s) => s.dragX)
  const [slidIn] = useState(() => askChat.get().dragX !== null)
  const about = target.all ? 'Ask your notes' : target.folderId ? 'Ask this folder' : 'Ask about this note'
  const openSubject = () => (target.noteId ? go(target.noteId) : target.folderId ? onShowFolder(target.folderId) : undefined)
  return (
    <div
      ref={root}
      className={`ask-chat${docked ? ' docked' : slidIn ? '' : ' slides-in'}`}
      style={!docked && startX !== null ? { transform: `translateX(${startX}px)`, transition: 'none' } : undefined}
      role={docked ? 'complementary' : 'dialog'}
      aria-label={`${about}: ${target.title || 'this note'}`}
    >
      <header className="ask-chat-head">
        {docked ? (
          <button className="icon" onClick={closeAskChat} aria-label="Close the chat" title="Close the chat">
            <X size={19} />
          </button>
        ) : (
          <button className="text ask-chat-back" onClick={closeAskChat} aria-label="Back to the note">
            <ChevronLeft size={20} /> {target.noteId ? 'Note' : 'Back'}
          </button>
        )}
        <button className="ask-chat-title" onClick={openSubject} disabled={target.all} title={target.noteId ? 'Open the note' : target.folderId ? 'Show the folder' : undefined}>
          <span className="ask-chat-kicker">
            <MessageCircleQuestion size={13} /> {about}
          </span>
          <span className="ask-chat-name">{target.title || 'Untitled'}</span>
        </button>
        <button className="icon" aria-label="Save the chat as a note" title="Save the chat as a note" onClick={() => setSaving(allTurns)} disabled={!allTurns.length}>
          <FilePlus2 size={19} />
        </button>
        <button className="icon" aria-label="All chats" title="All chats" onClick={browseChats}>
          <History size={19} />
        </button>
        <button ref={newBtn} className="icon" aria-label="New chat" title="New chat" onClick={() => setNewMenu((v) => !v)}>
          <SquarePen size={19} />
        </button>
        {newMenu && (
          <Popover anchorRef={newBtn} align="right" onClose={() => setNewMenu(false)}>
            <NewChatMenu target={target} current={current} onDone={() => setNewMenu(false)} onSame={() => setChat(null)} />
          </Popover>
        )}
      </header>
      {target.noteId && <ReferencesBar noteId={target.noteId} onOpen={go} />}

      <div
        className="ask-chat-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {empty ? (
          <div className="ask-chat-empty">
            {mode === 'general' ? (
              <>
                <Sparkles size={34} />
                <p>Ask your AI anything – a recipe, an email, an idea. It answers from what it knows, not from your notes.</p>
                <p className="hint">Like an answer? Save it as a note{target.folderId ? ' – it’s suggested for this folder' : ''}.</p>
              </>
            ) : (
              <>
                <MessageCircleQuestion size={34} />
                <p>
              Ask anything about {target.all ? 'your notes' : target.folderId ? 'the notes in this folder' : 'this note'}. The answer comes only from{' '}
              {target.all ? 'them' : target.folderId ? 'them' : 'it (and the notes it also reads)'}, and
              each source takes you to the spot it came from.
            </p>
            <p className="hint">Your chats are kept here – come back to them any time.</p>
                        </>
            )}
          </div>
        ) : (
          <div className="ask-chat-messages">
            {saved.map((t, i) => (
              <div key={`${i}-${t.at}`} className="ask-chat-turn">
                <div className="ask-chat-q">
                  {t.question}
                  <span className="ask-chat-time">{when(t.at)}</span>
                </div>
                <div className="ask-chat-a ask-panel">
                  <AskAnswer result={{ answer: t.answer, sources: t.sources, cites: t.cites, read: t.read, general: t.general }} onOpen={go} />
                  {saveButton({ question: t.question, answer: t.answer, sources: t.sources, cites: t.cites })}
                  {notFound(t) && i === saved.length - 1 && !live.length && withoutNotes(t.question)}
                </div>
              </div>
            ))}
            {live.map((j) => (
              <div key={j.id} className="ask-chat-turn">
                <div className="ask-chat-q">{String(j.input.question)}</div>
                <div className="ask-chat-a ask-panel">
                  <Turn job={j} onRetry={() => retry(j)} onOpen={go} />
                  {j.status === 'done' && typeof j.result?.answer === 'string' && saveButton(doneLive.find((t) => t.question === String(j.input.question))!)}
                  {j.status === 'done' && j === live[live.length - 1] && notFound(j.result as unknown as AskResult) && withoutNotes(String(j.input.question))}
                </div>
              </div>
            ))}
            {chatId && !conversation && !live.length && <p className="hint">This chat is no longer kept.</p>}
          </div>
        )}
      </div>

      <div className="ask-mode" role="radiogroup" aria-label="Answer from">
        <button role="radio" aria-checked={mode === 'notes'} className={mode === 'notes' ? 'on' : ''} onClick={() => setMode('notes')} title="Answers come only from your notes, with their sources">
          <BookOpen size={14} /> {target.all ? 'Your notes' : target.folderId ? 'This folder' : 'This note'}
        </button>
        <button role="radio" aria-checked={mode === 'general'} className={mode === 'general' ? 'on' : ''} onClick={() => setMode('general')} title="Your AI answers from what it knows – a recipe, an email, an idea – not from your notes">
          <Sparkles size={14} /> Anything
        </button>
      </div>
      <ChatInput
        placeholder={
          mode === 'general'
            ? chatId
              ? 'Ask a follow-up…'
              : 'Ask your AI anything – a recipe, an email, an idea…'
            : chatId
              ? 'Ask a follow-up…'
              : target.all
                ? 'What do your notes say about…?'
                : target.folderId
                  ? 'Ask about this folder’s notes…'
                  : 'What does it say about…?'
        }
        disabled={busy}
        autoFocus={empty}
        error={error}
        onSend={send}
      />
      {saving && (
        <SaveAsNoteDialog
          turns={saving}
          about={target.all ? {} : target.folderId ? { folderId: target.folderId } : { noteId: target.noteId }}
          onClose={() => setSaving(null)}
          onOpen={(id) => go(id)}
        />
      )}
    </div>
  )
}

/** what each chat window answers from (by its key): 'notes' or 'general' */
const MODES = 'reconnotes.askMode'

/**
 * "New chat": about the same thing as this one, or – when another note is open now – about that
 * note, its folder, or all your notes.
 */
function NewChatMenu({
  target,
  current,
  onDone,
  onSame,
}: {
  target: AskChatTarget | null
  current: { noteId: string; title: string; folderId: string | null } | null
  onDone: () => void
  /** a new chat about the same thing as the one open */
  onSame?: () => void
}) {
  const ws = useWorkspace()
  const folder = current?.folderId ? ws.folders.find((f) => f.id === current.folderId) : undefined
  const options: { key: string; t: AskChatTarget; icon: ReactNode; label: string }[] = []
  const add = (t: AskChatTarget, icon: ReactNode, label: string) => {
    if (!options.some((o) => o.key === chatKey(t))) options.push({ key: chatKey(t), t, icon, label })
  }
  if (target) add(target, <SquarePen size={15} />, `New chat about ${target.all ? 'all your notes' : `“${target.title || 'Untitled'}”`}`)
  if (current) add({ noteId: current.noteId, title: current.title }, <FileText size={15} />, `About this note – “${current.title || 'Untitled'}”`)
  if (folder) add({ folderId: folder.id, title: folder.name }, <Folder size={15} />, `About its folder – ${folder.name}`)
  add(ALL_NOTES, <Library size={15} />, 'About all your notes')
  return (
    <>
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => {
            onDone()
            if (target && o.key === chatKey(target) && onSame) onSame()
            else openChatAt(o.t, null)
          }}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </>
  )
}

/** A chat's subject from what it was asked about ("note:<id>", "folders:<id>", "" for all). Null: several notes or folders. */
function subjectOf(scope: string, names: { note: (id: string) => string | null; folder: (id: string) => string | null }): AskChatTarget | null {
  if (!scope) return ALL_NOTES
  const [kind, rest] = [scope.slice(0, scope.indexOf(':')), scope.slice(scope.indexOf(':') + 1)]
  if (kind === 'note') return { noteId: rest, title: names.note(rest) ?? 'A deleted note' }
  if (kind === 'folders' && !rest.includes(',')) return { folderId: rest, title: names.folder(rest) ?? 'A deleted folder' }
  return null
}

/**
 * Every chat, newest first, grouped by what it's about – all your notes, each folder, each note
 * (the open note's first) – with a search. Any of them opens, whatever note is open.
 */
function ChatBrowser({ docked, current }: { docked: boolean; current: { noteId: string; title: string; folderId: string | null } | null }) {
  const ws = useWorkspace()
  const jobs = useJobs((s) => s.jobs)
  const list = useStore(chatList, (s) => s.list)
  const error = useStore(chatList, (s) => s.error)
  const [query, setQuery] = useState('')
  const target = useStore(askChat, (s) => s.target)
  useEffect(() => void refreshChats(), [])
  const names = useMemo(
    () => ({
      note: (id: string) => {
        const n = ws.allNotes.find((x) => x.id === id)
        return n && !n.trashedAt ? n.title || 'Untitled' : null
      },
      folder: (id: string) => {
        const f = ws.folders.find((x) => x.id === id)
        return f && !f.trashedAt ? f.name : null
      },
    }),
    [ws.allNotes, ws.folders],
  )
  // chats with a question being answered that aren't kept yet (a first question)
  const busy = jobs.filter((j) => j.kind === 'ask' && !isFinished(j))
  const busyIds = new Set(busy.map((j) => (typeof j.input.thread === 'string' && j.input.thread ? j.input.thread : j.id)))
  const scopeOfJob = (j: Job) => {
    const notes = Array.isArray(j.input.notes) ? j.input.notes.map(String) : []
    const folders = Array.isArray(j.input.folders) ? j.input.folders.map(String) : []
    return notes.length === 1 ? `note:${notes[0]}` : notes.length ? `notes:${notes.join(',')}` : folders.length ? `folders:${[...folders].sort().join(',')}` : ''
  }
  const all: ChatBrief[] = [
    ...busy
      .filter((j) => !(typeof j.input.thread === 'string' && j.input.thread) && !list?.some((c) => c.id === j.id))
      .map((j) => ({ id: j.id, scope: scopeOfJob(j), question: String(j.input.question), questions: 1, unread: 0, updatedAt: j.createdAt })),
    ...(list ?? []),
  ]
  const q = query.trim().toLowerCase()
  const groups = new Map<string, { subject: AskChatTarget; chats: ChatBrief[]; newest: number }>()
  for (const c of all) {
    const subject = subjectOf(c.scope, names)
    if (!subject) continue
    if (q && !c.question.toLowerCase().includes(q) && !subject.title.toLowerCase().includes(q)) continue
    const key = chatKey(subject)
    const g = groups.get(key) ?? { subject, chats: [], newest: 0 }
    g.chats.push(c)
    g.newest = Math.max(g.newest, c.updatedAt)
    groups.set(key, g)
  }
  const first = current ? `note:${current.noteId}` : null
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => Number(kb === first) - Number(ka === first) || b.newest - a.newest)
  // or one list by date, each chat with what it's about
  const [sort, setSortState] = useState<ChatSort>(() => safeLocalGet<ChatSort>(CHAT_SORT, 'subject'))
  const setSort = (v: ChatSort) => {
    setSortState(v)
    safeLocalSet(CHAT_SORT, v)
  }
  const flat = [...groups.values()]
    .flatMap((g) => g.chats.map((c) => ({ c, subject: g.subject })))
    .sort((a, b) =>
      sort === 'oldest'
        ? a.c.updatedAt - b.c.updatedAt
        : sort === 'unread'
          ? Number(b.c.unread > 0) - Number(a.c.unread > 0) || b.c.updatedAt - a.c.updatedAt
          : b.c.updatedAt - a.c.updatedAt,
    )
  const remove = forgetChat
  const newBtn = useRef<HTMLButtonElement>(null)
  const [newMenu, setNewMenu] = useState(false)
  const icon = (t: AskChatTarget) => (t.all ? <Library size={14} /> : t.folderId ? <Folder size={14} /> : <FileText size={14} />)

  const row = (c: ChatBrief, subject: AskChatTarget, withSubject: boolean) => {
    const answering = busyIds.has(c.id)
    return (
      <div key={c.id} className={`ask-chat-row${c.unread ? ' unread' : ''}`} onClick={() => openChatAt(subject, c.id)}>
        <div className="ask-chat-row-text">
          <div className="ask-chat-row-top">
            <span className="ask-chat-row-q">{c.question}</span>
            <span className="ask-chat-row-time">{answering ? <Loader2 size={12} className="spin" /> : when(c.updatedAt)}</span>
          </div>
          <div className="ask-chat-row-bottom">
            <span className="ask-chat-row-about">
              {answering ? (
                'Answering…'
              ) : withSubject ? (
                <>
                  {icon(subject)} <span className="ask-chat-row-subject">{subject.all ? 'All your notes' : subject.title}</span>
                </>
              ) : c.questions > 1 ? (
                `${c.questions} questions`
              ) : (
                ''
              )}
            </span>
            {!answering && (
              <button
                className="icon ask-chat-row-delete"
                aria-label="Delete this chat"
                title="Delete this chat"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm('Delete this chat?')) remove(c.id)
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
            {c.unread > 0 && (
              <span className="ask-unread" aria-label={`${c.unread} new answer${c.unread === 1 ? '' : 's'}`} title={`${c.unread} new answer${c.unread === 1 ? '' : 's'}`}>
                {c.unread}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`ask-chat ask-browser${docked ? ' docked' : ''}`} role={docked ? 'complementary' : 'dialog'} aria-label="Chats">
      <header className="ask-chat-head">
        {target ? (
          <button className="text ask-chat-back" onClick={stopBrowsing} aria-label="Back to the chat">
            <ChevronLeft size={20} /> Chat
          </button>
        ) : (
          <button className="icon" onClick={closeAskChat} aria-label="Close" title="Close">
            <X size={19} />
          </button>
        )}
        <div className="ask-chat-title static">
          <span className="ask-chat-kicker">
            <History size={13} /> Ask
          </span>
          <span className="ask-chat-name">All chats</span>
        </div>
        <button ref={newBtn} className="icon" aria-label="New chat" title="New chat" onClick={() => setNewMenu((v) => !v)}>
          <SquarePen size={19} />
        </button>
        {newMenu && (
          <Popover anchorRef={newBtn} align="right" onClose={() => setNewMenu(false)}>
            <NewChatMenu target={null} current={current} onDone={() => setNewMenu(false)} />
          </Popover>
        )}
        {target && (
          <button className="icon" onClick={closeAskChat} aria-label="Close the chat" title="Close the chat">
            <X size={19} />
          </button>
        )}
      </header>
      <div className="ask-browser-tools">
        <div className="ask-browser-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
        </div>
        <label className="ask-browser-sort" title="Sort the chats">
          <ArrowUpDown size={14} />
          <select value={sort} onChange={(e) => setSort(e.target.value as ChatSort)} aria-label="Sort the chats">
            <option value="subject">By subject</option>
            <option value="recent">Most recent</option>
            <option value="oldest">Oldest</option>
            <option value="unread">Unread first</option>
          </select>
        </label>
      </div>
      <div className="ask-chat-body">
        {list === null && <Loader2 size={18} className="spin" />}
        {error && <p className="error-text">{error}</p>}
        {list !== null && !ordered.length && (
          <div className="ask-chat-empty">
            <MessageCircleQuestion size={34} />
            <p>{q ? 'No chats match.' : 'No chats yet.'}</p>
            {!q && <p className="hint">Start one with the new-chat button: about this note, its folder or all your notes.</p>}
          </div>
        )}
        {sort !== 'subject' && flat.length > 0 && <div className="ask-browser-flat">{flat.map(({ c, subject }) => row(c, subject, true))}</div>}
        {sort === 'subject' &&
          ordered.map(([key, g]) => (
          <section key={key} className="ask-browser-group">
            <div className="menu-label">
              {icon(g.subject)} {g.subject.all ? 'All your notes' : g.subject.title}
              {key === first && <span className="ask-browser-here">this note</span>}
            </div>
            {g.chats.map((c) => row(c, g.subject, false))}
          </section>
        ))}
      </div>
    </div>
  )
}

/** The box at the bottom: grows with what's typed; sends on Return (Shift-Return for a new line). */
function ChatInput({
  placeholder,
  disabled,
  autoFocus,
  error,
  onSend,
}: {
  placeholder: string
  disabled: boolean
  autoFocus: boolean
  error: string | null
  onSend: (q: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const liftedAt = useRef(0)
  const sending = useRef(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [draft])
  const send = () => {
    const q = draft.trim()
    if (!q || disabled || sending.current) return
    sending.current = true
    // the keyboard away, so the answer has the room
    box.current?.blur()
    onSend(q)
      .then(() => setDraft(''))
      .catch(() => {})
      .finally(() => (sending.current = false))
  }
  return (
    <form
      className="ask-chat-input"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      {error && <p className="error-text">{error}</p>}
      <div className="ask-chat-input-row">
        <textarea
          ref={box}
          rows={1}
          autoFocus={autoFocus}
          value={draft}
          placeholder={disabled ? 'Answering…' : placeholder}
          enterKeyHint="send"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          type="submit"
          className="icon"
          disabled={!draft.trim() || disabled}
          aria-label="Send"
          // iOS can drop the tap that also puts the keyboard away: act when the finger lifts
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return
            e.preventDefault()
            liftedAt.current = Date.now()
            send()
          }}
          onClick={(e) => {
            if (Date.now() - liftedAt.current < 800) e.preventDefault()
          }}
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </form>
  )
}
