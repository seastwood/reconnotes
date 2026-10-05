/**
 * Guards against a common failure of small models: getting stuck repeating
 * the same words ("Seth Seth Seth …") until they hit their output limit.
 */

/** Collapse runaway repetition: repeated lines, and a phrase repeated many times in a row. */
export function collapseRepeats(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    // the same non-empty line again and again → keep it once
    if (t && out.length && out[out.length - 1].trim() === t) continue
    out.push(collapseLine(line))
  }
  return out.join('\n')
}

function collapseLine(line: string): string {
  const indent = /^\s*/.exec(line)![0]
  const words = line.trim().split(/\s+/).filter(Boolean)
  if (words.length < 4) return line
  const res: string[] = []
  let i = 0
  while (i < words.length) {
    let jumped = false
    for (let p = 1; p <= 12 && i + 3 * p <= words.length; p++) {
      let k = 1
      while (i + (k + 1) * p <= words.length && same(words, i, i + k * p, p)) k++
      // one word repeated 4+ times, or a phrase repeated 3+ times
      if ((p === 1 && k >= 4) || (p > 1 && k >= 3)) {
        res.push(...words.slice(i, i + p))
        i += k * p
        jumped = true
        break
      }
    }
    if (!jumped) res.push(words[i++])
  }
  return indent + res.join(' ')
}

function same(w: string[], a: number, b: number, n: number): boolean {
  for (let j = 0; j < n; j++) if (w[a + j].toLowerCase() !== w[b + j].toLowerCase()) return false
  return true
}
