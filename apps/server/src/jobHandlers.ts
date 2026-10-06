import fs from 'node:fs'
import * as Y from 'yjs'
import {
  WORKSPACE_DOC,
  createNote,
  extractNote,
  getContent,
  getNotes,
  getDrawingMeta,
  getStrokes,
  getTranscripts,
  noteDocName,
  noteToMarkdown,
  readNote,
  speechToParagraphs,
  updateNote,
} from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { Ai, compileMarker, isAiImage, keepCompileExtras, renderDrawingPng, type CompilePart } from './ai'
import { askNotes } from './ask'
import { processAttachment } from './attachments'
import type { Job, Jobs } from './jobs'
import { reportProgress } from './jobs'
import { runBench, type Samples } from './bench'
import type { AiTask } from './agents'
import { guessedWords } from './vocabulary'
import { markdownToNodes, type Ctx } from './importNotes'

/**
 * What each kind of job does. Results that belong in a note are written into
 * the note here, each block tagged with the job's id (the `job` attribute),
 * so "Remove result" and "Redo" can find them again.
 */

/** Job kinds the app may ask for, and their labels. */
export const JOB_KINDS: Record<string, string> = {
  'convert-drawing': 'Handwriting to text',
  'convert-picture': 'Picture to text',
  transcribe: 'Transcribe recording',
  summary: 'Summary',
  todos: 'To-dos',
  clean: 'Clean up wording',
  compile: 'Compile note',
  ask: 'Ask your notes',
  tidy: 'Clean up recognised text',
  recognise: 'Read handwriting for search',
  'extract-text': 'Read file for search',
  embed: 'Index for search by meaning',
  benchmark: 'Test models on your handwriting',
}

type Parent = Y.XmlFragment | Y.XmlElement
type Spot = { parent: Parent; index: number }

/** Where the first element matching `test` is (searching inside lists, tables…). */
function find(parent: Parent, test: (el: Y.XmlElement) => boolean): Spot | null {
  const children = parent.toArray()
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    if (!(c instanceof Y.XmlElement)) continue
    if (test(c)) return { parent, index: i }
    const inner = find(c, test)
    if (inner) return inner
  }
  return null
}

/** Remove the blocks a job wrote; returns where the first one was. */
function removeTagged(frag: Y.XmlFragment, jobId: string): Spot | null {
  let first: Spot | null = null
  for (;;) {
    const spot = find(frag, (el) => el.getAttribute('job') === jobId)
    if (!spot) return first
    spot.parent.delete(spot.index, 1)
    first ??= spot
  }
}

type Where = { after: (el: Y.XmlElement) => boolean } | 'top' | 'end'

/**
 * Write a result into a note: in place of the result it replaces (redo),
 * else right after the drawing / picture / recording it came from, else at
 * the top (under the title) or the end.
 */
async function writeResult(sync: SyncEngine, noteId: string, jobId: string, markdown: string, where: Where, replace: string | null, ctx: Partial<Ctx> = {}) {
  await sync.change(noteDocName(noteId), (doc) => {
    const frag = getContent(doc)
    let spot = replace ? removeTagged(frag, replace) : null
    if (!spot && typeof where === 'object') {
      const at = find(frag, where.after)
      if (at) spot = { parent: at.parent, index: at.index + 1 }
    }
    if (!spot && where === 'top') spot = { parent: frag, index: frag.length > 1 ? 1 : frag.length }
    spot ??= { parent: frag, index: frag.length }
    const nodes = markdownToNodes(markdown, { attach: () => null, noteFor: () => null, ...ctx })
    for (const n of nodes) n.setAttribute('job', jobId)
    if (nodes.length) spot.parent.insert(spot.index, nodes)
  })
}

/**
 * Mark the words the clean-up pass changed from what the reader saw (⸢word⸣):
 * the note shows them with a dotted underline, worth a second look.
 */
