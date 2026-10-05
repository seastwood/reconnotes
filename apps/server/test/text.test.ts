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

import { cleanOcrLine, cleanOcrText, stripMath, unwrapModelOutput } from '../src/text'

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

describe('commentary and LaTeX', () => {
  const ramble =
    'Me Me The image contains a single word "Me". It is written in a simple, handwritten style. The text is centered on the page. There are no other visible elements or distractions present in the image. $$Me$$ The image contains a single word "Me". It is written in a simple, handwritten style. $$Me$$ $$Me$$ The image contains a single word "Me".'

  it('reduces a rambling reply to the transcription (line)', () => {
    expect(cleanOcrLine(ramble)).toBe('Me')
  })

  it('reduces a rambling reply to the transcription (page)', () => {
    expect(cleanOcrText(ramble)).toBe('Me')
  })

  it('unwraps LaTeX but keeps prices and normal text', () => {
    expect(stripMath('$$Hello$$ and \\(world\\) \\text{ok}')).toBe('Hello and world ok')
    expect(stripMath('costs $5 and $10')).toBe('costs $5 and $10')
    expect(cleanOcrText('- buy milk\n- pay $20 rent\n- call mum')).toBe('- buy milk\n- pay $20 rent\n- call mum')
  })

  it('leaves genuine repeated words alone when there was no ramble', () => {
    expect(cleanOcrLine('bye bye')).toBe('bye bye')
    expect(cleanOcrText('Todo\n\nTodo')).toBe('Todo\n\nTodo')
  })

  it('removes a "Here is the transcription:" preamble', () => {
    expect(cleanOcrText('Here is the transcription:\nShopping list\n- eggs')).toBe('Shopping list\n- eggs')
  })
})
