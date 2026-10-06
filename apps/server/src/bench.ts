import fs from 'node:fs'
import * as Y from 'yjs'
import { getContent, getStrokes, newId, noteDocName } from '@reconnotes/core'
import type { Store } from './store'
import { levenshtein } from './store'
import type { SyncEngine } from './sync'
import { renderDrawingPng, isAiImage, type Ai } from './ai'
import { makeBackend, type AgentConfig } from './agents'
import type { Job, Jobs } from './jobs'
import { reportAgent } from './jobs'

/**
 * Model test bench
 * ================
 *
 * Samples of your own handwriting with the correct text (saved from a
 * conversion you've checked and corrected). "Run test" has every
 * image-reading agent read each sample and scores it: how close its reading
 * is to the right text, and how long it took – so you choose models by how
 * they do on *your* handwriting.
 */

export interface Sample {
  id: string
  title: string
  truth: string
  createdAt: number
}

export interface BenchResult {
  agentId: string
  name: string
  model: string
  /** 0–100: how close the readings were to the right text, on average */
  accuracy: number
  avgSeconds: number
  errors: number
  /** each sample: its title, the score and what was read */
  samples: { title: string; accuracy: number; text: string; error?: string }[]
}

/** Letters and digits only, lower case, single-spaced – so formatting and punctuation don't count. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** 100 = identical words, 0 = nothing in common (character edit distance). */
export function readingScore(read: string, truth: string): number {
  const a = norm(read)
  const b = norm(truth)
  if (!a && !b) return 100
  const d = levenshtein(a.slice(0, 4000), b.slice(0, 4000))
  return Math.max(0, Math.round((1 - d / Math.max(a.length, b.length, 1)) * 1000) / 10)
}

export class Samples {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_samples (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        image BLOB NOT NULL,
        mime TEXT NOT NULL,
        truth TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  list(): Sample[] {
    return (this.store.db.prepare('SELECT id, title, truth, created_at FROM ai_samples ORDER BY created_at').all() as { id: string; title: string; truth: string; created_at: number }[]).map((r) => ({
      id: r.id,
      title: r.title,
      truth: r.truth,
      createdAt: r.created_at,
    }))
  }

  image(id: string): { image: Buffer; mime: string } | null {
    return (this.store.db.prepare('SELECT image, mime FROM ai_samples WHERE id = ?').get(id) as { image: Buffer; mime: string } | undefined) ?? null
  }

  add(title: string, image: Buffer, mime: string, truth: string): Sample {
    const id = newId()
    const createdAt = Date.now()
    this.store.db.prepare('INSERT INTO ai_samples (id, title, image, mime, truth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title.slice(0, 120), image, mime, truth, createdAt)
    return { id, title, truth, createdAt }
  }

  setTruth(id: string, truth: string) {
    this.store.db.prepare('UPDATE ai_samples SET truth = ? WHERE id = ?').run(truth, id)
  }

  remove(id: string) {
    this.store.db.prepare('DELETE FROM ai_samples WHERE id = ?').run(id)
  }

  /**
   * A sample from a finished conversion: the drawing or picture it read, and
   * the text as it is in the note now (with your corrections) as the right answer.
   */
  fromJob(job: Job, sync: SyncEngine, jobs: Jobs): Sample {
    if (job.status !== 'done' || (job.kind !== 'convert-drawing' && job.kind !== 'convert-picture') || !job.noteId) throw new Error('Only a finished “Convert to text” can be saved as a test sample.')
    const doc = sync.getDoc(noteDocName(job.noteId))
    if (!doc) throw new Error('The note no longer exists.')
    let image: Buffer | null = null
    let mime = 'image/png'
    if (job.kind === 'convert-drawing') image = renderDrawingPng(getStrokes(doc, String(job.input.drawingId)).toArray())
    else {
      const file = jobs.filePath(job.id)
      const att = sync.store.getAttachment(String(job.input.attachmentId))
      if (fs.existsSync(file)) {
        image = fs.readFileSync(file)
        mime = String(job.input.mime ?? 'image/jpeg')
      } else if (att && sync.store.hasBlob(att.id) && isAiImage(att.mime)) {
        image = fs.readFileSync(sync.store.blobPath(att.id))
        mime = att.mime
      }
    }
    if (!image) throw new Error('The handwriting or picture isn’t available any more.')
    // the right answer: the converted text as it reads in the note now
    const parts: string[] = []
    for (const el of getContent(doc).toArray()) if (el instanceof Y.XmlElement && el.getAttribute('job') === job.id) parts.push(textOf(el))
    const truth = parts.join('\n').trim() || String(job.result?.text ?? '')
    if (!truth.trim()) throw new Error('There’s no text to compare with – the converted text was removed.')
    return this.add(`${job.title} (${job.kind === 'convert-drawing' ? 'handwriting' : 'picture'})`, image, mime, truth)
  }
}

function textOf(el: Y.XmlElement | Y.XmlText): string {
  if (el instanceof Y.XmlText) return (el.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('')
  return el
    .toArray()
    .map((c) => (c instanceof Y.XmlElement || c instanceof Y.XmlText ? textOf(c) : ''))
    .join(el.nodeName === 'paragraph' || el.nodeName === 'heading' ? '' : '\n')
}

/** Have every image-reading agent read every sample; best first. */
export async function runBench(ai: Ai, samples: Samples, onProgress: (text: string) => void): Promise<BenchResult[]> {
  const list = samples.list()
  if (!list.length) throw new Error('Save a few test samples first: in Jobs, open a “Handwriting to text” job you’ve checked and corrected, and choose “Save as test sample”.')
  const readers = ai.agents.agents().filter((a: AgentConfig) => a.enabled && a.vision && a.kind !== 'wyoming')
  if (!readers.length) throw new Error('No enabled agent can read images.')
  const out: BenchResult[] = []
  for (const agent of readers) {
    reportAgent(agent.model ? `${agent.name} (${agent.model})` : agent.name)
    const backend = makeBackend(agent)
    const r: BenchResult = { agentId: agent.id, name: agent.name, model: agent.model, accuracy: 0, avgSeconds: 0, errors: 0, samples: [] }
    let seconds = 0
    for (const [i, s] of list.entries()) {
      onProgress(`${agent.name}: sample ${i + 1} of ${list.length}`)
      const img = samples.image(s.id)!
      const t = Date.now()
      try {
        const text = await ai.transcribeWith(backend, agent, img.image, { mime: img.mime, photo: img.mime !== 'image/png', noCache: true })
        seconds += (Date.now() - t) / 1000
        r.samples.push({ title: s.title, accuracy: readingScore(text, s.truth), text: text.slice(0, 2000) })
      } catch (e) {
        seconds += (Date.now() - t) / 1000
        r.errors++
        r.samples.push({ title: s.title, accuracy: 0, text: '', error: (e as Error).message.slice(0, 300) })
      }
    }
    r.accuracy = Math.round((r.samples.reduce((a, b) => a + b.accuracy, 0) / r.samples.length) * 10) / 10
    r.avgSeconds = Math.round((seconds / list.length) * 10) / 10
    out.push(r)
  }
  return out.sort((a, b) => b.accuracy - a.accuracy || a.avgSeconds - b.avgSeconds)
}
