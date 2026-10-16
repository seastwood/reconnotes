import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Loader2, Sparkles, X } from 'lucide-react'
import { isFinished, submitJob, useJobs, watchingJob } from '../lib/jobs'
import { flushNote } from '../lib/ai'
import { safeLocalGet, safeLocalSet } from '../lib/store'
import { isSyncConfigured } from '../lib/settings'

/**
 * A title and #tags from your AI
 * ==============================
 *
 * For a note pasted in or written without a name: asked for from the note's AI menu (or by
 * itself when a lot is pasted into an empty note). What comes back shows above the note –
 * "Use" puts the title at the top, "Add" the tags at the end; nothing changes until then.
 */
const DISMISSED = 'reconnotes.suggestDismissed'

export async function suggestTitle(noteId: string) {
  await flushNote(noteId)
  return submitJob({ kind: 'suggest-title', title: 'Suggest a title and tags', noteId, input: { noteId } })
}

/** A lot pasted into an empty note: ask for a title and tags (the paste's text, and whether the note was empty). */
export function suggestAfterPaste(noteId: string, pasted: string, wasEmpty: boolean) {
  if (!wasEmpty || pasted.replace(/\s+/g, ' ').trim().length < 200 || !isSyncConfigured()) return
  setTimeout(() => void suggestTitle(noteId).catch(() => {}), 1500)
}

export function SuggestTitleBar({ editor, noteId, readOnly }: { editor: Editor; noteId: string; readOnly: boolean }) {
  const job = useJobs((s) => s.jobs.filter((j) => j.kind === 'suggest-title' && j.noteId === noteId).sort((a, b) => b.createdAt - a.createdAt)[0])
  const [gone, setGone] = useState<string[]>(() => safeLocalGet<string[]>(DISMISSED, []))
  const [used, setUsed] = useState<{ title?: boolean; tags?: boolean }>({})
  const id = job?.id
  const finished = job ? isFinished(job) : true
  // while it shows here, no "finished" toast for it
  useEffect(() => {
    if (!id || finished) return
    watchingJob(id, true)
    return () => watchingJob(id, false)
  }, [id, finished])
  useEffect(() => setUsed({}), [id])
  if (!job || readOnly || gone.includes(job.id)) return null
  // an old one (a day): not brought up again
  if (Date.now() - job.createdAt > 24 * 3600_000) return null
  const dismiss = () => {
    const next = [...gone, job.id].slice(-100)
    setGone(next)
    safeLocalSet(DISMISSED, next)
  }
  const close = (
    <button className="icon" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
      <X size={15} />
    </button>
  )
  if (!finished)
    return (
      <div className="suggest-bar">
        <Loader2 size={15} className="spin" /> <span className="suggest-what">Thinking of a title and tags…</span>
        {close}
      </div>
    )
  if (job.status !== 'done')
    return job.status === 'failed' ? (
      <div className="suggest-bar">
        <Sparkles size={15} /> <span className="suggest-what">{job.error ?? 'No title could be suggested.'}</span>
        {close}
      </div>
    ) : null
  const title = String(job.result?.title ?? '')
  const tags = Array.isArray(job.result?.tags) ? (job.result.tags as string[]) : []
  const useTitle = () => {
    const first = editor.state.doc.firstChild
    const { schema } = editor.state
    editor
      .chain()
      .command(({ tr }) => {
        // the first line is the title: an empty one or a heading is replaced, else a heading goes above it
        if (first && (first.type.name === 'heading' || (first.type.name === 'paragraph' && !first.textContent.trim()))) {
          tr.replaceWith(1, 1 + first.content.size, schema.text(title))
          if (first.type.name !== 'heading') tr.setNodeMarkup(0, schema.nodes.heading, { level: 1 })
        } else tr.insert(0, schema.nodes.heading.create({ level: 1 }, schema.text(title)))
        return true
      })
      .run()
    setUsed((u) => ({ ...u, title: true }))
  }
  const addTags = () => {
    editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: tags.map((t) => `#${t}`).join(' ') }] }).run()
    setUsed((u) => ({ ...u, tags: true }))
  }
  const titleLeft = title && !used.title
  const tagsLeft = tags.length > 0 && !used.tags
  if (!titleLeft && !tagsLeft) return null
  return (
    <div className="suggest-bar">
      <Sparkles size={15} />
      <span className="suggest-what">
        {titleLeft && (
          <span className="suggest-part">
            <b>{title}</b>
            <button onClick={useTitle}>Use title</button>
          </span>
        )}
        {tagsLeft && (
          <span className="suggest-part">
            {tags.map((t) => (
              <span key={t} className="suggest-tag">
                #{t}
              </span>
            ))}
            <button onClick={addTags}>Add tags</button>
          </span>
        )}
      </span>
      {close}
    </div>
  )
}
