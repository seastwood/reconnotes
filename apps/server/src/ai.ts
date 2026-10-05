import { Resvg } from '@resvg/resvg-js'
import { DRAWING_WIDTH, drawingToSvg, linesToMarkdown, segmentLines, unionBounds, type Stroke } from '@reconnotes/core'
import type { Config } from './config'
import { EmptyReplyError, readingMode, type AgentConfig, type AgentRegistry, type Backend, type Part } from './agents'
import { log } from './log'
import { fitForAi, pictureLines, type PictureLine } from './images'
import { cleanOcrLine, cleanOcrText, cleanTranscript, collapseRepeats, unwrapModelOutput } from './text'
import { createHash } from 'node:crypto'
export { stripThinking } from './agents'

const IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const isAiImage = (mime: string) => IMAGE_MIMES.has(mime)


/**
 * Render a drawing to PNG, cropped to the ink. Returns null for an empty drawing.
 */
export function renderDrawingPng(allStrokes: Stroke[]): Buffer | null {
  const strokes = allStrokes.filter((s) => s.tool !== 'highlighter')
  const b = unionBounds(strokes)
  if (!b) return null
  const pad = 20
  const x = Math.max(0, b.x - pad)
  const y = Math.max(0, b.y - pad)
  const w = Math.min(DRAWING_WIDTH, b.x + b.w + pad) - x
  const h = b.y + b.h + pad - y
  const shifted = strokes.map((s) => ({
    ...s,
    pts: s.pts.map((v, i) => (i % 3 === 0 ? v - x : i % 3 === 1 ? v - y : v)),
  }))
  // Scale so the longest side is ~1500px: plenty for recognition, small upload.
  const scale = Math.min(3, 1500 / Math.max(w, h))
  const svg = drawingToSvg(shifted, w, h, scale, { recognition: true })
  return new Resvg(svg, { background: '#ffffff' }).render().asPng()
}

const HANDWRITING_PROMPT = `Transcribe the handwriting in this image.

- Preserve the writer's words exactly; fix only obvious letter-recognition ambiguity.
- Use Markdown for structure the writer clearly intended: headings for underlined or boxed titles, "- " for bullets, "- [ ]" / "- [x]" for checkboxes, numbered lists, and tables.
- If a word is illegible write [illegible].
- Output ONLY the transcribed text. Do not describe the image, the handwriting style or the layout, do not explain, do not use LaTeX or $ signs, and do not repeat yourself.`

/** The word HELLO in simple handwritten strokes, for testing an agent. */
export function sampleHandwritingPng(): Buffer {
  const line = (pts: [number, number][]): number[] => {
    const out: number[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[i + 1]
      const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6))
      for (let k = i ? 1 : 0; k <= n; k++) out.push(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 0.5)
    }
    return out
  }
  const ring: [number, number][] = []
  for (let a = 0; a <= 360; a += 10) ring.push([560 + 45 * Math.cos((a * Math.PI) / 180), 100 + 60 * Math.sin((a * Math.PI) / 180)])
  const paths: [number, number][][] = [
    [[40, 40], [42, 160]], [[120, 38], [118, 160]], [[42, 100], [118, 98]],
    [[170, 40], [170, 160]], [[170, 40], [240, 42]], [[170, 100], [228, 100]], [[170, 160], [242, 158]],
    [[290, 38], [292, 160], [356, 158]],
    [[400, 40], [400, 160], [466, 160]],
    ring,
  ]
  return renderDrawingPng(paths.map((p, i) => ({ id: `s${i}`, tool: 'pen' as const, color: '#000000', size: 4, pts: line(p) })))!
}

/** A minimal fallback instruction for OCR models that ignore long prompts. */
const SHORT_HANDWRITING_PROMPT = 'Transcribe the handwritten text in this image. Output only the text.'

/**
 * Dedicated OCR models are trained on a fixed task prompt and can ramble or
 * loop with a long instruction. Used when the agent has no custom prompt.
 */
function knownOcrPrompt(model: string): string | null {
  const m = model.toLowerCase()
  if (m.includes('glm-ocr')) return 'Text Recognition:'
  if (m.includes('deepseek-ocr')) return 'Free OCR.'
  return null
}

