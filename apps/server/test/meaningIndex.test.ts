import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MeaningIndex } from '../src/semantic'

describe('search by meaning: which notes still need indexing', () => {
  it('an empty note, once looked at, isn’t asked for again – until it has words', async () => {
    const db = new Database(':memory:')
    const agent = { kind: 'ollama', baseUrl: 'http://x', model: 'nomic-embed-text' }
    const agents = {
      available: () => true,
      chain: () => [agent],
      run: async (_t: string, fn: (b: unknown, a: unknown) => Promise<unknown>) => ({ result: await fn({ embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) }, agent), agent }),
    }
    const index = new MeaningIndex({ db } as never, agents as never)
    expect(index.notesNeedingVectors(['empty', 'full'])).toEqual(['empty', 'full'])
    await index.indexNote('empty', '', '')
    expect(index.notesNeedingVectors(['empty', 'full'])).toEqual(['full'])
    // removed (or given words later): looked at again
    index.removeNote('empty')
    expect(index.notesNeedingVectors(['empty'])).toEqual(['empty'])
  })
})

describe('related notes', () => {
  it('a long note touching on everything (a meeting) isn’t related to everything; a note on the same subject is', () => {
    const db = new Database(':memory:')
    const agent = { kind: 'ollama', baseUrl: 'http://x', model: 'nomic-embed-text' }
    const index = new MeaningIndex({ db } as never, { available: () => true, chain: () => [agent] } as never)
    const model = `${agent.kind}|${agent.baseUrl}|${agent.model}`
    const D = 12
    const unit = (v: number[]) => {
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    }
    // a subject: its own direction, plus a little of what all notes share
    const about = (k: number, extra: number[] = []) => unit(Array.from({ length: D }, (_, i) => (i === k ? 1 : 0.25) + (extra[i] ?? 0)))
    const ins = db.prepare('INSERT INTO note_vectors (note_id, chunk, text_hash, model, passage, vec) VALUES (?, ?, ?, ?, ?, ?)')
    const add = (id: string, passages: [string, number[]][]) =>
      passages.forEach(([text, v], i) => ins.run(id, i, `${id}-${i}`, model, text, Buffer.from(new Float32Array(v).buffer)))

    add('prompts', [['Claude prompts that are READY: refactor prompt, review prompt, migration checklist for the sandbox agents', about(0)]])
    add('prompts2', [['More Claude prompts: a review prompt for pull requests and a refactor prompt for the sandbox', about(0, [0, 0.1])]])
    // the work meeting: a dozen subjects, one of them the prompts
    add(
      'meeting',
      Array.from({ length: 11 }, (_, k): [string, number[]] => [
        k === 0 ? 'Work meeting: Sam asked about the Claude prompts for the sandbox agents review' : `Work meeting: budget item ${k}, the warehouse schedule and vendor contracts`,
        about(k),
      ]),
    )
    for (let k = 1; k < D; k++) add(`other${k}`, [[`Notes about subject ${k}: warehouse schedule, vendor contracts and budget lines number ${k}`, about(k)]])

    const ids = index.related('prompts').map((h) => h.noteId)
    expect(ids).toContain('prompts2')
    expect(ids).not.toContain('meeting')
  })
})
