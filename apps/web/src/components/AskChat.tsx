import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, BookOpen, ChevronLeft, FilePlus2, History, Loader2, MessageCircleQuestion, Sparkles, SquarePen, Trash2, X } from 'lucide-react'
import { useFolderAccess } from '../lib/folderLock'
import { isFinished, submitJob, useJobs, watchingJob, type Job } from '../lib/jobs'
import { safeLocalGet, safeLocalSet, useStore } from '../lib/store'
import { isSyncConfigured } from '../lib/settings'
import { askChat, chatKey, closeAskChat, hideAskChat, showAskChat, type AskChatTarget } from '../lib/askChat'
import { useAskHistory, when, type Conversation } from './AskHistory'
import { AskAnswer, Turn, type AskResult } from './AskPanel'
import { ReferencesBar } from './References'
import { SaveAsNoteDialog } from './SaveAsNoteDialog'
import type { TurnToSave } from '../lib/askToNote'

/**
 * "Ask about this note" (and "Ask this folder"): a chat window of its own,
 * over the note. Every chat about the note is kept (on the server), to read
 * again or carry on; an answer's sources open the note at the line with the
 * answer – the chat steps aside, and "Back to chat" brings it back. Closing
 * the chat is back to the note.
 */
export function AskChatHost({ onOpen }: { onOpen: (noteId: string, find?: string) => void }) {
  const target = useStore(askChat, (s) => s.target)
  const hidden = useStore(askChat, (s) => s.hidden)
  if (!target) return null
  if (hidden)
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
  return <AskChat target={target} onOpen={onOpen} />
}