/** For photos and screenshots, which may mix handwriting with printed text. */
const PHOTO_PROMPT = `Transcribe all the text in this image – handwritten and printed – such as a photo of a notebook page, a whiteboard, a sticky note or a screenshot.

- Preserve the words exactly; fix only obvious letter-recognition ambiguity.
- Use Markdown for structure that is clearly intended: headings for titles, "- " for bullets, "- [ ]" / "- [x]" for checkboxes, numbered lists, and tables.
- Ignore the background (paper texture, lines, shadows, the desk) and anything cut off at the edges.
- If a word is illegible write [illegible].
- Output ONLY the transcribed text. Do not describe the image, do not explain, and do not use LaTeX or $ signs.`

const SHORT_PHOTO_PROMPT = 'Transcribe all the text in this image. Output only the text.'

/** One line of a drawing, for line-by-line recognition. */
const LINE_PROMPT = 'Transcribe the handwritten text in this image. It is a single line of handwriting: output only that line as plain text – no description of the image, no explanation, no LaTeX, no quotes.'

/** One-tap note actions (⋯ menu). */
const NOTE_ACTION_PROMPTS = {
  summary: `Summarise the note below in 2 to 6 short bullet points: the key points, decisions and outcomes. Lines starting with ✍️ are handwriting, 📷 text from pictures and 🎙️ recordings – use them too.

- Write in the same language as the note.
- Output only the bullet points as Markdown ("- …"), with no heading, preamble or closing remark.

Note:
`,
  todos: `List every action item in the note below – tasks, things someone has to do, follow-ups, deadlines. Lines starting with ✍️ are handwriting, 📷 text from pictures and 🎙️ recordings – use them too.

- One Markdown checkbox per item: "- [ ] …". Keep names and dates that are mentioned. Leave out items already marked done ([x]).
- Write in the same language as the note.
- If there are no action items, output exactly: NONE
- Output only the checklist, with no heading, preamble or closing remark.

Note:
`,
  clean: `Improve the wording of the text below: fix spelling, grammar and punctuation and make awkward sentences clear and concise.

- Keep the meaning, every fact, name and number, and the writer's voice; don't add anything.
- Keep the structure exactly: headings, lists, checkboxes ("- [ ]" / "- [x]"), line breaks between items.
- Write in the same language as the text.
- Output only the improved Markdown.

Text:
`,
} as const
export type NoteAction = keyof typeof NOTE_ACTION_PROMPTS

/** Second pass: tidy OCR output into well-structured Markdown. */
const FORMAT_PROMPT = `Below is text that an OCR model recognised from handwritten notes{IMAGE}. Clean it up:

- Fix obvious recognition mistakes (misread letters, words split or run together) using {SOURCE} and the context – but keep the writer's own words; don't reword, summarise or add anything.
- Join fragments that belong on one line; keep genuinely separate lines and items separate.
- Keep and improve the structure: a title/heading if the first line is one, bullet lists with the same nesting, "- [ ]" / "- [x]" checkboxes, numbered lists, tables.
- Output only the cleaned-up Markdown: no comments about the text or image, no LaTeX.

Recognised text:
`

const IMAGE_TEXT_PROMPT = `This image was attached to a personal note. Produce text that will make it findable by search:

1. Transcribe all legible text in the image (signs, screenshots, documents, whiteboards, handwriting, chart labels and values).
2. Then add one line starting with "Description:" summarising what the image shows (objects, people, place, chart type and what it measures).

Output only that text, with no preamble.`

const COMPILE_PROMPT = `You will receive a personal note made of typed text, images of handwritten sections and attached pictures such as photos of paper notes or screenshots (in reading order). Compile it into one clean, well-structured Markdown document.

- Keep all information: every fact, number, name, task and idea from both the typed and handwritten parts.
- Transcribe handwriting faithfully and merge it into the right place in the flow, including text written or printed in attached pictures.
- Organise with headings, bullet lists, checklists ("- [ ]" / "- [x]") and tables where it helps; fix spelling and obvious grammar slips.
- Describe diagrams or sketches briefly in square brackets.
- Do not add facts, commentary or a preamble. Output only the Markdown document.`

/**
 * The AI features, each run through the configured agents for that task with
 * failover (see agents.ts).
 */
export class Ai {
  constructor(
    readonly agents: AgentRegistry,
    private config: Config,
  ) {}

  get canHandwriting() {
    return this.agents.available('handwriting')
  }
  get canImages() {
    return this.agents.available('images')
  }
  get canPdf() {
    return this.agents.available('pdf')
  }
  get canCompile() {
    return this.agents.available('compile')
  }
  get canAudio() {
    return this.agents.available('audio')
  }
  get autoAudio() {
    return this.agents.settings().autoAudio && this.canAudio
  }
  get enabled() {
    return this.canHandwriting || this.canImages || this.canPdf || this.canCompile || this.canAudio
  }

