import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/store'
import { listAllChats, markChatSeen, saveTurn } from '../src/askHistory'

const turn = (question: string, at: number) => ({ question, answer: 'An answer.', sources: [], at })

describe('unread chats', () => {
  it('counts the answers since the chat was last read', () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-askh-')))
    saveTurn(store, 'chat1', { question: 'one' }, turn('one', 1000))
    expect(listAllChats(store)[0]).toMatchObject({ id: 'chat1', questions: 1, unread: 1 })
    markChatSeen(store, 'chat1')
    expect(listAllChats(store)[0].unread).toBe(0)
    saveTurn(store, 'job2', { question: 'two', thread: 'chat1' }, turn('two', 2000))
    saveTurn(store, 'job3', { question: 'three', thread: 'chat1' }, turn('three', 3000))
    expect(listAllChats(store)[0]).toMatchObject({ questions: 3, unread: 2 })
    markChatSeen(store, 'chat1')
    expect(listAllChats(store)[0].unread).toBe(0)
  })
})
