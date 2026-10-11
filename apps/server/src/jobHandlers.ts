import crypto from 'node:crypto'
import { log } from './log'
import { snapshotNow } from './versions'
import { addListenLinks, type ByMeaning } from './listen'
import { likeness, pointText } from './meetingMeaning'
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
  parseWordTimes,
  labelledTranscript,
  parseSpeakerNames,
  speakerNamesKey,
  speakerAt,
  attendeeCount,
  speakerTurns,
  mergeMinorVoices,
  voiceCount,
} from '@reconnotes/core'
import type { Config } from './config'
import type { Store } from './store'
import type { SyncEngine } from './sync'
import { Ai, compileMarker, isAiImage, keepCompileExtras, renderDrawingPng, type CompilePart } from './ai'
import { askGeneral, askNotes } from './ask'
import { tidyNote } from './tidy'
import { recipeFromPhotos } from './photoRecipe'
import { PAGE_KINDS, guessKind, notesFromPhotos, readForGuess, type PhotoKind } from './photoPages'
import { attendeesFor, groupOfAttachment, heardWith, processAttachment, setHeardWith, APPLE_SPEECH, sentWordTimes, setSpeakers, setTranscribedBy, setWordTimes, speakerSegments, speakersThreshold, transcribedBy, wordTimes } from './attachments'
import { diarize, diarizeAvailable } from './diarize'
import type { Job, Jobs } from './jobs'
import { reportProgress } from './jobs'
import { runBench, type Samples } from './bench'
import { SPEAKER_THRESHOLD, type AiTask } from './agents'
import { recogniseVoices, setRecordingVoices, setSeenNames, type Voices } from './voices'
import { guessedWords } from './vocabulary'
import { dueDateIn, todayLabel } from './timeRange'
import { scopeFromInput } from './access'
import type { AskTurn } from './ask'
import { buildDigest, digestFolder } from './digest'
import { markdownToNodes, type Ctx } from './importNotes'
import { attendeeNames, meetingNotesText } from './meetingNotes'
import { askRefs, saveTurn, setAskRefs } from './askHistory'
import { adoptImport, importWebPages, importsFor, refreshImport } from './webImport'

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
  meeting: 'Meeting notes',
  digest: 'Weekly digest',
  'web-import': 'Import a web page',
  'web-refresh': 'Check imported pages for updates',
  'page-tidy': 'Tidy with AI',
  'recipe-photos': 'Recipe from photos',
  'photo-pages': 'Note from photos',
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