  /**
   * Summarise / extract to-dos from a note, or clean up the wording of some
   * text. Uses the "Compile notes" agents (general models); clean-up prefers
   * the "Clean up converted text" agents when there are any.
   */
  async noteAction(action: NoteAction, markdown: string): Promise<{ text: string; agent: string }> {
    const task = action === 'clean' && this.agents.available('format') ? 'format' : 'compile'
    const limit = action === 'clean' ? Math.min(8192, Math.ceil(markdown.length / 2) + 512) : 1500
    const { result, agent } = await this.agents.run(task, async (backend) => {
      const raw = await backend.generate([{ text: NOTE_ACTION_PROMPTS[action] + markdown.slice(0, 60_000) }], limit)
      return collapseRepeats(unwrapModelOutput(raw)).trim()
    })
    log.info(`note action "${action}" via "${agent.name}" (${markdown.length} → ${result.length} chars)`)
    return { text: /^NONE\.?$/i.test(result) ? '' : result, agent: agent.name }
  }

  /** Recording or audio file → text, with the "Audio to text" agents (failover as usual). */
  async transcribeAudio(data: Buffer, mime: string, filename: string): Promise<{ text: string; agent: string }> {
    const { result, agent } = await this.agents.run('audio', async (backend, agent) => {
      if (!backend.transcribe)
        throw new Error(`${agent.name} can't transcribe audio – use a Wyoming (Home Assistant) or OpenAI-compatible speech-to-text server, e.g. Whisper`)
      const text = collapseRepeats(await backend.transcribe(data, mime, filename))
      return text
    })
    log.info(`transcribed ${Math.round(data.length / 1024)} KB of audio via "${agent.name}" (${result.length} chars)`)
    return { text: result, agent: agent.name }
  }
  get autoHandwriting() {
    return this.agents.settings().autoHandwriting && this.canHandwriting
  }
  get autoImageText() {
    return this.agents.settings().autoImageText
  }

  describe(): string {
    return this.agents.describe()
  }

  /**
   * Handwriting → Markdown. With `requireText` (an explicit "Convert to
   * text"), an agent that returns nothing counts as a failure, so the next
   * agent gets a try and the error explains what happened.
   */
  async transcribeHandwriting(png: Buffer, opts: { requireText?: boolean } = {}): Promise<{ text: string; agent: string }> {
    const { result, agent } = await this.agents.run('handwriting', (backend, agent) => this.transcribeWith(backend, agent, png, opts))
    return { text: result, agent: agent.name }
  }

  /** Transcribe with one specific agent (used by the chain above and by "Test reading handwriting"). */
  async transcribeWith(
    backend: Backend,
    agent: AgentConfig,
    png: Buffer,
    opts: { requireText?: boolean; mime?: string; photo?: boolean; line?: boolean } = {},
  ): Promise<string> {
    // Try the agent's own prompt (or the detailed built-in one); if the model
    // returns nothing, try once more with a minimal instruction, which many
    // OCR models handle better.
    const prompts = [
      ...new Set([
        agent.prompt.trim() ||
          knownOcrPrompt(agent.model) ||
          (opts.photo ? PHOTO_PROMPT : opts.line ? LINE_PROMPT : HANDWRITING_PROMPT),
        opts.photo ? SHORT_PHOTO_PROMPT : SHORT_HANDWRITING_PROMPT,
      ]),
    ]
    // A single line can't need many tokens; a low cap also stops runaway loops quickly.
    const maxTokens = opts.line ? 200 : 4096
    const empties: string[] = []
    for (const [i, prompt] of prompts.entries()) {
      try {
        const raw = await backend.generate([{ image: png, mime: opts.mime ?? 'image/png' }, { text: prompt }], maxTokens)
        const text = opts.line ? cleanOcrLine(raw) : cleanOcrText(raw)
        if (text.length < raw.length) log.info(`"${agent.name}" repeated itself; collapsed ${raw.length} → ${text.length} chars`)
        log.info(`handwriting via "${agent.name}" (prompt ${i + 1}): ${text.length} chars – ${JSON.stringify(text.slice(0, 120))}`)
        if (text.trim()) return text
        empties.push(`prompt ${i + 1}: empty reply`)
      } catch (err) {
        if (!(err instanceof EmptyReplyError)) throw err
        empties.push(prompts.length > 1 ? `prompt ${i + 1}: ${err.details}` : err.details)
      }
    }
    if (!opts.requireText) return ''
    throw new Error(`returned no text (${empties.join(' | ')})`)
  }