function AskChat({ target, onOpen }: { target: AskChatTarget; onOpen: (noteId: string, find?: string) => void }) {
  const access = useFolderAccess()
  const key = chatKey(target)
  const chatId = useStore(askChat, (s) => s.chat[key] ?? null)
  const setChat = (id: string | null) => askChat.set((s) => ({ chat: { ...s.chat, [key]: id } }))
  const history = useAskHistory(target.all ? {} : target.folderId ? { folderId: target.folderId } : { noteId: target.noteId })
  const [listOpen, setListOpen] = useState(false)
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
        .filter((j) => j.kind === 'ask' && (j.id === chatId || j.input.thread === chatId) && j.status !== 'cancelled')
        .filter((j) => !saved.some((t) => t.question === j.input.question && t.at >= j.createdAt))
        .sort((a, b) => a.createdAt - b.createdAt)
    : []
  // chats about this note with a question still being answered: listed (and
  // opened) before they're kept – a new chat is only kept once answered
  const ofThis = (j: Job) => {
    const notes = Array.isArray(j.input.notes) ? j.input.notes.map(String) : []
    const folders = Array.isArray(j.input.folders) ? j.input.folders.map(String) : []
    if (target.all) return !notes.length && !folders.length
    return target.folderId ? !notes.length && folders.length === 1 && folders[0] === target.folderId : notes.length === 1 && notes[0] === target.noteId
  }
  const answering = jobs.filter((j) => j.kind === 'ask' && !isFinished(j) && ofThis(j)).sort((a, b) => b.createdAt - a.createdAt)
  const rootOf = (j: Job) => (typeof j.input.thread === 'string' && j.input.thread ? j.input.thread : j.id)
  const busyChats = new Set(answering.map(rootOf))
  const kept = history.list ?? []
  const chats: Conversation[] = [
    ...[...busyChats]
      .filter((id) => !kept.some((c) => c.id === id))
      .map((id) => {
        const first = jobs.find((j) => j.id === id) ?? answering.find((j) => rootOf(j) === id)!
        return {
          id,
          turns: [
            {
              question: String(first.input.question),
              answer: '',
              sources: [],
              at: first.createdAt,
            },
          ],
          updatedAt: first.createdAt,
        }
      }),
    ...kept,
  ]
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
  const showList = listOpen || (!chatId && chats.length > 0)
  const empty = !chatId && !showList
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
      if (!chatId || showList) {
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
      setListOpen(false)
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
    }).catch((e) => setError((e as Error).message))

  // saving an answer (or the whole chat) as a note
  const [saving, setSaving] = useState<TurnToSave[] | null>(null)
  const doneLive: TurnToSave[] = live
    .filter((j) => j.status === 'done' && typeof j.result?.answer === 'string')
    .map((j) => {
      const r = j.result as unknown as AskResult
      return { question: String(j.input.question), answer: r.answer, sources: r.sources }
    })
  /** an answer from the notes that found nothing in them: the same question, answered without them */
  const notFound = (r: { answer: string; sources: unknown[]; general?: boolean }) =>
    !r.general && !r.sources.length && /don['’]t contain|do not contain|doesn['’]t (?:say|mention|contain)|no (?:information|mention)|not (?:mentioned|found|in (?:the|your) notes)/i.test(r.answer)
  const withoutNotes = (q: string) => (
    <button className="text ask-save" onClick={() => void send(q, 'general').catch(() => {})} disabled={busy}>
      <Sparkles size={14} /> Answer without my notes
    </button>
  )
  const allTurns: TurnToSave[] = [...saved.map((t) => ({ question: t.question, answer: t.answer, sources: t.sources })), ...doneLive]
  const saveButton = (t: TurnToSave) => (
    <button className="text ask-save" onClick={() => setSaving([t])}>
      <FilePlus2 size={14} /> Save as note
    </button>
  )

  /** a source: the note, at the line with the answer – the chat steps aside */
  const go = (noteId: string, find?: string) => {
    hideAskChat()
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
  }, [count, chatId, listOpen, Boolean(conversation)])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [writing, liveIds.length, live.map((j) => j.status).join(',')])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeAskChat()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div className="ask-chat" role="dialog" aria-label={`Ask about ${target.title || 'this note'}`}>
      <header className="ask-chat-head">
        <button className="text ask-chat-back" onClick={closeAskChat} aria-label="Back to the note">
          <ChevronLeft size={20} /> {target.noteId ? 'Note' : 'Back'}
        </button>
        <div className="ask-chat-title">
          <span className="ask-chat-kicker">
            <MessageCircleQuestion size={13} /> {target.all ? 'Ask your notes' : target.folderId ? 'Ask this folder' : 'Ask about this note'}
          </span>
          <span className="ask-chat-name">{target.title || 'Untitled'}</span>
        </div>
        <button
          className="icon"
          aria-label="Save the chat as a note"
          title="Save the chat as a note"
          onClick={() => setSaving(allTurns)}
          disabled={showList || !allTurns.length}
        >
          <FilePlus2 size={19} />
        </button>
        <button
          className={`icon${listOpen ? ' active' : ''}`}
          aria-label="Chats about this note"
          title="Chats"
          onClick={() => setListOpen((v) => !v)}
          disabled={!chats.length}
        >
          <History size={19} />
        </button>
        <button
          className="icon"
          aria-label="New chat"
          title="New chat"
          onClick={() => {
            setChat(null)
            setListOpen(false)
          }}
        >
          <SquarePen size={19} />
        </button>
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
        {showList ? (
          <ChatList
            list={chats}
            busy={busyChats}
            current={chatId}
            onPick={(c) => {
              setChat(c.id)
              setListOpen(false)
            }}
            onRemove={(id) => {
              history.remove(id)
              if (id === chatId) setChat(null)
            }}
          />
        ) : empty ? (
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
                  {saveButton({ question: t.question, answer: t.answer, sources: t.sources })}
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
            ? chatId && !showList
              ? 'Ask a follow-up…'
              : 'Ask your AI anything – a recipe, an email, an idea…'
            : chatId && !showList
              ? 'Ask a follow-up…'
              : target.all
                ? 'What do your notes say about…?'
                : target.folderId
                  ? 'Ask about this folder’s notes…'
                  : 'What does it say about…?'
        }
        disabled={busy && !showList}
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
    </div>,
    document.body,
  )
}

/** what each chat window answers from (by its key): 'notes' or 'general' */
const MODES = 'reconnotes.askMode'

function ChatList({
  list,
  busy,
  current,
  onPick,
  onRemove,
}: {
  list: Conversation[]
  /** chats with a question being answered */
  busy: Set<string>
  current: string | null
  onPick: (c: Conversation) => void
  onRemove: (id: string) => void
}) {
  if (!list.length) return <p className="hint ask-chat-none">No chats yet.</p>
  return (
    <div className="ask-chat-list">
      <div className="menu-label">
        <History size={13} /> Chats about this note
      </div>
      {list.map((c) => (
        <div key={c.id} className={`ask-chat-row${c.id === current ? ' active' : ''}`} onClick={() => onPick(c)}>
          <div className="ask-chat-row-text">
            <span className="ask-chat-row-q">{c.turns[0]?.question}</span>
            <span className="ask-chat-row-meta">
              {busy.has(c.id) ? (
                <>
                  <Loader2 size={11} className="spin" /> Answering…
                </>
              ) : (
                <>
                  {c.turns.length > 1 ? `${c.turns.length} questions · ` : ''}
                  {when(c.updatedAt)}
                </>
              )}
            </span>
          </div>
          {!busy.has(c.id) && (
            <button
              className="icon"
              aria-label="Delete this chat"
              title="Delete this chat"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(c.id)
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ))}
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
