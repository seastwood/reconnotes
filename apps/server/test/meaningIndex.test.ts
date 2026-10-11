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