function markGuesses(text: string, raw: string | undefined): string {
  if (!raw || raw === text) return text
  const guessed = guessedWords(raw, text)
  if (!guessed.size || guessed.size > 25) return text // a different reading altogether: don't flag everything
  let out = text
  for (const w of guessed) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}⸢])${esc}(?![\\p{L}\\p{N}⸣])`, 'gu'), `⸢${w}⸣`)
  }
  return out
}

const preview = (text: string) => (text.length > 1500 ? text.slice(0, 1500) + '…' : text)

/** Which AI task a kind of job starts with (for running jobs on an already-loaded model first). */
const FIRST_TASK: Record<string, AiTask | null> = {
  'convert-drawing': 'handwriting',
  'convert-picture': 'handwriting',
  recognise: 'handwriting',
  'extract-text': 'images',
  transcribe: 'audio',
  summary: 'compile',
  todos: 'compile',
  clean: 'compile',
  compile: 'compile',
  ask: 'compile',
  tidy: 'format',
  embed: 'embed',
  benchmark: 'handwriting',
}

export function registerJobHandlers(config: Config, store: Store, sync: SyncEngine, ai: Ai, jobs: Jobs, samples?: Samples) {
  const modelOf = (task: AiTask | null) => {
    const a = task ? ai.agents.chain(task)[0] : undefined
    return a ? `${a.kind}|${a.baseUrl}|${a.model}` : null
  }
  jobs.modelsOf = (job) => {
    const first = modelOf(FIRST_TASK[job.kind] ?? null)
    // converting ends with the clean-up model (when there is one)
    const cleanup = job.kind === 'convert-drawing' || job.kind === 'convert-picture' ? ai.cleanupModel() : null
    return { first, last: cleanup ?? first }
  }

  const replaced = (job: Job) => {
    const r = job.input.replace as string | null | undefined
    if (r) jobs.markReplaced(r, job.id)
    return r ?? null
  }
  const noteDoc = (noteId: unknown) => {
    const doc = typeof noteId === 'string' && /^[a-z0-9]{8,64}$/.test(noteId) ? sync.getDoc(noteDocName(noteId)) : null
    if (!doc) throw new Error('The note no longer exists.')
    return doc
  }

  jobs.register('convert-drawing', async (job) => {
    const { noteId, drawingId } = job.input as { noteId: string; drawingId: string }
    noteDoc(noteId)
    const { text, agent, raw } = await sync.recogniseDrawing(noteId, drawingId, { requireText: true })
    if (!text.trim()) throw new Error('No handwriting was recognised in this drawing.')
    await writeResult(sync, noteId, job.id, markGuesses(text, raw), { after: (el) => el.nodeName === 'drawing' && el.getAttribute('drawingId') === drawingId }, replaced(job))
    return { result: { noteId, text: preview(text) }, agent }
  })

  jobs.register('convert-picture', async (job) => {
    const { noteId, attachmentId, mime } = job.input as { noteId: string; attachmentId: string; mime?: string }
    noteDoc(noteId)
    let data: Buffer
    let type: string
    const att = store.getAttachment(attachmentId)
    if (fs.existsSync(jobs.filePath(job.id))) {
      data = fs.readFileSync(jobs.filePath(job.id))
      type = mime ?? 'image/jpeg'
    } else {
      if (!att || !store.hasBlob(att.id)) throw new Error("This picture hasn't reached the server yet – try again once it has synced.")
      if (!isAiImage(att.mime)) throw new Error('This picture’s format can’t be read. Try a PNG or JPEG.')
      data = fs.readFileSync(store.blobPath(att.id))
      type = att.mime
    }
    // The server already read the whole picture when it was added (for search):
    // tidying that is one quick text-model call. A redo reads the picture again.
    const earlier = !job.input.replace && !job.prompt && att?.text_status === 'done' ? Ai.searchTextAsTranscript(att.text ?? '') : ''
    let text: string
    let agent: string
    let raw: string
    if (earlier) {
      text = await ai.tidy(earlier, isAiImage(type) ? data : null, isAiImage(type) ? type : 'image/png')
      agent = 'Read when the picture was added, then tidied'
      raw = earlier
    } else {
      const r = await ai.transcribePhoto(data, type)
      text = r.text
      agent = r.agent
      raw = r.raw
    }
    if (!text.trim()) throw new Error('No text was found in this picture.')
    await writeResult(sync, noteId, job.id, markGuesses(text, raw), { after: (el) => el.nodeName === 'image' && el.getAttribute('attachmentId') === attachmentId }, replaced(job))
    return { result: { noteId, text: preview(text) }, agent }
  })

  jobs.register('transcribe', async (job) => {
    const { noteId, attachmentId } = job.input as { noteId: string; attachmentId: string }
    noteDoc(noteId)
    const att = store.getAttachment(attachmentId)
    if (!att || !store.hasBlob(att.id)) throw new Error("This recording hasn't reached the server yet – try again once it has synced.")
    let text: string
    let agent: string | null = null
    // the server may already have transcribed it (for search); a redo always does it again
    if (att.text_status === 'done' && att.text?.trim() && !job.input.replace) text = att.text
    else {
      const r = await ai.transcribeAudio(fs.readFileSync(store.blobPath(att.id)), att.mime, att.name)
      text = r.text
      agent = r.agent
      store.setAttachmentText(att.id, text, 'done')
      sync.reindexNotesFor(att.id)
    }
    if (!text.trim()) throw new Error('No speech was recognised in this recording.')
    await writeResult(sync, noteId, job.id, speechToParagraphs(text), { after: (el) => el.nodeName === 'audio' && el.getAttribute('attachmentId') === attachmentId }, replaced(job))
    return { result: { noteId, text: preview(text) }, agent: agent ?? 'Transcript made earlier on the server' }
  })

  for (const action of ['summary', 'todos'] as const) {
    jobs.register(action, async (job) => {
      const noteId = job.input.noteId as string
      const markdown = noteToMarkdown(noteDoc(noteId), { attachmentText: true })
      if (!markdown.trim()) throw new Error('There is no text to work with.')
      const { text, agent } = await ai.noteAction(action, markdown)
      if (!text.trim()) throw new Error(action === 'todos' ? 'No to-dos found in this note.' : 'The AI returned nothing.')
      const md = action === 'summary' ? `**Summary**\n\n${text}\n` : `**To-dos**\n\n${text.replace(/^\s*[-*]\s+(?!\[)/gm, '- [ ] ')}\n`
      await writeResult(sync, noteId, job.id, md, action === 'summary' ? 'top' : 'end', replaced(job))
      return { result: { noteId, text: preview(text) }, agent }
    })
  }

  // these give text back to the app, which puts it where it belongs
  jobs.register('clean', async (job) => {
    const { text, agent } = await ai.noteAction('clean', String(job.input.text ?? ''))
    if (!text.trim()) throw new Error('The AI returned nothing.')
    return { result: { text }, agent }
  })

  jobs.register('tidy', async (job) => {
    const text = String(job.input.text ?? '')
    const file = jobs.filePath(job.id)
    const image = fs.existsSync(file) ? fs.readFileSync(file) : null
    const mime = typeof job.input.mime === 'string' && isAiImage(job.input.mime) ? job.input.mime : 'image/png'
    const tidied = await ai.tidy(text, image, mime)
    return { result: { text: tidied, cleaned: tidied !== text } }
  })

  jobs.register('ask', async (job) => {
    const r = await askNotes(store, sync, ai, String(job.input.question ?? '').slice(0, 1000), sync.meaning)
    return { result: { ...r, question: String(job.input.question ?? '') } as unknown as Record<string, unknown>, agent: r.agent }
  })

  jobs.register('compile', async (job) => {
    const noteId = job.input.noteId as string
    const doc = noteDoc(noteId)
    const { markdown, title, dropped } = await compileMarkdown(store, ai, doc)
    // links, due dates, recordings, files, pictures and drawings come back as the real thing
    const originals = new Map<string, Y.XmlElement>()
    const dues = new Map<string, Record<string, unknown>>()
    const links = new Map<string, string>()
    const walk = (p: Parent) => {
      for (const c of p.toArray()) {
        if (!(c instanceof Y.XmlElement)) continue
        const id = c.getAttribute('attachmentId') as string | undefined
        if ((c.nodeName === 'audio' || c.nodeName === 'file' || c.nodeName === 'image') && id) originals.set(compileMarker(c.nodeName, id), c)
        if (c.nodeName === 'drawing' && c.getAttribute('drawingId')) originals.set(compileMarker('drawing', c.getAttribute('drawingId') as string), c)
        if (c.nodeName === 'dueDate' && !dues.has(c.getAttribute('date') as string)) dues.set(c.getAttribute('date') as string, c.getAttributes())
        if (c.nodeName === 'noteLink') links.set(String(c.getAttribute('title') || 'note').trim().toLowerCase(), c.getAttribute('noteId') as string)
        walk(c)
      }
    }
    walk(getContent(doc))
    const titles = new Map<string, string>()
    getNotes(sync.getDoc(WORKSPACE_DOC) ?? new Y.Doc()).forEach((m, id) => {
      const n = readNote(m)
      if (!n.trashedAt && n.title) titles.set(n.title.trim().toLowerCase(), id)
    })
    // drawings (and ink on pictures) live beside the content: copy their strokes over too
    const inks = new Set<string>()
    const ctx: Partial<Ctx> = {
      blockFor: (t) => {
        const el = originals.get(t)
        if (!el) return null
        const ink = el.getAttribute('drawingId') as string | undefined
        if (ink) inks.add(ink)
        return el.clone()
      },
      dueFor: (date) => dues.get(date) ?? null,
      noteFor: (t) => links.get(t.trim().toLowerCase()) ?? titles.get(t.trim().toLowerCase()) ?? null,
    }
    // a redo replaces the compiled note's contents; otherwise a new note next to the original
    const previous = job.input.replace ? jobs.get(job.input.replace as string)?.result?.noteId : null
    const ws = sync.getDoc(WORKSPACE_DOC)
    let target = typeof previous === 'string' && ws && getNotes(ws).has(previous) ? previous : null
    if (!target) {
      const folderId = ws ? (readNote(getNotes(ws).get(noteId) ?? new Y.Map()).folderId ?? null) : null
      await sync.change(WORKSPACE_DOC, (w) => {
        target = createNote(w, { folderId, title: `${title || 'Untitled'} (compiled)` })
      })
    }
    await sync.change(noteDocName(target!), (d) => {
      const frag = getContent(d)
      if (frag.length) frag.delete(0, frag.length)
      const nodes = markdownToNodes(markdown, { attach: () => null, noteFor: () => null, ...ctx })
      if (nodes.length) frag.insert(0, nodes)
      const meta = getDrawingMeta(doc)
      for (const id of inks) {
        const strokes = getStrokes(d, id)
        if (strokes.length) strokes.delete(0, strokes.length)
        strokes.push(getStrokes(doc, id).toArray().map((st) => ({ ...st, pts: [...st.pts] })))
        if (meta.has(id)) getDrawingMeta(d).set(id, { ...meta.get(id)! })
        const t = getTranscripts(doc).get(id)
        if (t) getTranscripts(d).set(id, t)
      }
    })
    const out = sync.getDoc(noteDocName(target!))
    if (out) {
      const ex = extractNote(out)
      await sync.change(WORKSPACE_DOC, (w) =>
        updateNote(w, target!, { title: ex.title || `${title || 'Untitled'} (compiled)`, snippet: ex.snippet, tags: ex.tags, links: ex.links, trashedAt: null }),
      )
    }
    replaced(job)
    // lines the model made up and the check took out, so you can see them
    return { result: { noteId: target!, sourceNoteId: noteId, ...(dropped.length ? { removedLines: dropped.slice(0, 20) } : {}) } }
  })

  // background work, so everything the server does shows in the list
  jobs.register('recognise', async (job) => {
    const { noteId, drawingId } = job.input as { noteId: string; drawingId: string }
    const { text, agent } = await sync.recogniseDrawing(noteId, drawingId)
    return { result: { noteId, text: preview(text) }, agent }
  })

  jobs.register('embed', async (job) => {
    const noteId = String(job.input.noteId)
    const meaning = sync.meaning
    const doc = sync.getDoc(noteDocName(noteId))
    if (!meaning?.available || !doc) return { result: { skipped: true } }
    const ex = extractNote(doc)
    const full = extractNote(doc, store.attachmentTexts(ex.attachments))
    const made = await meaning.indexNote(noteId, full.title, full.text)
    return { result: { noteId, passages: made } }
  })

  jobs.register('benchmark', async () => {
    if (!samples) throw new Error('The test bench isn’t available.')
    const results = await runBench(ai, samples, reportProgress)
    const best = results[0]
    return { result: { results, text: best ? `Best: ${best.name} (${best.model}) – ${best.accuracy}% right, ${best.avgSeconds}s each` : '' } }
  })

  jobs.register('extract-text', async (job) => {
    const att = store.getAttachment(String(job.input.attachmentId))
    if (!att || att.text_status !== 'pending') return { result: { skipped: true } }
    await processAttachment(config, store, ai, sync, att)
    const after = store.getAttachment(att.id)
    if (after?.text_status === 'error') throw new Error('Could not read this file (see the server log).')
    return { result: { attachmentId: att.id, text: preview(after?.text ?? '') } }
  })
}

/** Remove what a job wrote into notes (or move a compiled note to Recently Deleted). */
export async function removeJobResult(sync: SyncEngine, jobs: Jobs, job: Job) {
  if (job.kind === 'compile') {
    const id = job.result?.noteId
    if (typeof id === 'string') await sync.change(WORKSPACE_DOC, (w) => updateNote(w, id, { trashedAt: Date.now() }))
  } else if (job.noteId) {
    await sync.change(noteDocName(job.noteId), (doc) => {
      removeTagged(getContent(doc), job.id)
    })
  }
  jobs.setResult(job.id, { ...(job.result ?? {}), removed: true })
}

/** The note in reading order (drawings and pictures as images), compiled to Markdown by the AI. */
export async function compileMarkdown(store: Store, ai: Ai, doc: Y.Doc): Promise<{ markdown: string; title: string; dropped: string[] }> {
  // recordings, files, pictures and drawings go through as marker lines that become them again
  const markers: string[] = []
  const md = noteToMarkdown(doc, {
    drawingPlaceholder: (id) => `\u0000DRAWING:${id}\u0000`,
    imagePlaceholder: (id) => `\u0000IMAGE:${id}\u0000`,
    attachmentPlaceholder: (kind, id) => {
      markers.push(compileMarker(kind, id))
      return compileMarker(kind, id)
    },
  })
    // the drawing is read again (or seen) as part of compiling: no need for its old transcript too
    .replace(/(\u0000DRAWING:[a-z0-9]+\u0000)\n> ✍️[^\n]*(?:\n> [^\n]*)*/g, '$1')
  const parts: CompilePart[] = []
  for (const piece of md.split(/\u0000/)) {
    const m = /^(DRAWING|IMAGE):([a-z0-9]+)$/.exec(piece)
    if (!m) {
      parts.push({ text: piece })
    } else if (m[1] === 'DRAWING') {
      const strokes = getStrokes(doc, m[2]).toArray()
      const png = renderDrawingPng(strokes)
      if (png) {
        parts.push({ image: png, mime: 'image/png', kind: 'drawing', strokes, id: m[2] })
        markers.push(compileMarker('drawing', m[2]))
      }
    } else {
      markers.push(compileMarker('image', m[2]))
      const att = store.getAttachment(m[2])
      if (att && isAiImage(att.mime) && store.hasBlob(att.id)) {
        parts.push({ image: fs.readFileSync(store.blobPath(att.id)), mime: att.mime, kind: 'photo', id: m[2] })
      } else parts.push({ text: `\n${compileMarker('image', m[2])}\n(picture not on the server yet)\n` })
    }
  }
  const note = extractNote(doc)
  const links = [...md.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1])
  const { markdown, dropped } = await ai.compile(parts)
  return { markdown: keepCompileExtras(markdown, markers, note.tags, links), title: note.title, dropped }
}
