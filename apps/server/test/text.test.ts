import { describe, expect, it } from 'vitest'
import { collapseRepeats } from '../src/text'

describe('collapseRepeats', () => {
  it('collapses a word repeated over and over', () => {
    expect(collapseRepeats(Array(200).fill('Seth').join(' '))).toBe('Seth')
  })
  it('collapses a repeated phrase and keeps what follows', () => {
    expect(collapseRepeats('Hello I am groot I am groot I am groot')).toBe('Hello I am groot')
  })
  it('collapses repeated lines and keeps list indentation', () => {
    expect(collapseRepeats('- Buy milk\n- Buy milk\n- Buy milk\n  - eggs eggs eggs eggs eggs')).toBe('- Buy milk\n  - eggs')
  })
  it('leaves normal text alone', () => {
    const t = 'Leadership Meeting 9/3/26\n\n- Sprint goals - offer thoughts\n- ha ha\n- that that is'
    expect(collapseRepeats(t)).toBe(t)
  })
})

import { cleanOcrLine, cleanOcrText, unwrapModelOutput } from '../src/text'

describe('cleaning OCR model output', () => {
  // what GLM-OCR actually returned for the line "Seth"
  const looped = '```markdown\nSeth\n```\n' + Array(20).fill('Seh\n```\n').join('')

  it('takes the first fenced answer and ignores the loop after it', () => {
    expect(cleanOcrLine(looped)).toBe('Seth')
    expect(cleanOcrLine('Seh ```markdown Seth ``` Seh ```Seh``` Seh ```Seh```')).toBe('Seth')
  })

  it('strips labels, chat tokens and quotes from a line', () => {
    expect(cleanOcrLine('markdown\nHello<|im_end|>')).toBe('Hello')
    expect(cleanOcrLine('"I am groot"')).toBe('I am groot')
    expect(cleanOcrLine('Hello Hello Hello Hello Hello')).toBe('Hello')
  })

  it('collapses loops that alternate between lines', () => {
    expect(cleanOcrText('Seh\n---\nSeh\n---\nSeh\n---\nSeh\n---')).toBe('Seh\n---')
  })

  it('keeps normal multi-line answers intact', () => {
    const md = '# Leadership Meeting\n\n- Sprint goals\n  - how?'
    expect(cleanOcrText(md)).toBe(md)
    expect(unwrapModelOutput('```markdown\n' + md + '\n```')).toBe(md)
  })
})
