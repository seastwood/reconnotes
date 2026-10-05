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