/** what a block a job wrote says (its fingerprint left out), to tell later whether you changed it */
const blockPrint = (el: Y.XmlElement) =>
  crypto
    .createHash('sha1')
    // the words and their structure (and ticked to-dos) – not attributes the app may add on its own
    .update(el.toString().replace(/ (?!checked=)[\w-]+="[^"]*"/g, ''))
    .digest('hex')
    .slice(0, 16)

const LIST = /^(bulletlist|orderedlist|tasklist)$/i

/**
 * Remove the blocks a job wrote, for its redo; returns where the first one was. A block you've
 * changed since – a bullet reworded, a to-do added to its checklist – stays: it's yours now
 * (no longer the job's), and the new result goes in before it. Results written before blocks
 * had fingerprints are replaced as before.
 */
function removeTagged(frag: Y.XmlFragment, jobId: string): Spot | null {
  let first: Spot | null = null
  const fingerprinted = Boolean(find(frag, (el) => el.getAttribute('job') === jobId && Boolean(el.getAttribute('jobHash'))))
  for (;;) {
    const spot = find(frag, (el) => el.getAttribute('job') === jobId)
    if (!spot) return first
    const el = spot.parent.get(spot.index) as Y.XmlElement
    const hash = el.getAttribute('jobHash')
    if (fingerprinted && (!hash || hash !== blockPrint(el))) {
      // edited: kept as yours – of a list, only the items you added, ticked or changed
      el.removeAttribute('job')
      el.removeAttribute('jobHash')
      if (LIST.test(el.nodeName)) {
        for (let i = el.length - 1; i >= 0; i--) {
          const item = el.get(i)
          if (!(item instanceof Y.XmlElement)) continue
          const h = item.getAttribute('jobHash')
          if (h && h === blockPrint(item)) el.delete(i, 1)
          else item.removeAttribute('jobHash')
        }
        if (!el.length) {
          spot.parent.delete(spot.index, 1)
          first ??= spot
          continue
        }
      }
      first ??= spot
      continue
    }
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
  // a redo: the note as it was kept in its history first (Note › History), whatever happens next
  if (replace && versionStore) {
    const before = sync.getDoc(noteDocName(noteId))
    if (before) snapshotNow(versionStore, noteDocName(noteId), before, 'Before a redo')
  }
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
    // each block's fingerprint as written: a redo can tell what you've changed since
    for (const n of nodes) {
      n.setAttribute('jobHash', blockPrint(n))
      // a list's items too: a redo keeps just the ones you've touched
      if (LIST.test(n.nodeName)) for (const item of n.toArray()) if (item instanceof Y.XmlElement) item.setAttribute('jobHash', blockPrint(item))
    }
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

/** The jobs whose results are in a note (the job its blocks are marked with), and its recordings. */
function inNote(doc: Y.Doc): { jobs: Set<string>; recordings: number } {
  const jobs = new Set<string>()
  let recordings = 0
  const walk = (el: Y.XmlElement | Y.XmlFragment) => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue
      const job = c.getAttribute('job')
      if (typeof job === 'string' && job) jobs.add(job)
      if (c.nodeName === 'audio') recordings++
      walk(c)
    }
  }
  walk(getContent(doc))
  return { jobs, recordings }
}

/** A copy of a note without the blocks jobs wrote into it (marked with their job). */
function withoutAiResults(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  const frag = getContent(copy)
  for (let i = frag.length - 1; i >= 0; i--) {
    const el = frag.get(i)
    if (el instanceof Y.XmlElement && el.getAttribute('job')) frag.delete(i, 1)
  }
  return copy
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
  meeting: 'audio',
  digest: 'compile',
  'web-import': null,
  'web-refresh': null,
  'page-tidy': 'compile',
  'recipe-photos': 'images',
  'photo-pages': 'images',
}

/** a voice heard for less than this (seconds, or share of all the talk) isn't one of the meeting's main voices */
const MINOR_SECONDS = 30
const MINOR_SHARE = 0.03
/** …and is taken for the main voice it's at least this like (TitaNet; the same room makes everyone sound a bit alike – main voices of different people scored 0.34–0.84 there) */
const SOUNDS_LIKE = 0.6
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)

/**
 * Voices heard for a moment folded into the ones around them (mergeMinorVoices) – and what each
 * remaining voice sounds like carried over to its new number (from the one that spoke the most).
 */
export function mergeVoices(
  found: { start: number; end: number; speaker: number }[],
  voices: Voices,
  most = 0,
): { segments: { start: number; end: number; speaker: number }[]; voices: Voices } {
  // a voice heard for a short while that sounds like one of the main voices is that person, split
  // off (in a real meeting, a 21-minute one, the service found 28 voices for about 6 people)
  const talked = new Map<number, number>()
  for (const s of found) talked.set(s.speaker, (talked.get(s.speaker) ?? 0) + s.end - s.start)
  const total = [...talked.values()].reduce((a, b) => a + b, 0)
  const minor = (v: number) => (talked.get(v) ?? 0) < Math.max(MINOR_SECONDS, total * MINOR_SHARE)
  const main = [...talked.keys()].filter((v) => !minor(v) && voices[v])
  const into = new Map<number, number>()
  for (const v of talked.keys()) {
    if (!minor(v) || !voices[v] || !main.length) continue
    const [best] = main.map((m) => ({ m, sim: dot(voices[v], voices[m]) })).sort((a, b) => b.sim - a.sim)
    if (best.sim >= SOUNDS_LIKE) into.set(v, best.m)
  }
  found = found.map((s) => (into.has(s.speaker) ? { ...s, speaker: into.get(s.speaker)! } : s))
  // at most as many voices as people were there: the one heard least joins the voice it sounds
  // most like, until there are that many. (Not asked of the service: told a number, it forces that
  // many groups – noise takes some, and real people are lumped together.)
  if (most > 0) {
    for (;;) {
      const talk = new Map<number, number>()
      for (const s of found) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + s.end - s.start)
      if (talk.size <= most) break
      const [least] = [...talk.keys()].sort((a, b) => talk.get(a)! - talk.get(b)!)
      const others = [...talk.keys()].filter((v) => v !== least)
      // by how it sounds; without that, the voice speaking most
      const target = voices[least]
        ? others.filter((v) => voices[v]).sort((a, b) => dot(voices[least], voices[b]) - dot(voices[least], voices[a]))[0]
        : undefined
      const to = target ?? others.sort((a, b) => talk.get(b)! - talk.get(a)!)[0]
      found = found.map((s) => (s.speaker === least ? { ...s, speaker: to } : s))
    }
  }
  // then what's still only a few seconds goes to whoever was speaking around it
  const segments = mergeMinorVoices(found)
  const talk = new Map<number, number>()
  const longest = new Map<number, { start: number; end: number }>()
  for (const s of found) {
    talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + s.end - s.start)
    const l = longest.get(s.speaker)
    if (!l || s.end - s.start > l.end - l.start) longest.set(s.speaker, s)
  }
  const out: Voices = {}
  const by = new Map<number, number>()
  for (const [k, vec] of Object.entries(voices)) {
    const old = Number(k)
    const l = longest.get(old)
    if (!l) continue
    const now = speakerAt(segments, (l.start + l.end) / 2)
    if (now === null) continue
    if (!by.has(now) || (talk.get(old) ?? 0) > (talk.get(by.get(now)!) ?? 0)) {
      by.set(now, old)
      out[now] = vec
    }
  }
  return { segments, voices: out }
}

