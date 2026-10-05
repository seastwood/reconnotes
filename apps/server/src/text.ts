/**
 * Guards against a common failure of small models: getting stuck repeating
 * the same words ("Seth Seth Seth …") until they hit their output limit.
 */

/** Collapse runaway repetition: repeated lines, and a phrase repeated many times in a row. */
export function collapseRepeats(text: string): string {
  const out: string[] = []
  for (const line of collapseLineCycles(text.split('\n'))) {
    const t = line.trim()
    // the same non-empty line again and again → keep it once
    if (t && out.length && out[out.length - 1].trim() === t) continue
    out.push(collapseLine(line))
  }
  return out.join('\n')
}

/** A block of 2–6 lines repeated 3+ times in a row (e.g. "Seh", "```", "Seh", "```"…) → once. */
function collapseLineCycles(lines: string[]): string[] {
  const key = (l: string) => l.trim().toLowerCase()
  const res: string[] = []
  let i = 0
  while (i < lines.length) {
    let jumped = false
    for (let p = 2; p <= 6 && i + 3 * p <= lines.length; p++) {
      let k = 1
      const sameBlock = (a: number, b: number) => {
        for (let j = 0; j < p; j++) if (key(lines[a + j]) !== key(lines[b + j])) return false
        return true
      }
      while (i + (k + 1) * p <= lines.length && sameBlock(i, i + k * p)) k++
      if (k >= 3 && lines.slice(i, i + p).some((l) => l.trim())) {
        res.push(...lines.slice(i, i + p))
        i += k * p
        jumped = true
        break
      }
    }
    if (!jumped) res.push(lines[i++])
  }
  return res
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

const FENCE = /```[a-zA-Z]*[ \t]*\n?([\s\S]*?)\n?```/

/**
 * Remove packaging that models wrap around their answer: Markdown code
 * fences (```markdown … ```), chat-template tokens (<|im_end|>, </s>) and a
 * stray leading "markdown" label. When the reply contains a fenced block,
 * the first block is the answer – anything after it is usually a loop.
 */
export function unwrapModelOutput(raw: string): string {
  let s = raw.replace(/<\|[^|>]{1,40}\|>|<\/?s>/g, '')
  const fenced = FENCE.exec(s)
  if (fenced && fenced[1].trim()) s = fenced[1]
  s = s.replace(/```[a-zA-Z]*/g, '')
  s = s.replace(/^\s*(markdown|md|text)\s*\n/i, '')
  return s.trim()
}

/** Clean up what an OCR model returned for ONE handwritten line. */
export function cleanOcrLine(raw: string): string {
  const one = unwrapModelOutput(raw)
    .replace(/^\s*(markdown|md|text)\b\s*/i, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
  return collapseRepeats(cleanTranscript(one)).replace(/^["“](.*)["”]$/, '$1').trim()
}

/** Clean up a multi-line reply (whole page, or the clean-up pass). */
export function cleanOcrText(raw: string): string {
  return collapseRepeats(cleanTranscript(unwrapModelOutput(raw)))
}

/**
 * Commentary that vision models add around a transcription ("The image
 * contains a single word "Me". It is written in a simple handwritten
 * style…"). Each pattern matches one such sentence, up to its full stop.
 */
const COMMENTARY: RegExp[] = [
  /\b(?:the|this) (?:image|picture|photo(?:graph)?|drawing|screenshot|sketch) (?:contains|shows|depicts|features|displays|has|is of|consists of|appears to (?:show|contain|be))\b[^.!?\n]*[.!?]?/gi,
  /\b(?:it|the (?:text|word|words|writing|handwriting))(?: is| are| appears to be| seems to be)? (?:written|centered|centred|located|positioned|placed|drawn|aligned) (?:in|on|at|with|near|towards?)\b[^.!?\n]*[.!?]?/gi,
  /\b(?:the )?(?:handwriting|writing|text) (?:is|appears|seems) (?:neat|clear|legible|simple|cursive|messy|bold|large|small|readable)\b[^.!?\n]*[.!?]?/gi,
  /\bthere (?:are|is) no (?:other )?(?:visible )?(?:text|elements?|content|objects?|words?|distractions?|markings?)\b[^.!?\n]*[.!?]?/gi,
  /\bno other (?:visible )?(?:text|elements?|content|words?) (?:is|are) (?:present|visible)\b[^.!?\n]*[.!?]?/gi,
  /^\s*(?:here(?:'s| is) (?:the|a) (?:transcription|text|transcribed text)[^:\n]*:|(?:the )?transcription(?: is)?:|sure[,!][^:\n]*:)\s*/gim,
]

/**
 * Remove LaTeX packaging some models put around plain words: $$Me$$,
 * \(Me\), \[Me\], \text{Me}, and $Me$ (but not prices like "$5 and $10").
 */
export function stripMath(s: string): string {
  return s
    .replace(/\\(?:text|mathrm|textbf|mathbf|textit)\{([^{}]*)\}/g, '$1')
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, '$1')
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, '$1')
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, '$1')
    .replace(/\$(?=[^\s\d$])([^$\n]{1,80}?)(?<=\S)\$/g, '$1')
}

/** Strip model commentary and math wrappers; report whether anything was removed. */
export function stripCommentary(text: string): { text: string; changed: boolean } {
  let s = stripMath(text)
  for (const re of COMMENTARY) s = s.replace(re, ' ')
  s = s
    .split('\n')
    .map((l) => l.replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: s, changed: s !== text.trim() }
}

/** A line made of one phrase repeated ("Me Me Me", "to do to do") → the phrase. */
function collapseWholeLineRepeat(line: string): string {
  const indent = /^\s*/.exec(line)![0]
  const words = line.trim().split(/\s+/).filter(Boolean)
  for (let p = 1; p <= words.length / 2; p++) {
    if (words.length % p) continue
    let ok = true
    for (let i = p; i < words.length && ok; i += p) ok = same(words, 0, i, p)
    if (ok) return indent + words.slice(0, p).join(' ')
  }
  return line
}

/**
 * Remove what is not part of the transcription. When the reply had
 * commentary or LaTeX in it, the model was rambling, and a word repeated
 * across the ramble ("Me … $$Me$$ … $$Me$$") is kept once.
 */
export function cleanTranscript(text: string): string {
  const { text: s, changed } = stripCommentary(text)
  if (!changed) return s
  const lines = s.split('\n').map(collapseWholeLineRepeat)
  // the same line again, anywhere (the ramble repeats itself)
  const seen = new Set<string>()
  return lines
    .filter((l) => {
      const k = l.trim().toLowerCase()
      if (!k) return true
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