  /**
   * A photo or screenshot (e.g. of handwritten notes) → Markdown, using the
   * handwriting agents in priority order, then the clean-up agents.
   */
  async transcribePhoto(data: Buffer, mime: string, opts: { format?: boolean } = {}): Promise<{ text: string; agent: string }> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const fit = fitForAi(data, mime)
    // Find the written lines once (only needed for line-by-line agents).
    let lines: PictureLine[] | null | undefined
    const { result, agent } = await this.agents.run('handwriting', async (backend, agent) => {
      if (readingMode(agent) === 'lines') {
        if (lines === undefined) lines = pictureLines(data, mime)
        if (lines) {
          const md = await this.readLines(backend, agent, lines)
          if (md !== null) return md
          log.info(`"${agent.name}": most lines came back empty – reading the picture as a whole instead`)
        }
      }
      return this.transcribeWith(backend, agent, fit.data, { requireText: true, mime: fit.mime, photo: true })
    })
    const text = opts.format === false ? result : await this.tidy(result, fit.data, fit.mime)
    return { text, agent: agent.name }
  }

  /**
   * Read the lines found in a picture one at a time and rebuild the
   * structure. Returns null when the picture doesn't seem to be lines of
   * text after all (most lines empty), so the caller can read it whole.
   */
  private async readLines(backend: Backend, agent: AgentConfig, lines: PictureLine[]): Promise<string | null> {
    const texts: string[] = []
    for (const line of lines) {
      const key = `v2|${agent.id}|${agent.model}|${agent.prompt}|${createHash('sha1').update(line.png).digest('hex')}`
      let text = this.lineCache.get(key)
      if (text === undefined) {
        text = await this.transcribeWith(backend, agent, line.png, { line: true })
        this.lineCache.set(key, text)
        if (this.lineCache.size > 5000) this.lineCache.delete(this.lineCache.keys().next().value!)
      }
      texts.push(text)
    }
    const filled = texts.filter((t) => t).length
    if (filled < Math.max(1, lines.length * 0.4)) return null
    const md = linesToMarkdown(lines, texts)
    log.info(`picture via "${agent.name}" line by line: ${lines.length} lines, ${md.length} chars`)
    return md
  }

  /** Recent line results, so unchanged lines aren't re-read every time a drawing changes. */
  private lineCache = new Map<string, string>()

  /**
   * Handwritten drawing → Markdown. Agents set to read "line by line" get
   * each text line separately and the structure (bullets, indentation) is
   * rebuilt from the stroke layout; "whole page" agents get one image.
   * With `format`, the result is then tidied by the clean-up agents.
   */
  async transcribeDrawing(
    strokes: Stroke[],
    opts: { requireText?: boolean; format?: boolean } = {},
  ): Promise<{ text: string; agent: string | null }> {
    const page = renderDrawingPng(strokes)
    if (!page) return { text: '', agent: null }
    const lines = segmentLines(strokes)
    const { result, agent } = await this.agents.run('handwriting', async (backend, agent) => {
      if (readingMode(agent) === 'page' || lines.length < 2) return this.transcribeWith(backend, agent, page, opts)
      const texts: string[] = []
      for (const line of lines) {
        const key = `v2|${agent.id}|${agent.model}|${agent.prompt}|${line.strokes.map((s) => s.id).join(',')}`
        let text = this.lineCache.get(key)
        if (text === undefined) {
          const png = renderDrawingPng(line.strokes)
          text = png ? await this.transcribeWith(backend, agent, png, { line: true }) : ''
          this.lineCache.set(key, text)
          if (this.lineCache.size > 5000) this.lineCache.delete(this.lineCache.keys().next().value!)
        }
        texts.push(text)
      }
      const md = linesToMarkdown(lines, texts)
      log.info(`handwriting via "${agent.name}" line by line: ${lines.length} lines, ${md.length} chars`)
      if (opts.requireText && !md.trim()) throw new Error(`returned no text for any of the ${lines.length} lines`)
      return md
    })
    const text = opts.format && result.trim() ? await this.tidy(result, page, 'image/png') : result
    return { text, agent: agent.name }
  }

  /**
   * Optional clean-up pass with the "Clean up converted text" agents. Never
   * fails the conversion: if no agent is set up or all fail, the recognised
   * text is returned as is.
   */
  async tidy(text: string, image: Buffer | null, mime: string): Promise<string> {
    if (!this.agents.available('format') || !text.trim()) return text
    try {
      const { result, agent } = await this.agents.run('format', (backend, agent) => {
        const prompt =
          FORMAT_PROMPT.replace('{IMAGE}', agent.vision && image ? ' (the original image is attached)' : '').replace(
            '{SOURCE}',
            agent.vision && image ? 'the image' : 'common sense',
          ) + text
        // The tidied text should be about as long as the input; leave some room for Markdown.
        const limit = Math.min(8192, Math.ceil(text.length / 2) + 512)
        return backend.generate(agent.vision && image ? [{ image, mime }, { text: prompt }] : [{ text: prompt }], limit)
      })
      const raw = unwrapModelOutput(result)
      const tidied = collapseRepeats(cleanTranscript(raw))
      log.info(`cleaned up converted text via "${agent.name}" (${text.length} → ${raw.length} chars)`)
      // Reject clean-ups that wander off: much longer than the input (before
      // or after collapsing repeats) means the model looped or invented text.
      if (!tidied.trim() || raw.length > text.length * 2 + 200 || tidied.length < raw.length * 0.7) {
        log.warn(`clean-up by "${agent.name}" rejected (${text.length} → ${tidied.length} chars); keeping the recognised text`)
        return text
      }
      return tidied
    } catch (err) {
      log.warn(`clean-up skipped: ${(err as Error).message}`)
      return text
    }
  }

  /** Image → searchable text (OCR + short description). */
  async imageText(data: Buffer, mime: string): Promise<string> {
    if (!isAiImage(mime)) throw new Error(`unsupported image type ${mime}`)
    const fit = fitForAi(data, mime)
    const { result } = await this.agents.run('images', (backend) =>
      backend.generate([{ image: fit.data, mime: fit.mime }, { text: IMAGE_TEXT_PROMPT }], 4000),
    )
    return result
  }

  /** PDF → text for search. */
  async pdfText(data: Buffer): Promise<string> {
    const { result } = await this.agents.run('pdf', (backend) =>
      backend.generate(
        [
          { pdf: data },
          {
            text: 'Extract the full text of this document for a search index, including text in tables, charts and figures. Output only the text.',
          },
        ],
        32000,
      ),
    )
    return result
  }

  /**
   * Compile a note into a clean document. `parts` is the note in reading
   * order: typed Markdown and rendered handwriting images interleaved.
   */
  async compile(parts: CompilePart[]): Promise<string> {
    // For agents that can't read images, transcribe drawings and pictures
    // first (once, even if we fail over between several such agents).
    let transcribed: Promise<string> | null = null
    const asText = () =>
      (transcribed ??= (async () => {
        let text = ''
        for (const p of parts) {
          if ('text' in p) text += p.text
          else if (p.kind === 'drawing')
            text += '\n[handwritten section]\n' + (await this.transcribeDrawing(p.strokes)).text + '\n[end handwritten section]\n'
          else {
            const t = await this.transcribePhoto(p.image, p.mime, { format: false }).then((r) => r.text, () => '(could not be read)')
            text += '\n[picture, transcribed]\n' + t + '\n[end picture]\n'
          }
        }
        return text
      })())

    const { result } = await this.agents.run('compile', async (backend, agent) => {
      const input: Part[] = []
      if (agent.vision) {
        for (const p of parts) {
          if ('text' in p) {
            if (p.text.trim()) input.push({ text: p.text })
          } else if (p.kind === 'drawing') input.push({ image: p.image, mime: p.mime })
          else {
            const fit = fitForAi(p.image, p.mime)
            input.push({ text: '[picture attached to the note:]' }, { image: fit.data, mime: fit.mime })
          }
        }
      } else input.push({ text: await asText() })
      input.push({ text: COMPILE_PROMPT })
      return backend.generate(input, 32000)
    })
    return result
  }
}

/** The note in reading order: text, drawings (rendered) and pictures. */
export type CompilePart =
  | { text: string }
  | { image: Buffer; mime: string; kind: 'drawing'; strokes: Stroke[] }
  | { image: Buffer; mime: string; kind: 'photo' }