/** for snapshots before a redo replaces a result */
let versionStore: Store | null = null

export function registerJobHandlers(config: Config, store: Store, sync: SyncEngine, ai: Ai, jobs: Jobs, samples?: Samples) {
  versionStore = store

  /**
   * A recording's turns by voice: kept from before, or asked of the speaker-label service
   * (deploy/diarize.py) – for a new reading of it always, since its words have new times, and
   * when the speaker-label setting changed since they were told apart.
   * None when there's no service: the transcript is then just without speakers.
   */
  const speakerTurnsFor = async (att: { id: string; mime: string }, words: { word: string; start: number; end: number }[], newReading: boolean, most: number) => {
    const threshold = ai.agents.settings().speakerThreshold
    const was = speakersThreshold(store, att.id)
    const kept = newReading ? null : speakerSegments(store, att.id)
    // told apart again when the setting changed (voices told apart before it existed were at its
    // default), or how many people were there did (you said, or changed it, since)
    const wasMost = store.getSetting<number>(`speakersMost:${att.id}`) ?? 0
    let segments = kept && (was ?? SPEAKER_THRESHOLD) === threshold && wasMost === most ? kept : null
    if (!segments) {
      const speech = ai.agents.chain('audio').find((a) => a.kind === 'openai' && a.enabled)
      let voices: Voices = {}
      if (speech && store.hasBlob(att.id) && (await diarizeAvailable(speech.baseUrl))) {
        reportProgress('Telling the voices apart…')
        const found = await diarize(speech.baseUrl, fs.readFileSync(store.blobPath(att.id)), threshold)
        if (found) ({ segments, voices } = mergeVoices(found.segments, found.voices, most))
      }
      // the service couldn't be asked again: the voices as they were
      if (!segments && kept && !newReading) segments = kept
      else if (segments || newReading) {
        setSpeakers(store, att.id, segments, threshold)
        store.setSetting(`speakersMost:${att.id}`, most)
        // new turns, new numbers: the voices named again – by who they sound like (people you've
        // named in other recordings), where the service says what each one sounds like
        if (segments && Object.keys(voices).length) {
          setRecordingVoices(store, att.id, voices)
          // (only people named in this recording's group: its note's top-level folder)
          const names = recogniseVoices(store, voices, groupOfAttachment(store, sync, att.id), (a) => groupOfAttachment(store, sync, a))
          const json = Object.keys(names).length ? JSON.stringify(names) : null
          setSeenNames(store, att.id, Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v])))
          for (const noteId of store.notesReferencing(att.id)) {
            await sync.change(noteDocName(noteId), (d) => {
              const tr = getTranscripts(d)
              if (json) tr.set(speakerNamesKey(att.id), json)
              else tr.delete(speakerNamesKey(att.id))
            })
          }
          if (Object.keys(names).length) log.info(`recognised by voice: ${Object.values(names).join(', ')}`)
        } else setRecordingVoices(store, att.id, null)
        sync.reindexNotesFor(att.id)
      }
    }
    return segments?.length ? speakerTurns(words, segments) : null
  }

  /**
   * Where each point of the notes was talked about, by meaning: the recording in stretches of
   * about half a minute (70 words, every 35), and how like each stretch each point is. Undefined
   * without an embedding model – the ▶ links are then placed by shared words alone.
   */
  const meaningOfPoints = async (md: string, words: { word: string; start: number; end: number }[]): Promise<ByMeaning | undefined> => {
    const embed = ai.embedder()
    if (!embed || words.length < 8) return undefined
    try {
      const wins: { start: number; text: string }[] = []
      for (let from = 0; from < words.length; from += 35) {
        const to = Math.min(words.length, from + 70)
        wins.push({ start: words[from].start, text: words.slice(from, to).map((w) => w.word.trim()).join(' ') })
        if (to === words.length) break
      }
      const vecs = await embed(wins.map((w) => w.text), 'document')
      const lines = md.split('\n')
      const at = lines.flatMap((l, i) => (/^\s*(?:[-*]|\d+[.)])\s/.test(l) && pointText(l) ? [i] : []))
      const sims = await likeness(at.map((i) => pointText(lines[i])), vecs, embed)
      const per: (number[] | null)[] = lines.map(() => null)
      at.forEach((li, k) => (per[li] = sims[k]))
      return { starts: wins.map((w) => w.start), sims: per }
    } catch (e) {
      log.warn(`placing the ▶ links by meaning failed (${(e as Error).message}) – by shared words`)
      return undefined
    }
  }

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
  /** a note's title, preview and tags in the list, after a job changed it */
  const refreshNoteMeta = async (noteId: string) => {
    const d = sync.getDoc(noteDocName(noteId))
    if (!d) return
    const ex = extractNote(d)
    await sync.change(WORKSPACE_DOC, (ws) => updateNote(ws, noteId, { title: ex.title, snippet: ex.snippet, tags: ex.tags, links: ex.links }))
  }
  const noteDoc = (noteId: unknown) => {
    const doc = typeof noteId === 'string' && /^[a-z0-9]{8,64}$/.test(noteId) ? sync.getDoc(noteDocName(noteId)) : null
    if (!doc) throw new Error('The note no longer exists.')
    return doc
  }

  jobs.register('convert-drawing', async (job) => {
    const { noteId, drawingId, strokeIds } = job.input as { noteId: string; drawingId: string; strokeIds?: string[] }
    noteDoc(noteId)
    const { text, agent, raw } = await sync.recogniseDrawing(noteId, drawingId, { requireText: true, strokeIds: Array.isArray(strokeIds) ? strokeIds.map(String) : undefined })
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

  // "Transcribe" on a recording: its transcript (shown with it, and searched) read again – by the server's
  // speech-to-text when there is one, else the phone's reading (Apple) sent along – and kept with the recording
  jobs.register('transcribe', async (job) => {
    const { noteId, attachmentId } = job.input as { noteId: string; attachmentId: string }
    noteDoc(noteId)
    const att = store.getAttachment(attachmentId)
    if (!att) throw new Error("This recording hasn't reached the server yet – try again once it has synced.")
    const onDevice = String(job.input.transcript ?? '').trim()
    let text: string
    let by: string
    let times: { word: string; start: number; end: number }[] | undefined
    if (ai.agents.available('audio') && !onDevice) {
      if (!store.hasBlob(att.id)) throw new Error("This recording hasn't reached the server yet – try again once it has synced.")
      const people = attendeesFor(store, sync, att.id)
      const r = await ai.transcribeAudio(fs.readFileSync(store.blobPath(att.id)), att.mime, att.name, people, groupOfAttachment(store, sync, att.id))
      setHeardWith(store, att.id, people)
      text = r.text
      by = r.agent
      times = r.words
    } else if (onDevice) {
      text = onDevice
      by = APPLE_SPEECH
      // Apple's word times, sent along (to follow along as it plays)
      times = sentWordTimes(job.input.words) ?? undefined
    } else {
      // no speech-to-text here: the phone reads it (Apple) and sends it back – or there's nothing to read it with
      return { result: { noteId, needsDevice: true } }
    }
    if (!text.trim()) throw new Error('No speech was recognised in this recording.')
    setTranscribedBy(store, att.id, by)
    setWordTimes(store, att.id, times)
    store.setAttachmentText(att.id, text, 'done')
    // who spoke when, for the new words (any recording – a meeting or not)
    if (times?.length) await speakerTurnsFor(att, times, true, attendeeCount(noteToMarkdown(noteDoc(noteId))))
    else setSpeakers(store, att.id, null)
    sync.reindexNotesFor(att.id)
    return { result: { noteId, text: preview(text), heardBy: by }, agent: by }
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
    const tzOffset = Number(job.input.tzOffset)
    const when = { tzOffset: Number.isFinite(tzOffset) && Math.abs(tzOffset) <= 14 * 60 ? tzOffset : undefined }
    const question = String(job.input.question ?? '').slice(0, 1000)
    // "Anything": the AI's own answer, not from the notes (a recipe for the Recipes folder)
    const r: Awaited<ReturnType<typeof askNotes>> & { general?: boolean } =
      job.input.mode === 'general'
        ? await askGeneral(ai, question, when, historyFromInput(job.input.history))
        : await askNotes(store, sync, ai, question, sync.meaning, when, scopeFromInput(job.input), historyFromInput(job.input.history))
    // kept as a conversation (to read again, or carry on, from "Ask about this note")
    saveTurn(store, job.id, job.input, {
      question: String(job.input.question ?? ''),
      answer: r.answer,
      sources: r.sources,
      ...(r.cites ? { cites: r.cites } : {}),
      ...(r.read ? { read: r.read } : {}),
      ...(r.general ? { general: true } : {}),
      at: Date.now(),
    })
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
    // in the bin (or gone) since it was asked for: nothing to search for
    const m = sync.noteMeta().get(noteId)
    if (!m || m.trashedAt) return (meaning.removeNote(noteId), { result: { skipped: true } })
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

  /**
   * After a meeting recording: its transcript (made on the device, or here)
   * and the notes written meanwhile become a summary, decisions and action
   * items – a checklist with due dates where a day was said.
   */
  // the weekly digest: a new note about the week (see digest.ts)
  jobs.register('digest', async (job) => {
    const tz = Number(job.input.tzOffset) || 0
    const d = await buildDigest(store, sync, ai, job.createdAt, tz)
    let noteId = ''
    await sync.change(WORKSPACE_DOC, (ws) => void (noteId = createNote(ws, { title: d.title, folderId: digestFolder(sync) })))
    await writeResult(sync, noteId, job.id, `# ${d.title}\n\n${d.markdown}`, 'end', null, { noteFor: d.noteFor })
    return { result: { noteId, text: preview(d.markdown) }, agent: d.agent ?? undefined }
  })

  // a web page (and, if asked, the guide's other pages) into notes (see webImport.ts)
  jobs.register('web-import', async (job) => {
    const i = job.input as { url?: string; follow?: boolean; maxPages?: number; folderId?: string | null; pdfAttachmentId?: string; splitPdf?: boolean; askRefFor?: string; tidy?: boolean; recipeArticle?: boolean }
    const r = await importWebPages(config, store, ai, sync, {
      url: String(i.url ?? ''),
      follow: Boolean(i.follow),
      maxPages: Number(i.maxPages) || undefined,
      folderId: i.folderId ?? null,
      pdfAttachmentId: typeof i.pdfAttachmentId === 'string' ? i.pdfAttachmentId : undefined,
      splitPdf: Boolean(i.splitPdf),
      recipeArticle: i.recipeArticle !== false,
    })
    // "Tidy with AI" asked for: each page's note, its website leftovers taken out (tidy.ts)
    if (i.tidy && !i.pdfAttachmentId) {
      const pagesOnly = r.noteIds.length > 1 ? r.noteIds.slice(1) : r.noteIds
      let taken = 0
      for (const [k, id] of pagesOnly.entries()) {
        reportProgress(pagesOnly.length > 1 ? `Tidying note ${k + 1} of ${pagesOnly.length}…` : 'Tidying the note…')
        try {
          const t = await tidyNote(store, sync, ai, id)
          taken += t.removed.length
          await refreshNoteMeta(id)
        } catch (e) {
          r.notes.push(`Couldn’t tidy it: ${(e as Error).message}`)
        }
      }
      r.notes.unshift(taken ? `Tidied: ${taken} block${taken === 1 ? '' : 's'} of website leftovers taken out (the untidied version is in the note’s history).` : 'Tidied: nothing needed taking out.')
    }
    // imported as a document a note refers to: Ask reads it with that note from now on
    if (typeof i.askRefFor === 'string' && i.askRefFor) {
      const imported = r.noteIds.length > 1 ? r.noteIds.slice(1) : r.noteIds
      setAskRefs(store, i.askRefFor, [...askRefs(store, i.askRefFor), ...imported])
    }
    const summary = [
      `${r.pages} page${r.pages === 1 ? '' : 's'}, ${r.pictures} picture${r.pictures === 1 ? '' : 's'}.`,
      ...r.notes.slice(0, 20),
    ].join('\n')
    return { result: { noteId: r.noteIds[0], noteIds: r.noteIds, folderId: r.folderId, pages: r.pages, pictures: r.pictures, notes: r.notes, text: summary } }
  })

  // "Tidy with AI" on a note: its website leftovers taken out, nothing rewritten (tidy.ts)
  jobs.register('page-tidy', async (job) => {
    const noteId = String(job.noteId ?? job.input.noteId ?? '')
    noteDoc(noteId)
    const t = await tidyNote(store, sync, ai, noteId)
    await refreshNoteMeta(noteId)
    const text = t.refused ?? (t.removed.length ? `Took out ${t.removed.length}:\n${t.removed.map((x) => `• ${x}`).join('\n')}` : 'Nothing needed taking out.')
    return { result: { noteId, removed: t.removed, versionId: t.versionId, ...(t.refused ? { refused: t.refused } : {}), text: preview(text) } }
  })

  // a recipe from photos of it (a meal-kit card's front and back, cookbook pages): photoRecipe.ts
  jobs.register('recipe-photos', async (job) => {
    const raw = Array.isArray(job.input.photos) ? (job.input.photos as unknown[]) : []
    const pages = raw
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
      .filter((p) => typeof p.attachmentId === 'string')
      .slice(0, 12)
      .map((p) => ({ attachmentId: String(p.attachmentId), ...(typeof p.text === 'string' ? { text: p.text.slice(0, 20000) } : {}) }))
    const folderId = typeof job.input.folderId === 'string' ? job.input.folderId : null
    const r = await recipeFromPhotos(store, sync, ai, pages, folderId)
    const text = [
      `${r.title}`,
      ...(r.unsure ? [`${r.unsure} amount${r.unsure === 1 ? '' : 's'} to check (dotted underline).`] : []),
      ...(r.left.length ? [`Left out – not found in what was read:`, ...r.left.map((x) => `• ${x}`)] : []),
    ].join('\n')
    return { result: { noteId: r.noteId, title: r.title, left: r.left, unsure: r.unsure, text: preview(text) }, agent: r.agent }
  })

  // a note from photos of pages that aren't a recipe (handwriting, a book, a trail's directions): photoPages.ts
  jobs.register('photo-pages', async (job) => {
    const raw = Array.isArray(job.input.photos) ? (job.input.photos as unknown[]) : []
    const pages = raw
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
      .filter((p) => typeof p.attachmentId === 'string')
      .slice(0, 30)
      .map((p) => ({ attachmentId: String(p.attachmentId), ...(typeof p.text === 'string' ? { text: p.text.slice(0, 20000) } : {}) }))
    const folderId = typeof job.input.folderId === 'string' ? job.input.folderId : null
    // "Auto": read, then worked out what they are (guessKind)
    let kind: PhotoKind | undefined = job.input.kind === 'recipe' ? 'recipe' : PAGE_KINDS.find((k) => k === job.input.kind)
    let guessed: string | undefined
    let reader = ''
    if (!kind) {
      const read = await readForGuess(store, ai, pages)
      pages.splice(0, pages.length, ...read.pages)
      reader = read.agent
      reportProgress('Working out what the photos are…')
      const g = await guessKind(store, ai, pages, pages.map((p) => p.text ?? '').join('\n\n'))
      kind = g.kind
      guessed = g.by
    }
    const agents = (a: string) => [reader, a].filter(Boolean).join(' + ')
    // (what was read, to make it again as another kind without reading it again)
    const read = guessed ? { read: pages } : {}
    if (kind === 'recipe') {
      const r = await recipeFromPhotos(store, sync, ai, pages, folderId)
      const text = [`${r.title} (a recipe${guessed ? ', worked out from ' + guessed : ''})`, ...(r.unsure ? [`${r.unsure} amount${r.unsure === 1 ? '' : 's'} to check (dotted underline).`] : []), ...(r.left.length ? ['Left out – not found in what was read:', ...r.left.map((x) => `• ${x}`)] : [])].join('\n')
      return { result: { noteId: r.noteId, title: r.title, kind, guessed: Boolean(guessed), ...read, left: r.left, unsure: r.unsure, text: preview(text) }, agent: agents(r.agent) }
    }
    const r = await notesFromPhotos(store, sync, ai, pages, kind, folderId)
    const text = [`${r.title} (${kind}${guessed ? ', worked out from ' + guessed : ''})`, ...(r.asRead ? ['Kept as read: the AI’s layout changed the words, so it wasn’t used.'] : [])].join('\n')
    return { result: { noteId: r.noteId, title: r.title, kind, guessed: Boolean(guessed), ...read, asRead: r.asRead, text: preview(text) }, agent: agents(r.agent) }
  })

  // imported pages: fetched again, the changed ones brought up to date (see webImport.ts)
  jobs.register('web-refresh', async (job) => {
    const i = job.input as { noteId?: string; folderId?: string }
    const noteId = i.noteId ?? (job.noteId || undefined)
    const records = importsFor(store, sync, { noteId, folderId: i.folderId })
    // imported before imports were remembered: taken on from its "From …" line
    if (!records.length && noteId) {
      const adopted = await adoptImport(store, sync, noteId)
      if (adopted) records.push(adopted)
    }
    if (!records.length) throw new Error('This wasn’t imported from a web page (or was imported before update checks existed – import it again to get them).')
    const notes: string[] = []
    let changed = 0
    let firstNote: string | undefined
    for (const r of records) {
      const res = await refreshImport(config, store, ai, sync, r)
      notes.push(...res.notes)
      changed += res.changed ?? 0
      firstNote ??= res.noteIds[0]
    }
    return { result: { noteId: firstNote, changed, notes, text: notes.join('\n') } }
  })

  /**
   * Meeting notes written for a recording that was given notes before – by a job no longer among the
   * jobs listed, so its ⋯ menu couldn't ask for a redo: they're replaced, not added to.
   */
  const earlierNotes = (job: Job, noteId: string, attachmentId: string): string | null => {
    const here = inNote(noteDoc(noteId))
    const last = jobs.lastMeeting(noteId, attachmentId, job.id)
    if (last && here.jobs.has(last.id)) {
      jobs.markReplaced(last.id, job.id)
      return last.id
    }
    // written by a job since cleared away: when it's the only one gone and this is the note's only recording
    const gone = [...here.jobs].filter((id) => id !== job.id && !jobs.get(id))
    return gone.length === 1 && here.recordings === 1 ? gone[0] : null
  }

  jobs.register('meeting', async (job) => {
    const { noteId, attachmentId } = job.input as { noteId: string; attachmentId: string }
    const doc = noteDoc(noteId)
    const att = store.getAttachment(String(attachmentId))
    // the phone's own reading (Apple's speech recognition: made for dictation, not a room of people)
    // asked to read the recording again: not the saved transcript, nor the phone's
    const fresh = job.input.retranscribe === true
    const onDevice = fresh ? '' : String(job.input.transcript ?? '').trim()
    // what you wrote – not notes an AI wrote before (a redo would copy them back, ▶ links and all) –
    // and the people you said were there: Whisper spells their names right, and they cap the voices
    const notes = meetingNotesText(noteToMarkdown(withoutAiResults(doc)))
    const attendees = attendeeNames(notes)
    // how many were there: the names, or a number given ("Attendees: 6 people") – the most voices to find
    const people = attendeeCount(notes)
    let transcript = ''
    let agent: string | null = null
    let times: { word: string; start: number; end: number }[] | undefined
    let speechError: string | undefined
    // the server's speech-to-text (Whisper) reads a meeting far better: it comes first when there is one
    const serverHears = ai.agents.available('audio')
    const saved = att?.text_status === 'done' && att.text?.trim() ? att.text : ''
    const savedBy = att ? transcribedBy(store, att.id) : null
    // already read by the server's speech-to-text: that – not the phone's reading, nor one nobody knows the source of
    // …unless it was read without the names of the people there, which were written down since
    const knewNames = !att || attendees.every((n) => heardWith(store, att.id).includes(n))
    if (!fresh && knewNames && serverHears && saved && savedBy && savedBy !== APPLE_SPEECH) (transcript = saved), (agent = savedBy)
    else if (serverHears && att && store.hasBlob(att.id)) {
      reportProgress('Transcribing the recording…')
      try {
        const r = await ai.transcribeAudio(fs.readFileSync(store.blobPath(att.id)), att.mime, att.name, attendees, groupOfAttachment(store, sync, att.id))
        transcript = r.text
        agent = r.agent
        times = r.words
        setHeardWith(store, att.id, attendees)
      } catch (e) {
        if (!onDevice && !saved) throw e
        // the phone's reading instead – and the job says why
        speechError = (e as Error).message
        log.warn(`meeting "${job.title}": the server's speech-to-text failed, using the phone's reading – ${speechError}`)
      }
    }
    if (!transcript) {
      transcript = onDevice || saved
      // the phone's reading, with the word times it sent
      if (transcript === onDevice) times = sentWordTimes(job.input.words) ?? undefined
    }
    if (!transcript) {
      if (!att || !store.hasBlob(att.id)) throw new Error("The recording hasn't reached the server yet – try again once it has synced.")
      const r = await ai.transcribeAudio(fs.readFileSync(store.blobPath(att.id)), att.mime, att.name, attendees, groupOfAttachment(store, sync, att.id))
      transcript = r.text
      agent = r.agent
      times = r.words
    }
    // who heard it: the server's speech-to-text, or the phone (Apple)
    const heardBy = agent ?? (transcript === onDevice ? APPLE_SPEECH : savedBy)
    // the recording becomes searchable by what was said – the better reading replacing the phone's
    if (att && transcript && (transcript !== att.text || (heardBy && heardBy !== savedBy))) {
      if (heardBy) setTranscribedBy(store, att.id, heardBy)
      // a new reading: its word times (none for Apple's)
      if (agent !== savedBy || times) setWordTimes(store, att.id, times)
      store.setAttachmentText(att.id, transcript, 'done')
      sync.reindexNotesFor(att.id)
    }
    const tzOffset = Number(job.input.tzOffset) || 0
    if (!transcript.trim() && !notes.replace(/\W/g, '')) throw new Error('No speech was recognised in this recording, and nothing was written.')
    // who said what: the transcript as turns by voice, named where you've named them
    const said = att ? (times ?? parseWordTimes(wordTimes(store, att.id)) ?? []) : []
    const newReading = Boolean(times) || fresh
    const turns = att && said.length ? await speakerTurnsFor(att, said, newReading, people) : null
    // (read again: telling the voices apart may have just named them – people recognised by voice)
    const names = att ? parseSpeakerNames(getTranscripts(noteDoc(noteId)).get(speakerNamesKey(att.id)) ?? null) : {}
    const voices = turns ? voiceCount(turns) : 0
    const heard = turns && voices >= 2 ? labelledTranscript(turns, names) : transcript
    const r = await ai.meetingNotes(notes, heard, todayLabel(Date.now(), tzOffset), { attendees, people, voices, named: Object.values(names), fresh })
    // "by Friday" → a due date on the to-do (the AI isn't trusted with the calendar)
    const md = r.text
      .split('\n')
      .map((l) => {
        const m = l.match(/^(\s*[-*]\s+\[ \]\s+)(.*)$/)
        if (!m || /!\d{4}-\d{2}-\d{2}/.test(m[2]) || /no action items/i.test(m[2])) return l
        const due = dueDateIn(m[2], Date.now(), tzOffset)
        return due ? `${m[1]}${m[2]} !${due}` : l
      })
      .join('\n')
    // each point with a ▶ link to where it was said in the recording (where words have times)
    const withLinks = att && said.length ? addListenLinks(md, said, att.id, await meaningOfPoints(md, said)).markdown : md
    await writeResult(sync, noteId, job.id, withLinks, 'end', replaced(job) ?? earlierNotes(job, noteId, String(attachmentId)), { dueFor: (date) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : null) })
    return { result: { noteId, text: preview(md), heardBy, ...(voices >= 2 ? { voices } : {}), ...(speechError ? { speechError } : {}), ...(r.draft ? { draft: r.draft } : {}) }, agent: heardBy ? `${heardBy} + ${r.agent}` : r.agent }
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

/** The earlier questions and answers a follow-up sends (at most the last 6). */
function historyFromInput(v: unknown): AskTurn[] {
  if (!Array.isArray(v)) return []
  return v
    .slice(-6)
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
    .map((t) => ({
      question: String(t.question ?? '').slice(0, 1000),
      answer: String(t.answer ?? '').slice(0, 4000),
      sources: Array.isArray(t.sources) ? t.sources.map(String).filter((id) => /^[a-z0-9]{8,64}$/.test(id)).slice(0, 10) : [],
    }))
    .filter((t) => t.question)
}
